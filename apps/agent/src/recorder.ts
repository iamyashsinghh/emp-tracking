import path from "path";
import activeWin from "active-win";
import { BrowserWindow, desktopCapturer, ipcMain, powerMonitor, systemPreferences } from "electron";
import { DevicePolicy } from "@emptrack/shared";
import { uploadMedia } from "./uploader";

/**
 * Policy-controlled screen recording for the transparent monitoring agent.
 *
 * Recording only ever runs when tenant policy has screenRecordingEnabled true;
 * the tray icon (main.ts) always shows that state to the employee. A hidden
 * renderer window runs MediaRecorder on the captured desktop stream (the only
 * place the browser media APIs exist). The main process drives one chunk at a
 * time: it picks the capture source (the foreground window when the policy's
 * activeWindowOnly is set, otherwise the whole screen), tells the renderer to
 * record for recordingChunkSeconds, then collects the finished WebM and queues
 * it for upload. Each chunk is a standalone, playable file.
 *
 * Everything is bound to the canonical policy fields: screenRecordingEnabled
 * (on/off), recordingChunkSeconds, recordingFps, recordingBitrateKbps,
 * activeWindowOnly, recordingDailyCapMinutes, and workingHoursStart/End.
 *
 * Recording pauses on its own when the screen locks, the machine sleeps, the
 * clock is outside working hours, or the per-day recording cap is reached, and
 * resumes afterwards. It stops cleanly on policy-off and on app quit, flushing
 * the final partial chunk.
 */

interface ChunkRequest {
  session: number;
  seq: number;
  sourceId: string;
  fps: number;
  bitsPerSecond: number;
}

interface ChunkResult {
  session: number;
  seq: number;
  buffer: ArrayBuffer;
  durationSeconds: number;
}

interface QueuedChunk {
  bytes: Buffer;
  durationSeconds: number;
  attempts: number;
}

const RETRY_DELAY_MS = 15_000;
const WORKING_HOURS_CHECK_MS = 30_000;
const MAX_UPLOAD_ATTEMPTS = 5;
const MAX_QUEUED_BYTES = 500 * 1024 * 1024;

type PauseReason = "locked" | "suspended" | "off-hours" | "daily-cap";

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

/** Local calendar day key, so the daily cap resets at the device's midnight. */
function dayKey(now = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export class ScreenRecorder {
  private win: BrowserWindow | null = null;
  private loopRunning = false;
  private quitting = false;

  // Bumped on every (re)start so chunks and signals from a torn-down renderer
  // can't be confused with the current session.
  private session = 0;
  private seq = 0;
  private pending: { seq: number; resolve: (r: ChunkResult | null) => void } | null = null;

  private readonly paused = new Set<PauseReason>();
  private hoursTimer: NodeJS.Timeout | null = null;
  private capTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  // Daily recording budget.
  private capDay = dayKey();
  private recordedSecondsToday = 0;

  private queue: QueuedChunk[] = [];
  private queuedBytes = 0;
  private draining = false;

  constructor(private policy: DevicePolicy) {
    this.registerIpc();
    this.registerSystemEvents();
  }

  private get wanted() {
    return this.policy.monitoringEnabled && this.policy.screenRecordingEnabled && !this.quitting;
  }

  get isRecording() {
    return this.loopRunning;
  }

  updatePolicy(policy: DevicePolicy) {
    this.policy = policy;
    this.syncWorkingHoursTimer();
    this.updateOffHours();
    this.updateDailyCap();
    this.reconcile();
  }

  async start() {
    this.syncWorkingHoursTimer();
    this.updateOffHours();
    this.updateDailyCap();
    this.reconcile();
  }

  /** Stop recording; the in-flight chunk is flushed and queued. */
  async stop() {
    this.clearRetryTimer();
    if (this.loopRunning) {
      this.loopRunning = false;
      // Ask the renderer to finish the current chunk early; the loop will
      // collect it and then tear the window down.
      if (this.win && !this.win.isDestroyed()) {
        try {
          this.win.webContents.send("recorder:end-chunk");
        } catch {
          /* window already gone */
        }
      }
    }
    // Wait for any in-flight chunk request to settle so the window isn't
    // destroyed out from under it.
    while (this.pending) await new Promise((r) => setTimeout(r, 50));
    this.destroyWindow();
  }

  /** Stop for good on app quit: flush the last chunk and try to upload it. */
  async shutdown() {
    this.quitting = true;
    if (this.hoursTimer) clearInterval(this.hoursTimer);
    this.hoursTimer = null;
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    await this.stop();
    await this.drain();
  }

  // ---------------------------------------------------------------------------
  // Capture loop
  // ---------------------------------------------------------------------------

  private reconcile() {
    const shouldRecord = this.wanted && this.paused.size === 0;
    if (shouldRecord && !this.loopRunning) {
      void this.runLoop();
    } else if (!shouldRecord && this.loopRunning) {
      void this.stop();
    }
  }

  private async runLoop() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    const session = ++this.session;

    try {
      if (!(await this.ensureScreenPermission())) {
        this.loopRunning = false;
        this.scheduleRetry();
        return;
      }
      if (!(await this.ensureWindow())) {
        this.loopRunning = false;
        this.scheduleRetry();
        return;
      }

      while (this.loopRunning && session === this.session && this.wanted && this.paused.size === 0) {
        if (this.capReached()) {
          this.enterDailyCapPause();
          break;
        }

        const sourceId = await this.pickSourceId();
        if (!sourceId) {
          // No capturable source right now; back off and retry.
          this.scheduleRetry();
          break;
        }

        const seconds = this.chunkSecondsRespectingCap();
        const result = await this.recordOneChunk(session, sourceId, seconds);
        if (!result) break;

        if (result.buffer.byteLength > 0) {
          this.enqueue({
            bytes: Buffer.from(result.buffer),
            durationSeconds: result.durationSeconds,
            attempts: 0,
          });
          this.addRecordedSeconds(result.durationSeconds);
        }
      }
    } catch (err) {
      console.warn("[recorder] capture loop error:", (err as Error).message);
      this.scheduleRetry();
    } finally {
      this.loopRunning = false;
      if (!this.wanted || this.paused.size > 0 || this.quitting) this.destroyWindow();
    }
  }

  /**
   * Record a single chunk: tell the renderer to begin, let it run for `seconds`
   * (unless stop() ends it early), and resolve with the finished bytes.
   */
  private recordOneChunk(session: number, sourceId: string, seconds: number): Promise<ChunkResult | null> {
    return new Promise<ChunkResult | null>((resolve) => {
      const win = this.win;
      if (!win || win.isDestroyed()) {
        resolve(null);
        return;
      }
      const seq = ++this.seq;
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (r: ChunkResult | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.pending = null;
        resolve(r);
      };

      this.pending = {
        seq,
        resolve: (r) => finish(r),
      };

      const req: ChunkRequest = {
        session,
        seq,
        sourceId,
        fps: this.policy.recordingFps,
        bitsPerSecond: this.policy.recordingBitrateKbps * 1000,
      };
      try {
        win.webContents.send("recorder:begin-chunk", req);
      } catch {
        finish(null);
        return;
      }

      // End the chunk after its configured length; the renderer flushes and
      // delivers, which resolves `pending`. Guard with a grace window in case
      // the renderer never answers.
      timer = setTimeout(() => {
        if (this.win && !this.win.isDestroyed()) {
          try {
            this.win.webContents.send("recorder:end-chunk");
          } catch {
            /* ignore */
          }
        }
        // If no delivery arrives shortly after we asked it to end, give up on
        // this chunk so the loop can recover.
        setTimeout(() => finish(null), RETRY_DELAY_MS);
      }, seconds * 1000);
    });
  }

  // ---------------------------------------------------------------------------
  // Source selection
  // ---------------------------------------------------------------------------

  private async ensureScreenPermission(): Promise<boolean> {
    if (process.platform !== "darwin") return true;
    // macOS gates screen capture behind a system permission. Until it is
    // granted we'd only record a blank desktop, so don't start; asking for
    // sources surfaces the OS prompt, then we retry later.
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return true;
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
    console.warn(`[recorder] screen capture permission is "${status}"; will retry`);
    return false;
  }

  /**
   * Pick the capture source for the next chunk. With activeWindowOnly we try to
   * record just the foreground window, matching it to a desktopCapturer window
   * source; if we can't resolve it we fall back to the whole primary screen so
   * recording never silently stops.
   */
  private async pickSourceId(): Promise<string | null> {
    if (this.policy.activeWindowOnly) {
      const windowId = await this.activeWindowSourceId().catch(() => null);
      if (windowId) return windowId;
    }
    const screens = await desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .catch(() => []);
    return screens.length > 0 ? screens[0].id : null;
  }

  private async activeWindowSourceId(): Promise<string | null> {
    const win = await activeWin();
    if (!win) return null;
    const sources = await desktopCapturer
      .getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } })
      .catch(() => []);
    if (sources.length === 0) return null;

    // desktopCapturer window ids look like "window:<nativeId>:<n>"; match the
    // numeric native id when we can, then fall back to the window title.
    const nativeId = String((win as any).id ?? "");
    if (nativeId) {
      const byId = sources.find((s) => s.id.split(":")[1] === nativeId);
      if (byId) return byId.id;
    }
    const title = win.title?.trim();
    if (title) {
      const byTitle = sources.find((s) => s.name.trim() === title);
      if (byTitle) return byTitle.id;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Hidden renderer window
  // ---------------------------------------------------------------------------

  private async ensureWindow(): Promise<boolean> {
    if (this.win && !this.win.isDestroyed()) return true;
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
    try {
      await win.loadFile(path.join(__dirname, "capture.html"));
      return !win.isDestroyed();
    } catch (err) {
      console.warn("[recorder] failed to load capture page:", (err as Error).message);
      this.destroyWindow();
      return false;
    }
  }

  private destroyWindow() {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  // ---------------------------------------------------------------------------
  // Pausing: lock / sleep / working hours / daily cap
  // ---------------------------------------------------------------------------

  private registerSystemEvents() {
    const pause = (reason: PauseReason) => {
      this.paused.add(reason);
      void this.stop();
    };
    const resume = (reason: PauseReason) => {
      if (this.paused.delete(reason)) this.reconcile();
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
      if (this.paused.delete("off-hours")) this.reconcile();
    }
  }

  private updateOffHours() {
    const off = !withinWorkingHours(this.policy);
    if (off === this.paused.has("off-hours")) return;
    if (off) {
      this.paused.add("off-hours");
      void this.stop();
    } else if (this.paused.delete("off-hours")) {
      this.reconcile();
    }
  }

  // ---------------------------------------------------------------------------
  // Daily recording cap
  // ---------------------------------------------------------------------------

  private get capSeconds(): number {
    return this.policy.recordingDailyCapMinutes > 0 ? this.policy.recordingDailyCapMinutes * 60 : 0;
  }

  private rollDayIfNeeded() {
    const today = dayKey();
    if (today !== this.capDay) {
      this.capDay = today;
      this.recordedSecondsToday = 0;
    }
  }

  private capReached(): boolean {
    this.rollDayIfNeeded();
    const cap = this.capSeconds;
    return cap > 0 && this.recordedSecondsToday >= cap;
  }

  /** Shorten the final chunk so we don't overshoot the daily cap. */
  private chunkSecondsRespectingCap(): number {
    const full = this.policy.recordingChunkSeconds;
    const cap = this.capSeconds;
    if (cap === 0) return full;
    const remaining = cap - this.recordedSecondsToday;
    return remaining > 0 ? Math.min(full, remaining) : full;
  }

  private addRecordedSeconds(seconds: number) {
    this.rollDayIfNeeded();
    this.recordedSecondsToday += seconds;
  }

  private updateDailyCap() {
    // If the cap was raised or removed while paused for it, lift the pause.
    if (this.paused.has("daily-cap") && !this.capReached()) {
      this.paused.delete("daily-cap");
      if (this.capTimer) clearTimeout(this.capTimer);
      this.capTimer = null;
      this.reconcile();
    }
  }

  private enterDailyCapPause() {
    this.paused.add("daily-cap");
    void this.stop();
    if (this.capTimer) clearTimeout(this.capTimer);
    // Resume at the next local midnight when the budget resets.
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    this.capTimer = setTimeout(() => {
      this.capTimer = null;
      this.rollDayIfNeeded();
      if (this.paused.delete("daily-cap")) this.reconcile();
    }, Math.max(1000, midnight.getTime() - now.getTime()));
  }

  // ---------------------------------------------------------------------------
  // Retry / upload queue
  // ---------------------------------------------------------------------------

  private scheduleRetry() {
    if (this.retryTimer || this.quitting) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.reconcile();
    }, RETRY_DELAY_MS);
  }

  private clearRetryTimer() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private registerIpc() {
    ipcMain.removeHandler("recorder:chunk");
    ipcMain.handle("recorder:chunk", (_e, result: ChunkResult) => {
      // Resolve the waiting chunk request, even from a session we've already
      // torn down (the final partial chunk arrives just after we end it).
      if (this.pending && this.pending.seq === result.seq) {
        this.pending.resolve(result);
      }
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
