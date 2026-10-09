import { MediaKind } from "@emptrack/shared";
import { apiClient, ApiError } from "./api";
import { diag, diagState } from "./diag";

/**
 * Media upload pipeline for screenshots and screen recordings.
 *
 * Captures happen on a timer regardless of whether the network is up, so a
 * naive "await the upload" would either block the capture loop or silently
 * lose media during an outage. Instead every capture is handed to a bounded,
 * self-draining queue that:
 *
 *   - keeps working offline and drains automatically when the link returns
 *     (retry with exponential backoff, on top of the transport-level retries
 *     in api.ts);
 *   - applies backpressure — the queue is capped by item count and by total
 *     bytes, and sheds the oldest, least-valuable items first rather than
 *     growing without bound;
 *   - uploads large media (recording chunks) as a streamed, chunked PUT so a
 *     multi-megabyte buffer is never held twice in memory.
 *
 * The queue runs in the Electron main process and is a singleton shared by the
 * screenshotter and the recorder.
 */

/** Upload bodies at/above this size are streamed in chunks instead of PUT whole. */
const CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024;
/** Size of each streamed chunk. */
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

export interface MediaQueueOptions {
  /** Hard cap on queued items. Oldest are shed past this. */
  maxItems: number;
  /** Hard cap on total queued bytes. Oldest are shed past this. */
  maxBytes: number;
  /** How many uploads may be in flight at once. */
  maxConcurrent: number;
  /** How many times one item is retried before it is dropped. */
  maxAttempts: number;
}

const DEFAULT_OPTIONS: MediaQueueOptions = {
  maxItems: 500,
  maxBytes: 256 * 1024 * 1024,
  maxConcurrent: 2,
  maxAttempts: 6,
};

interface QueueItem {
  kind: MediaKind;
  contentType: string;
  bytes: Buffer;
  durationSeconds?: number;
  capturedAt: string;
  attempts: number;
}

export interface MediaQueueStats {
  pending: number;
  inFlight: number;
  queuedBytes: number;
  dropped: number;
}

/** Build a one-shot chunked stream over a buffer without copying it. */
function chunkedStream(buf: Buffer, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= buf.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, buf.byteLength);
      controller.enqueue(buf.subarray(offset, end));
      offset = end;
    },
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MediaUploadQueue {
  private items: QueueItem[] = [];
  private inFlight = 0;
  private dropped = 0;
  private draining = false;
  private readonly opts: MediaQueueOptions;

  constructor(opts: Partial<MediaQueueOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  get stats(): MediaQueueStats {
    return {
      pending: this.items.length,
      inFlight: this.inFlight,
      queuedBytes: this.items.reduce((n, it) => n + it.bytes.byteLength, 0),
      dropped: this.dropped,
    };
  }

  /** Accept one captured media object and schedule it for upload. */
  enqueue(item: Omit<QueueItem, "attempts">): void {
    this.items.push({ ...item, attempts: 0 });
    this.shed();
    void this.drain();
  }

  /**
   * Enforce the count/byte caps (backpressure). Screenshots are shed before
   * recordings — recordings are rarer and costlier to recreate — and within a
   * class the oldest go first.
   */
  private shed(): void {
    const overCount = () => this.items.length > this.opts.maxItems;
    const overBytes = () =>
      this.items.reduce((n, it) => n + it.bytes.byteLength, 0) > this.opts.maxBytes;

    const dropOldest = (preferKind?: MediaKind) => {
      const idx = preferKind ? this.items.findIndex((it) => it.kind === preferKind) : 0;
      const target = idx >= 0 ? idx : 0;
      this.items.splice(target, 1);
      this.dropped++;
    };

    while (overCount() || overBytes()) {
      if (this.items.length === 0) break;
      // Prefer shedding the oldest screenshot; fall back to the oldest item.
      const hasScreenshot = this.items.some((it) => it.kind === "SCREENSHOT");
      dropOldest(hasScreenshot ? "SCREENSHOT" : undefined);
    }
  }

  /** Pump the queue up to the concurrency limit. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length > 0 && this.inFlight < this.opts.maxConcurrent) {
        const item = this.items.shift()!;
        this.inFlight++;
        void this.process(item).finally(() => {
          this.inFlight--;
          // A slot freed up — keep draining.
          void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async process(item: QueueItem): Promise<void> {
    try {
      await this.upload(item);
      diagState("upload", "upload", "uploading OK");
    } catch (err) {
      item.attempts++;
      diagState("upload", "upload", `upload failing: ${(err as Error).message}`);
      const permanent = err instanceof ApiError && !err.retryable;
      if (permanent || item.attempts >= this.opts.maxAttempts) {
        this.dropped++;
        diag("upload", `dropping ${item.kind} after ${item.attempts} attempt(s): ${(err as Error).message}`);
        return;
      }
      // Back off, then put it back at the head so order is roughly preserved.
      const delay = Math.min(1000 * 2 ** item.attempts, 60_000);
      await sleep(Math.round(Math.random() * delay));
      this.items.unshift(item);
      this.shed();
      void this.drain();
    }
  }

  /** Presign → PUT bytes (chunked when large) → confirm. */
  private async upload(item: QueueItem): Promise<void> {
    const { mediaId, uploadUrl, requiredHeaders } = await apiClient.requestMediaUpload({
      kind: item.kind,
      contentType: item.contentType,
      capturedAt: item.capturedAt,
      durationSeconds: item.durationSeconds,
    });

    if (item.bytes.byteLength >= CHUNK_THRESHOLD_BYTES) {
      await apiClient.putBytes(uploadUrl, requiredHeaders, chunkedStream(item.bytes, CHUNK_SIZE_BYTES), {
        contentLength: item.bytes.byteLength,
      });
    } else {
      await apiClient.putBytes(uploadUrl, requiredHeaders, item.bytes, {
        contentLength: item.bytes.byteLength,
      });
    }

    await apiClient.confirmMedia(mediaId, item.bytes.byteLength);
  }
}

/** Process-wide queue shared by the screenshotter and recorder. */
export const mediaQueue = new MediaUploadQueue();

/**
 * Shared media upload entry point used by the screenshot and recorder modules.
 * Enqueues the capture and returns as soon as it is accepted — the actual
 * network work (presign, upload, confirm, retries) happens in the background
 * queue, so callers never block their capture loop on a slow or absent link.
 */
export async function uploadMedia(
  kind: MediaKind,
  contentType: string,
  bytes: Buffer,
  durationSeconds?: number
): Promise<void> {
  mediaQueue.enqueue({
    kind,
    contentType,
    bytes,
    durationSeconds,
    capturedAt: new Date().toISOString(),
  });
}
