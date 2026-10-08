import {
  ActivityEvent,
  DeviceConfigResponse,
  EnrollDeviceInput,
  MediaUploadRequest,
  MediaUploadResponse,
} from "@emptrack/shared";
import { config } from "./config";

/**
 * Backend API client for the desktop agent.
 *
 * Everything the agent sends to the server goes through here: device-token
 * auth, policy fetch, activity batches and presigned media-upload URLs. The
 * transport is deliberately defensive — flaky Wi-Fi, laptops that sleep
 * mid-request and short server blips are the normal case for a monitoring
 * agent, so every call has a timeout and retries transient failures with
 * exponential backoff instead of surfacing them to the caller.
 */

/** Per-request network timeout. Media PUTs get a longer budget (see putBytes). */
const REQUEST_TIMEOUT_MS = 20_000;
/** How many total attempts (first try + retries) a retryable call gets. */
const MAX_ATTEMPTS = 4;
/** Backoff schedule: BASE * 2^n, jittered, capped at MAX. */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;
/** The activity contract (activityBatchSchema) caps a batch at 500 events; we split larger buffers. */
const ACTIVITY_BATCH_LIMIT = 500;

/**
 * A failed API call carries enough context for callers (and the upload queue)
 * to decide whether retrying is pointless. `retryable` is true for network
 * errors, timeouts and transient server statuses; false for auth and other
 * 4xx responses that will never succeed on their own.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly body?: string
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 401/403 — the device token is missing, expired or revoked. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A status we expect to clear on its own: rate limit, timeout, 5xx. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Exponential backoff with full jitter, so many devices don't retry in lockstep. */
function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_DELAY_MS);
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.round(Math.random() * ceiling);
}

/** Parse a Retry-After header (seconds, or an HTTP date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

/** fetch + an AbortController timeout that always clears its timer. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface RequestOptions extends RequestInit {
  /** Attach the device bearer token. */
  auth?: boolean;
  /** Override the default per-attempt timeout. */
  timeoutMs?: number;
  /** Override the default retry budget. */
  maxAttempts?: number;
}

/**
 * Core JSON request with timeout + retry. Resolves with the parsed body on
 * success and throws a typed {@link ApiError} once retries are exhausted or
 * the failure is permanent.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { auth, timeoutMs = REQUEST_TIMEOUT_MS, maxAttempts = MAX_ATTEMPTS, ...init } = options;
  const url = `${config.serverUrl}${path}`;
  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    // Read the token fresh each attempt — it can change after a re-enroll.
    if (auth && config.deviceToken) headers.Authorization = `Bearer ${config.deviceToken}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs);
    } catch (err) {
      // Network error or abort (timeout) — always worth retrying.
      const aborted = err instanceof Error && err.name === "AbortError";
      lastError = new ApiError(
        `${path} ${aborted ? "timed out" : "network error"}: ${(err as Error).message}`,
        null,
        true
      );
      if (attempt < maxAttempts - 1) await sleep(backoffDelay(attempt));
      continue;
    }

    if (res.ok) {
      // 204 / empty body is a valid success for some endpoints.
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    const body = await res.text().catch(() => "");
    const retryable = isRetryableStatus(res.status);
    lastError = new ApiError(`${path} failed: ${res.status} ${body}`, res.status, retryable, body);
    if (!retryable || attempt === maxAttempts - 1) throw lastError;

    await sleep(backoffDelay(attempt, parseRetryAfter(res.headers.get("retry-after"))));
  }

  throw lastError ?? new ApiError(`${path} failed: exhausted retries`, null, true);
}

export const apiClient = {
  /** Exchange an enrollment token for a durable per-device bearer token. */
  async enroll(input: EnrollDeviceInput) {
    return request<{ deviceId: string; tenantId: string; token: string }>("/api/agent/enroll", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  /** Pull the current monitoring policy for this device. */
  async fetchConfig() {
    return request<DeviceConfigResponse>("/api/agent/config", { method: "GET", auth: true });
  },

  /**
   * Submit a batch of activity events. The server is idempotent on
   * `clientEventId`, so retries never double-count. Buffers larger than the
   * contract's per-request cap are split transparently.
   */
  async sendActivity(events: ActivityEvent[]): Promise<{ accepted: number }> {
    if (events.length === 0) return { accepted: 0 };

    let accepted = 0;
    for (let i = 0; i < events.length; i += ACTIVITY_BATCH_LIMIT) {
      const slice = events.slice(i, i + ACTIVITY_BATCH_LIMIT);
      const res = await request<{ accepted: number }>("/api/agent/activity", {
        method: "POST",
        auth: true,
        body: JSON.stringify({ events: slice }),
      });
      accepted += res?.accepted ?? slice.length;
    }
    return { accepted };
  },

  /** Ask the server for a presigned URL to upload one media object. */
  async requestMediaUpload(req: MediaUploadRequest) {
    return request<MediaUploadResponse>("/api/agent/media/upload-url", {
      method: "POST",
      auth: true,
      body: JSON.stringify(req),
    });
  },

  /** Tell the server the bytes landed in storage so it can finalise the record. */
  async confirmMedia(mediaId: string, sizeBytes: number) {
    return request<{ ok: boolean }>(`/api/agent/media/${mediaId}/confirm`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ sizeBytes }),
    });
  },

  /**
   * Direct PUT of media bytes to the presigned storage URL. This bypasses the
   * JSON API (no auth header, no base URL) and talks straight to object
   * storage, so it has its own timeout/retry handling here. `body` may be a
   * Buffer/Blob or a streaming {@link ReadableStream} for chunked uploads; a
   * known `contentLength` is sent explicitly because streamed bodies don't set
   * it automatically and signed URLs expect it.
   */
  async putBytes(
    url: string,
    headers: Record<string, string>,
    body: Buffer | Blob | ReadableStream<Uint8Array>,
    opts: { contentLength?: number; timeoutMs?: number } = {}
  ): Promise<void> {
    const isStream = typeof (body as ReadableStream<Uint8Array>).getReader === "function";
    const timeoutMs = opts.timeoutMs ?? 90_000; // media is large; allow more time
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const reqHeaders: Record<string, string> = { ...headers };
      if (opts.contentLength != null) reqHeaders["Content-Length"] = String(opts.contentLength);

      const init: RequestInit & { duplex?: "half" } = {
        method: "PUT",
        headers: reqHeaders,
        body: body as BodyInit,
      };
      // A streamed request body requires half-duplex mode under undici/Node.
      if (isStream) init.duplex = "half";

      let res: Response;
      try {
        res = await fetchWithTimeout(url, init, timeoutMs);
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        lastError = new ApiError(
          `media PUT ${aborted ? "timed out" : "network error"}: ${(err as Error).message}`,
          null,
          true
        );
        // A stream body can only be consumed once, so it can't be replayed.
        if (isStream) throw lastError;
        if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffDelay(attempt));
        continue;
      }

      if (res.ok) return;

      const retryable = isRetryableStatus(res.status) && !isStream;
      lastError = new ApiError(`media PUT failed: ${res.status}`, res.status, retryable);
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw lastError;
      await sleep(backoffDelay(attempt, parseRetryAfter(res.headers.get("retry-after"))));
    }

    throw lastError ?? new ApiError("media PUT failed: exhausted retries", null, true);
  },
};
