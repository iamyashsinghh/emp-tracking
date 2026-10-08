import { powerMonitor } from "electron";
import { v4 as uuid } from "uuid";
import activeWin from "active-win";
import { ActivityEvent, DevicePolicy } from "@emptrack/shared";
import { apiClient } from "./api";

/**
 * Cross-platform foreground activity tracker.
 *
 * Every `activitySampleSeconds` it records which application is in the
 * foreground, its window title and (where the OS exposes it) the browser URL,
 * plus idle transitions. It never reads keystrokes, window contents or
 * clipboard data. Events are buffered and flushed in batches so a brief
 * network outage never loses data.
 *
 * Platform notes:
 * - Windows: app/title via Win32 (active-win). No browser URL is available.
 * - macOS: app/title need the Screen Recording permission, the URL needs
 *   Accessibility. Without them the sample degrades (empty title / no URL)
 *   instead of failing.
 * - Linux: X11 only (via xprop/xwininfo). Under Wayland active-win usually
 *   returns nothing, so samples are skipped while idle tracking still works.
 */

type ActivityType = ActivityEvent["type"];

const FLUSH_INTERVAL_MS = 30_000;
/** Server accepts at most 500 events per batch (activityBatchSchema). */
const MAX_BATCH = 500;
/** Hard cap on buffered events during long outages; oldest are dropped. */
const MAX_BUFFER = 10_000;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

export interface ForegroundSample {
  appName: string;
  windowTitle?: string;
  url?: string;
}

/** Normalizes OS-specific app names ("chrome.exe", "Safari.app") to one form. */
export function normalizeAppName(name: string | undefined, path?: string): string {
  let n = (name ?? "").trim();
  if (!n && path) n = path.split(/[\\/]/).pop() ?? "";
  return n.replace(/\.(exe|app)$/i, "").trim();
}

/**
 * Keeps only scheme, host and path of a browser URL. Query strings and
 * fragments often carry session tokens or personal data, so they are dropped.
 */
export function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const out = `${u.protocol}//${u.host}${u.pathname}`;
    return out.slice(0, MAX_URL_LENGTH);
  } catch {
    return undefined;
  }
}

function normalizeTitle(title: string | undefined): string | undefined {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MAX_TITLE_LENGTH) : undefined;
}

/** Case-insensitive match against the excluded list (by name or executable). */
export function isExcludedApp(sample: { appName: string; path?: string }, excluded: string[]): boolean {
  if (excluded.length === 0) return false;
  const candidates = new Set<string>();
  candidates.add(sample.appName.toLowerCase());
  if (sample.path) candidates.add(normalizeAppName(undefined, sample.path).toLowerCase());
  return excluded.some((e) => candidates.has(normalizeAppName(e).toLowerCase()));
}

/** True when `now` falls within the policy's HH:mm working hours (local time). */
export function withinWorkingHours(policy: DevicePolicy, now = new Date()): boolean {
  const { workingHoursStart: start, workingHoursEnd: end } = policy;
  if (!start || !end) return true;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMin(start);
  const e = toMin(end);
  if (s === e) return true;
  // Overnight shifts such as 22:00-06:00 wrap past midnight.
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** Active seconds since the previous sample, never more than one interval. */
export function clampActiveSeconds(elapsedMs: number, sampleSeconds: number): number {
  const secs = Math.round(Math.max(0, elapsedMs) / 1000);
  return Math.min(secs, sampleSeconds);
}

async function readForeground(): Promise<(ForegroundSample & { path?: string }) | null> {
  const win = await activeWin();
  if (!win) return null;
  const appName = normalizeAppName(win.owner?.name, win.owner?.path);
  if (!appName) return null;
  return {
    appName,
    path: win.owner?.path,
    windowTitle: normalizeTitle(win.title),
    // Only macOS exposes the active tab URL for supported browsers.
    url: win.platform === "macos" ? normalizeUrl(win.url) : undefined,
  };
}

export class ActivityTracker {
  private sampleTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private sampleSeconds = 0;
  private buffer: ActivityEvent[] = [];
  private flushing = false;
  private running = false;
  private idle = false;
  /** Screen locked or system suspended; treated as idle regardless of input. */
  private away = false;
  private lastSampleAt = Date.now();
  private readonly onAway = () => this.setAway(true);
  private readonly onBack = () => this.setAway(false);

  constructor(private policy: DevicePolicy) {}

  updatePolicy(policy: DevicePolicy) {
    this.policy = policy;
    if (this.running && policy.activitySampleSeconds !== this.sampleSeconds) {
      this.scheduleSampling();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastSampleAt = Date.now();
    this.push("SESSION_START");
    this.scheduleSampling();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    powerMonitor.on("lock-screen", this.onAway);
    powerMonitor.on("suspend", this.onAway);
    powerMonitor.on("unlock-screen", this.onBack);
    powerMonitor.on("resume", this.onBack);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.sampleTimer = this.flushTimer = null;
    powerMonitor.off("lock-screen", this.onAway);
    powerMonitor.off("suspend", this.onAway);
    powerMonitor.off("unlock-screen", this.onBack);
    powerMonitor.off("resume", this.onBack);
    if (this.idle) this.push("IDLE_END");
    this.idle = false;
    this.push("SESSION_END");
    await this.flush();
  }

  private scheduleSampling() {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleSeconds = this.policy.activitySampleSeconds;
    this.sampleTimer = setInterval(() => void this.sample().catch(() => {}), this.sampleSeconds * 1000);
  }

  private collecting(): boolean {
    const p = this.policy;
    return p.monitoringEnabled && p.activityTrackingEnabled && withinWorkingHours(p);
  }

  private setAway(away: boolean) {
    this.away = away;
    if (away && this.running && this.collecting()) this.setIdle(true);
    // On unlock/resume the next sample decides idle state from real input.
  }

  private setIdle(idle: boolean) {
    if (idle === this.idle) return;
    this.idle = idle;
    this.push(idle ? "IDLE_START" : "IDLE_END");
    // Time spent idle must never be credited to the next active sample.
    this.lastSampleAt = Date.now();
  }

  private async sample() {
    const now = Date.now();
    if (!this.collecting()) {
      if (this.idle) this.setIdle(false);
      this.lastSampleAt = now;
      return;
    }

    const idleSecs = powerMonitor.getSystemIdleTime();
    this.setIdle(this.away || idleSecs >= this.policy.idleThresholdSeconds);
    if (this.idle) return;

    // Clamp so a delayed timer (sleep, busy event loop) or the first sample
    // after idle never over-reports active time.
    const activeSeconds = clampActiveSeconds(now - this.lastSampleAt, this.sampleSeconds);
    this.lastSampleAt = now;

    let fg: Awaited<ReturnType<typeof readForeground>>;
    try {
      fg = await readForeground();
    } catch {
      // Missing macOS permission or no X11 display; try again next tick.
      return;
    }
    if (!fg) return;
    if (isExcludedApp(fg, this.policy.excludedApps)) return;

    this.push("APP_ACTIVE", {
      appName: fg.appName,
      windowTitle: fg.windowTitle,
      url: fg.url,
      activeSeconds,
    });
  }

  private push(type: ActivityType, extra: Partial<ActivityEvent> = {}) {
    this.buffer.push({
      clientEventId: uuid(),
      capturedAt: new Date().toISOString(),
      type,
      ...extra,
    });
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    if (this.buffer.length >= 50) void this.flush();
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, MAX_BATCH);
        try {
          await apiClient.sendActivity(batch);
        } catch {
          // Keep the batch buffered and retry on the next flush tick.
          return;
        }
        // Remove by id: the overflow cap may have trimmed the buffer meanwhile.
        const sent = new Set(batch.map((e) => e.clientEventId));
        this.buffer = this.buffer.filter((e) => !sent.has(e.clientEventId));
      }
    } finally {
      this.flushing = false;
    }
  }
}
