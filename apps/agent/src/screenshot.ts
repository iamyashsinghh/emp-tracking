import path from "path";
import { desktopCapturer, Display, NativeImage, powerMonitor, Rectangle, screen, systemPreferences } from "electron";
import Store from "electron-store";
import activeWin from "active-win";
import { DevicePolicy } from "@emptrack/shared";
import { uploadMedia } from "./uploader";
import { diagState, localClock } from "./diag";

/**
 * Periodic screenshots driven by tenant policy.
 *
 * - Interval is in seconds (`screenshotIntervalSeconds`).
 * - `activeWindowOnly` (default true) crops to the foreground window; when
 *   false the whole display the active window is on is captured.
 * - Optional blur, `excludedApps` (nothing is captured while one of
 *   those apps is in the foreground) and `screenshotDailyCap`
 *   (count per local day, 0 = no cap).
 * - Skips while idle, outside working hours or when monitoring is off.
 *
 * Captures go to the shared uploader. Cross-platform: active window comes from
 * active-win, pixels from Electron's desktopCapturer.
 */

interface QuotaState {
  day: string;
  count: number;
}

const JPEG_QUALITY = 70;
// Blur = downscale by this factor, then scale back up. Text becomes unreadable
// while layout / which app is open stays recognisable.
const BLUR_FACTOR = 12;

const quotaStore = new Store<{ quota: QuotaState }>({
  name: "emptrack-screenshot-quota",
  defaults: { quota: { day: "", count: 0 } },
});

export class Screenshotter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private capturing = false;
  private warnedPermission = false;

  constructor(private policy: DevicePolicy) {}

  updatePolicy(policy: DevicePolicy) {
    const prev = this.policy;
    this.policy = policy;
    // Only reschedule when timing-relevant fields change, so a 60s policy poll
    // does not keep pushing the next capture further out.
    if (
      prev.screenshotsEnabled !== policy.screenshotsEnabled ||
      prev.monitoringEnabled !== policy.monitoringEnabled ||
      prev.screenshotIntervalSeconds !== policy.screenshotIntervalSeconds
    ) {
      this.restart();
    }
  }

  start() {
    if (this.running) return;
    if (!this.policy.monitoringEnabled || !this.policy.screenshotsEnabled) return;
    this.running = true;
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private restart() {
    this.stop();
    this.start();
  }

  private schedule() {
    if (!this.running) return;
    const intervalMs = Math.max(5, this.policy.screenshotIntervalSeconds) * 1000;
    this.timer = setTimeout(async () => {
      await this.tick().catch((e) => console.warn("[screenshot]", e?.message ?? e));
      this.schedule();
    }, intervalMs);
  }

  private async tick() {
    // Never overlap captures if an upload is slow.
    if (this.capturing) return;
    this.capturing = true;
    try {
      await this.capture();
    } finally {
      this.capturing = false;
    }
  }

  private async capture() {
    const p = this.policy;
    if (!p.monitoringEnabled || !p.screenshotsEnabled) return;
    if (!withinWorkingHours(p)) {
      diagState("screenshot", "shot", `paused: device clock ${localClock()} is outside working hours ${p.workingHoursStart}-${p.workingHoursEnd}`);
      return;
    }
    if (powerMonitor.getSystemIdleTime() >= p.idleThresholdSeconds) {
      diagState("screenshot", "shot", "paused: user is idle");
      return;
    }
    if (!this.hasScreenPermission()) return;

    if (p.screenshotDailyCap > 0 && quotaUsedToday() >= p.screenshotDailyCap) return;

    const win = await activeWin().catch(() => undefined);
    if (win && isExcluded(win, p.excludedApps)) return;

    const windowRect = win ? toDipRect(win.bounds) : undefined;
    // In active-window mode we need to know which window that is; without it we
    // would fall back to a full screen grab the tenant did not ask for.
    if (p.activeWindowOnly && !windowRect) {
      diagState(
        "screenshot",
        "shot",
        "skipped: \"Active window only\" is on but the active window can't be read (turn it off in Settings, or see the activity lines above)"
      );
      return;
    }

    const display = windowRect ? screen.getDisplayMatching(windowRect) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    let image = await grabDisplay(display);
    if (!image || image.isEmpty()) {
      diagState(
        "screenshot",
        "shot",
        process.env.XDG_SESSION_TYPE === "wayland"
          ? "screen capture returned nothing (Wayland session: use an X11/Xorg session)"
          : "screen capture returned an empty image"
      );
      return;
    }

    if (p.activeWindowOnly && windowRect) {
      const crop = cropRect(windowRect, display, image);
      if (!crop) return;
      image = image.crop(crop);
    }

    if (p.screenshotBlur) image = blur(image);

    await uploadMedia("SCREENSHOT", "image/jpeg", image.toJPEG(JPEG_QUALITY));
    diagState("screenshot", "shot", "capturing");
    // Count only successful uploads against the daily cap.
    incrementQuota();
  }

  private hasScreenPermission(): boolean {
    if (process.platform !== "darwin") return true;
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return true;
    if (!this.warnedPermission) {
      console.warn("[screenshot] macOS Screen Recording permission not granted; skipping captures");
      this.warnedPermission = true;
    }
    return false;
  }
}

async function grabDisplay(display: Display): Promise<NativeImage | undefined> {
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  if (sources.length === 0) return undefined;
  // display_id is populated on Windows and macOS; Linux often leaves it empty.
  const match = sources.find((s) => s.display_id === String(display.id));
  if (match) return match.thumbnail;
  const primaryId = screen.getPrimaryDisplay().id;
  return sources.length === 1 || display.id === primaryId ? sources[0].thumbnail : undefined;
}

/** active-win reports physical pixels on Windows; everything else is DIP already. */
function toDipRect(bounds: Rectangle): Rectangle | undefined {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
  return process.platform === "win32" ? screen.screenToDipRect(null, bounds) : bounds;
}

/** Window rect (DIP, global) -> pixel rect inside the display thumbnail. */
function cropRect(win: Rectangle, display: Display, image: NativeImage): Rectangle | undefined {
  const { width: imgW, height: imgH } = image.getSize();
  const sx = imgW / display.bounds.width;
  const sy = imgH / display.bounds.height;

  const x0 = Math.max(0, Math.round((win.x - display.bounds.x) * sx));
  const y0 = Math.max(0, Math.round((win.y - display.bounds.y) * sy));
  const x1 = Math.min(imgW, Math.round((win.x + win.width - display.bounds.x) * sx));
  const y1 = Math.min(imgH, Math.round((win.y + win.height - display.bounds.y) * sy));
  if (x1 - x0 < 2 || y1 - y0 < 2) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function blur(image: NativeImage): NativeImage {
  const { width, height } = image.getSize();
  const small = image.resize({
    width: Math.max(1, Math.round(width / BLUR_FACTOR)),
    height: Math.max(1, Math.round(height / BLUR_FACTOR)),
    quality: "good",
  });
  return small.resize({ width, height, quality: "good" });
}

/**
 * Case-insensitive match against the app name, macOS bundle id or executable
 * file name, so admins can write "Slack", "com.tinyspeck.slackmacgap" or
 * "slack.exe".
 */
function isExcluded(win: activeWin.Result, excluded: string[]): boolean {
  if (excluded.length === 0) return false;
  const owner = win.owner as activeWin.Result["owner"] & { bundleId?: string };
  const candidates = [owner?.name, owner?.bundleId, owner?.path ? path.basename(owner.path) : undefined]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.toLowerCase());
  return excluded.some((e) => {
    const needle = e.trim().toLowerCase();
    return needle.length > 0 && candidates.includes(needle);
  });
}

function withinWorkingHours(p: DevicePolicy): boolean {
  if (!p.workingHoursStart || !p.workingHoursEnd) return true;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(p.workingHoursStart);
  const end = toMinutes(p.workingHoursEnd);
  // Overnight shifts, e.g. 22:00-06:00.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function quotaUsedToday(): number {
  const q = quotaStore.get("quota");
  return q.day === localDay() ? q.count : 0;
}

function incrementQuota() {
  const day = localDay();
  const q = quotaStore.get("quota");
  quotaStore.set("quota", { day, count: q.day === day ? q.count + 1 : 1 });
}
