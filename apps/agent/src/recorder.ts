import path from "path";
import { BrowserWindow, desktopCapturer, ipcMain, powerMonitor, systemPreferences } from "electron";
import { DevicePolicy } from "@emptrack/shared";
import { uploadMedia } from "./uploader";

/**
 * Policy-controlled screen recording for the transparent monitoring agent.
 *
 * Recording only ever runs when tenant policy has screenRecordingEnabled true;
 * the tray icon (main.ts) always shows that state to the employee. A hidden
 * renderer window runs MediaRecorder on the captured desktop stream (the only
 * place the browser media APIs exist), restarts the recorder every
 * recordingChunkSeconds so each chunk is a standalone playable WebM, and hands
 * each finished chunk back to the main process over IPC. Chunks are queued and
 * streamed to the uploader one at a time, with retry so a flaky network does
 * not drop video.
 *
 * Recording pauses on its own when the screen locks, the machine sleeps, or the
 * clock is outside the policy's working hours, and resumes afterwards. It stops
 * cleanly on policy-off and on app quit, flushing the final partial chunk.
 */

export interface RecorderSettings {
  sourceId: string;
  chunkSeconds: number;
  fps: number;
  maxWidth: number;
  maxHeight: number;
  videoBitsPerSecond: number;
}

interface ChunkPayload {
  session: number;
  buffer: ArrayBuffer;
  startedAt: string;
  durationSeconds: number;
}

interface QueuedChunk {
  bytes: Buffer;
  durationSeconds: number;
  attempts: number;
}

// Local tuning the policy doesn't expose. Screen content at a low frame rate
// compresses well, so bitrate scales with fps from a modest base.
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const BASE_BITS_PER_SECOND = 300_000;
const BITS_PER_FPS = 60_000;

const RESTART_DELAY_MS = 15_000;
const WORKING_HOURS_CHECK_MS = 30_000;
const MAX_UPLOAD_ATTEMPTS = 5;
const MAX_QUEUED_BYTES = 500 * 1024 * 1024;

type PauseReason = "locked" | "suspended" | "off-hours";

export function settingsFromPolicy(policy: DevicePolicy, sourceId: string): RecorderSettings {
  return {
    sourceId,
    chunkSeconds: policy.recordingChunkSeconds,
    fps: policy.recordingFps,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    videoBitsPerSecond: BASE_BITS_PER_SECOND + BITS_PER_FPS * policy.recordingFps,
  };
}

/** True when `now` is inside the policy's working hours (or none are set). */
export function withinWorkingHours(policy: DevicePolicy, now = new Date()): boolean {
  const { workingHoursStart: start, workingHoursEnd: end } = policy;
  if (!start || !end) return true;
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return true;
  // Shifts crossing midnight (e.g. 22:00-06:00) wrap around.
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

export class ScreenRecorder {
  private win: BrowserWindow | null = null;
  private recording = false;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  // Bumped on every launch so chunks and signals from a torn-down renderer
  // can't be confused with the current session.
  private session = 0;
  private stoppedSignal: (() => void) | null = null;

  private readonly paused = new Set<PauseReason>();
  private hoursTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  private queue: QueuedChunk[] = [];
  private queuedBytes = 0;
  private draining = false;
  private quitting = false;

  constructor(private policy: DevicePolicy) {
    this.registerIpc();
    this.registerSystemEvents();
  }

  /** Whether policy wants recording right now, ignoring transient pauses. */
  private get wanted() {
    return this.policy.monitoringEnabled && this.policy.screenRecordingEnabled && !this.quitting;
  }

  get isRecording() {
    return this.recording;
  }

  updatePolicy(policy: DevicePolicy) {
    const prev = this.policy;
    this.policy = policy;
    this.syncWorkingHoursTimer();
    this.updateOffHours();

    const settingsChanged =
      prev.recordingChunkSeconds !== policy.recordingChunkSeconds || prev.recordingFps !== policy.recordingFps;
    if (this.recording && this.wanted && this.paused.size === 0 && settingsChanged) {
      // New chunk length / fps only take effect on a fresh MediaRecorder.
      void this.restart();
      return;
    }
    void this.reconcile();
  }

  async start() {
    this.syncWorkingHoursTimer();
    this.updateOffHours();
    await this.reconcile();
  }

  /** Stop recording and wait for the final partial chunk to be queued. */
  async stop() {
    this.clearRestartTimer();
    if (this.starting) await this.starting.catch(() => undefined);
    if (!this.win) {
      this.recording = false;
      return;
    }
    if (!this.stopping) {
      this.stopping = this.teardown().finally(() => {
        this.stopping = null;
      });
    }
    await this.stopping;
  }

  /** Stop for good on app quit: flush the last chunk and try to upload it. */
  async shutdown() {
    this.quitting = true;
    if (this.hoursTimer) clearInterval(this.hoursTimer);
    this.hoursTimer = null;
    await this.stop();
    await this.drain();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Bring the actual recorder state in line with policy + pauses. */
  private async reconcile() {
    const shouldRecord = this.wanted && this.paused.size === 0;
    if (shouldRecord && !this.recording && !this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
      await this.starting;
    } else if (!shouldRecord && (this.recording || this.win)) {
      await this.stop();
    }
  }

  private async restart() {
    await this.stop();
    await this.reconcile();
  }

  private async launch() {
    if (this.stopping) await this.stopping.catch(() => undefined);
    if (!this.wanted || this.paused.size > 0) return;

    if (process.platform === "darwin") {
      // macOS gates screen capture behind a system permission. Until it is
      // granted we'd only record a blank desktop, so don't start; asking for
      // sources surfaces the OS prompt, then we retry later.
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status !== "granted") {
        await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
        console.warn(`[recorder] screen capture permission is "${status}"; will retry`);
        this.scheduleRestart();
        return;
      }
    }

    const sourceId = await this.primarySourceId();
    if (!sourceId) {
      console.warn("[recorder] no screen source available; will retry");
      this.scheduleRestart();
      return;
    }
    if (!this.wanted || this.paused.size > 0) return;

    const settings = settingsFromPolicy(this.policy, sourceId);
    const session = ++this.session;
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "capture-preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Keep timers firing while hidden so chunks rotate on schedule.
        backgroundThrottling: false,
      },
    });
    this.win = win;
    this.recording = true;

    try {
      await win.loadFile(path.join(__dirname, "capture.html"));
    } catch (err) {
      console.warn("[recorder] failed to load capture page:", (err as Error).message);
      this.recording = false;
      this.win = null;
      if (!win.isDestroyed()) win.destroy();
      this.scheduleRestart();
      return;
    }

    if (session !== this.session || win.isDestroyed()) return;
    win.webContents.send("recorder:begin", { ...settings, session });
  }

  /** Signal the renderer to stop, wait for the final chunk, then destroy. */
  private async teardown() {
    const win = this.win;
    if (!win) {
      this.recording = false;
      return;
    }

    const flushed = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.stoppedSignal = null;
        resolve();
      };
      this.stoppedSignal = finish;
      // Don't hang teardown forever if the renderer is wedged.
      setTimeout(finish, RESTART_DELAY_MS);
    });

    if (!win.isDestroyed()) {
      try {
        win.webContents.send("recorder:stop");
      } catch {
        /* window already gone */
      }
    }
    await flushed;

    this.recording = false;
    this.win = null;
    if (!win.isDestroyed()) win.destroy();
    void this.drain();
  }

  private async primarySourceId(): Promise<string | null> {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
    return sources.length > 0 ? sources[0].id : null;
  }

  private scheduleRestart() {
    if (this.restartTimer || this.quitting) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.reconcile();
    }, RESTART_DELAY_MS);
  }

  private clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Pausing: lock / sleep / working hours
  // ---------------------------------------------------------------------------

  private registerSystemEvents() {
    const pause = (reason: PauseReason) => {
      this.paused.add(reason);
      void this.stop();
    };
    const resume = (reason: PauseReason) => {
      if (!this.paused.delete(reason)) return;
      void this.reconcile();
    };

    powerMonitor.on("lock-screen", () => pause("locked"));
    powerMonitor.on("unlock-screen", () => resume("locked"));
    powerMonitor.on("suspend", () => pause("suspended"));
    powerMonitor.on("resume", () => resume("suspended"));
  }

  private syncWorkingHoursTimer() {
    const bounded = Boolean(this.policy.workingHoursStart && this.policy.workingHoursEnd);
    if (bounded && !this.hoursTimer) {
      this.hoursTimer = setInterval(() => this.updateOffHours(), WORKING_HOURS_CHECK_MS);
    } else if (!bounded && this.hoursTimer) {
      clearInterval(this.hoursTimer);
      this.hoursTimer = null;
      this.paused.delete("off-hours");
    }
  }

  private updateOffHours() {
    const off = !withinWorkingHours(this.policy);
    const was = this.paused.has("off-hours");
    if (off === was) return;
    if (off) {
      this.paused.add("off-hours");
      void this.stop();
    } else {
      this.paused.delete("off-hours");
      void this.reconcile();
    }
  }

  // ---------------------------------------------------------------------------
  // Chunk intake + upload queue
  // ---------------------------------------------------------------------------

  private registerIpc() {
    ipcMain.removeHandler("recorder:chunk");
    ipcMain.handle("recorder:chunk", (_e, payload: ChunkPayload) => {
      // Keep chunks even from a session we've already torn down (the final
      // partial chunk arrives just after we ask the renderer to stop).
      if (payload.buffer && payload.buffer.byteLength > 0) {
        this.enqueue({
          bytes: Buffer.from(payload.buffer),
          durationSeconds: payload.durationSeconds,
          attempts: 0,
        });
      }
    });

    ipcMain.removeHandler("recorder:stopped");
    ipcMain.handle("recorder:stopped", (_e, payload: { session: number }) => {
      if (payload?.session === this.session) this.stoppedSignal?.();
    });
  }

  private enqueue(chunk: QueuedChunk) {
    // Bound memory: if uploads are badly backed up, drop the oldest chunks.
    while (this.queuedBytes + chunk.bytes.byteLength > MAX_QUEUED_BYTES && this.queue.length > 0) {
      const dropped = this.queue.shift()!;
      this.queuedBytes -= dropped.bytes.byteLength;
      console.warn("[recorder] upload queue full; dropping oldest chunk");
    }
    this.queue.push(chunk);
    this.queuedBytes += chunk.bytes.byteLength;
    void this.drain();
  }

  /** Upload queued chunks one at a time, retrying with backoff. */
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue[0];
        try {
          await uploadMedia("RECORDING", "video/webm", chunk.bytes, chunk.durationSeconds);
          this.queue.shift();
          this.queuedBytes -= chunk.bytes.byteLength;
        } catch (err) {
          chunk.attempts += 1;
          if (chunk.attempts >= MAX_UPLOAD_ATTEMPTS) {
            console.warn("[recorder] giving up on chunk after retries:", (err as Error).message);
            this.queue.shift();
            this.queuedBytes -= chunk.bytes.byteLength;
            continue;
          }
          const backoff = Math.min(1000 * 2 ** chunk.attempts, 30_000);
          console.warn(`[recorder] upload failed (attempt ${chunk.attempts}), retrying in ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
