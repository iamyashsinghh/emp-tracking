import fs from "fs";
import os from "os";
import path from "path";
import { app, Menu, MenuItemConstructorOptions, nativeImage, Notification, Tray } from "electron";
import { DevicePolicy } from "@emptrack/shared";
import { config } from "./config";
import { apiClient } from "./api";
import { describeCollection, ensureConsent, needsConsent, showMonitoringNotice } from "./consent";
import { runEnrollment } from "./enroll";
import { ActivityTracker } from "./tracker";
import { Screenshotter } from "./screenshot";
import { ScreenRecorder } from "./recorder";

/**
 * Agent lifecycle.
 *
 *   not enrolled ──enroll──▶ enrolled ──notice acknowledged──▶ capture runs
 *                                     while policy.monitoringEnabled and inside working hours
 *
 * The tray icon is created as soon as the app starts and stays for the whole
 * life of the process, so the employee can always see that the agent is
 * installed, whether it is collecting right now, and what it collects.
 */

type AgentStatus =
  | "enrolling" // waiting for an enrollment token
  | "awaiting-consent" // enrolled, notice not yet acknowledged
  | "declined" // employee chose "Not now" on the notice; nothing is captured
  | "active" // capture running
  | "paused-policy" // administrator turned monitoring off
  | "paused-hours" // outside the configured working hours
  | "starting";

const POLICY_POLL_MS = 60_000;

let tray: Tray | null = null;
let status: AgentStatus = "starting";
let policy: DevicePolicy = config.policy;
let lastSync: Date | null = null;
let offline = false;

let tracker: ActivityTracker | null = null;
let shotter: Screenshotter | null = null;
let recorder: ScreenRecorder | null = null;

let pollTimer: NodeJS.Timeout | null = null;
let consentPrompt: Promise<boolean> | null = null;
let declined = false;
let quitting = false;

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: "Starting…",
  enrolling: "Not enrolled — enrollment required",
  "awaiting-consent": "Waiting for you to acknowledge the monitoring notice",
  declined: "Paused — monitoring notice not acknowledged",
  active: "Monitoring active",
  "paused-policy": "Paused by your administrator",
  "paused-hours": "Paused — outside working hours",
};

const STATUS_COLOR: Record<AgentStatus, [number, number, number]> = {
  starting: [148, 163, 184],
  enrolling: [245, 158, 11],
  "awaiting-consent": [245, 158, 11],
  declined: [245, 158, 11],
  active: [34, 197, 94],
  "paused-policy": [148, 163, 184],
  "paused-hours": [148, 163, 184],
};

/** A filled status dot drawn in code so the agent ships without image assets. */
function trayIcon(s: AgentStatus) {
  const size = 32;
  const [r, g, b] = STATUS_COLOR[s];
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // Anti-aliased disc with a white ring so it reads on dark and light bars.
      const alpha = Math.max(0, Math.min(1, size / 2 - 1 - d));
      const ring = d > size / 2 - 5;
      const i = (y * size + x) * 4;
      buf[i] = ring ? 255 : b; // BGRA
      buf[i + 1] = ring ? 255 : g;
      buf[i + 2] = ring ? 255 : r;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function refreshTray() {
  if (!tray) tray = new Tray(trayIcon(status));
  tray.setImage(trayIcon(status));
  tray.setToolTip(`EmpTrack — ${STATUS_LABEL[status]}`);

  const items: MenuItemConstructorOptions[] = [
    { label: "EmpTrack workplace monitoring", enabled: false },
    { label: STATUS_LABEL[status], enabled: false },
  ];

  if (config.isEnrolled) {
    items.push({ type: "separator" });
    if (status === "active") {
      items.push({ label: "Currently collecting:", enabled: false });
      for (const line of describeCollection(policy)) items.push({ label: line, enabled: false });
    } else {
      items.push({ label: "Nothing is being collected right now", enabled: false });
    }
    items.push(
      { type: "separator" },
      { label: "What does this agent collect?", click: () => void showMonitoringNotice(policy) },
      ...(status === "declined" || status === "awaiting-consent"
        ? [{ label: "Review and acknowledge notice…", click: () => void acknowledgeFromTray() }]
        : []),
      { type: "separator" },
      { label: `Server: ${config.serverUrl}`, enabled: false },
      { label: `Device: ${config.deviceId ?? "—"}`, enabled: false },
      {
        label: offline
          ? "Server unreachable — using last known policy"
          : `Policy synced: ${lastSync ? lastSync.toLocaleTimeString() : "never"}`,
        enabled: false,
      }
    );
  } else {
    items.push({ type: "separator" }, { label: "Enroll this device…", click: () => void beginEnrollment() });
  }

  items.push({ type: "separator" }, { label: "Quit EmpTrack", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function setStatus(next: AgentStatus) {
  status = next;
  refreshTray();
}

// ---------------------------------------------------------------------------
// Capture start / stop
// ---------------------------------------------------------------------------

function isCapturing() {
  return tracker !== null;
}

function startCapture() {
  if (isCapturing()) return;
  tracker = new ActivityTracker(policy);
  shotter = new Screenshotter(policy);
  recorder = new ScreenRecorder(policy);
  tracker.start();
  shotter.start();
  if (policy.screenRecordingEnabled) void recorder.start();

  if (policy.notifyEmployeeOnStart && Notification.isSupported()) {
    new Notification({
      title: "EmpTrack monitoring started",
      body: "Your employer's monitoring is now active on this device. Open the tray icon to see what is collected.",
    }).show();
  }
}

function stopCapture() {
  if (!isCapturing()) return;
  tracker?.stop();
  shotter?.stop();
  recorder?.stop();
  tracker = shotter = recorder = null;
}

function applyPolicyToCapture() {
  tracker?.updatePolicy(policy);
  shotter?.updatePolicy(policy);
  recorder?.updatePolicy(policy);
}

function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function withinWorkingHours(p: DevicePolicy, now = new Date()): boolean {
  if (!p.workingHoursStart || !p.workingHoursEnd) return true;
  const start = minutesOf(p.workingHoursStart);
  const end = minutesOf(p.workingHoursEnd);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  // Supports overnight shifts such as 22:00–06:00.
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Brings capture in line with the current policy, consent and clock. */
async function reconcile() {
  if (quitting || !config.isEnrolled) return;

  if (!policy.monitoringEnabled) {
    stopCapture();
    return setStatus("paused-policy");
  }

  if (needsConsent(policy)) {
    // Never capture something the employee has not been told about.
    stopCapture();
    if (declined) return setStatus("declined");
    setStatus("awaiting-consent");
    if (!consentPrompt) {
      consentPrompt = ensureConsent(policy).finally(() => (consentPrompt = null));
      const accepted = await consentPrompt;
      declined = !accepted;
      return reconcile();
    }
    return;
  }

  if (!withinWorkingHours(policy)) {
    stopCapture();
    return setStatus("paused-hours");
  }

  if (isCapturing()) applyPolicyToCapture();
  else startCapture();
  setStatus("active");
}

async function acknowledgeFromTray() {
  declined = false;
  await reconcile();
}

// ---------------------------------------------------------------------------
// Policy sync
// ---------------------------------------------------------------------------

async function syncPolicy() {
  try {
    const cfg = await apiClient.fetchConfig();
    policy = cfg.policy;
    config.setPolicy(policy);
    lastSync = new Date();
    offline = false;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/ 401 /.test(msg)) {
      // The server no longer recognises this device (revoked or re-issued).
      // Drop the credentials and stop everything until it is enrolled again.
      console.warn("[agent] device token rejected; re-enrollment required");
      stopCapture();
      config.clearEnrollment();
      stopPolling();
      void beginEnrollment();
      return;
    }
    // Network trouble: keep running on the last known policy.
    offline = true;
  }
  await reconcile();
}

function startPolling() {
  if (pollTimer) return;
  // Also re-checks working hours, so capture pauses/resumes on the minute.
  pollTimer = setInterval(() => void syncPolicy(), POLICY_POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function onEnrolled() {
  policy = config.policy;
  startPolling();
  await syncPolicy();
}

async function beginEnrollment() {
  setStatus("enrolling");
  try {
    await runEnrollment();
  } catch {
    // Window closed without enrolling; the tray keeps offering "Enroll this device…".
    return;
  }
  await onEnrolled();
}

// ---------------------------------------------------------------------------
// Autostart on login
// ---------------------------------------------------------------------------

function linuxAutostartFile() {
  return path.join(os.homedir(), ".config", "autostart", "emptrack-agent.desktop");
}

function configureAutostart(enabled: boolean) {
  // Only register the installed app; in development this would point at the
  // bare Electron binary.
  if (!app.isPackaged) return;
  try {
    if (process.platform === "linux") {
      const file = linuxAutostartFile();
      if (!enabled) {
        fs.rmSync(file, { force: true });
        return;
      }
      // AppImage builds expose their real path via $APPIMAGE.
      const exec = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          "[Desktop Entry]",
          "Type=Application",
          "Name=EmpTrack Agent",
          "Comment=Workplace monitoring agent (shows a tray icon while active)",
          `Exec="${exec}"`,
          "X-GNOME-Autostart-enabled=true",
          "Terminal=false",
          "",
        ].join("\n")
      );
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    }
  } catch (err) {
    console.warn("[agent] could not configure autostart:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Another agent is already running for this user; let it handle things.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!config.isEnrolled) void beginEnrollment();
    else void showMonitoringNotice(policy);
  });

  app.whenReady().then(async () => {
    // Keep the agent running with no dock icon on macOS; the tray is its UI.
    if (app.dock) app.dock.hide();

    refreshTray();
    configureAutostart(config.autostart);

    if (config.isEnrolled) await onEnrolled();
    else await beginEnrollment();
  });

  // Flush the session end before exiting so the timeline closes cleanly.
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true;
    stopPolling();
    if (!isCapturing()) return;
    e.preventDefault();
    stopCapture();
    setTimeout(() => app.quit(), 1500);
  });
}

// Agent is a background service — keep running when all windows close.
// Registering an (empty) handler overrides Electron's default quit-on-close
// on Windows/Linux, so the agent stays alive in the tray.
app.on("window-all-closed", () => {
  // Intentionally left blank.
});
