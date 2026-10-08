import path from "path";
import os from "os";
import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } from "electron";
import { config } from "./config";
import { apiClient } from "./api";
import { ensureConsent } from "./consent";
import { ActivityTracker } from "./tracker";
import { Screenshotter } from "./screenshot";
import { ScreenRecorder } from "./recorder";
import { DevicePolicy } from "@emptrack/shared";

let tray: Tray | null = null;
let tracker: ActivityTracker | null = null;
let shotter: Screenshotter | null = null;
let recorder: ScreenRecorder | null = null;
let enrollWin: BrowserWindow | null = null;

const platform = process.platform as "win32" | "darwin" | "linux";

function trayIcon() {
  // A tiny 1x1 placeholder; replace with assets/tray.png in a real build.
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  );
}

function buildTray(policy: DevicePolicy) {
  if (!policy.showTrayIcon) return;
  if (!tray) tray = new Tray(trayIcon());
  tray.setToolTip("EmpTrack — workplace monitoring active");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Monitoring active", enabled: false },
      { label: `Screenshots: ${policy.screenshotsEnabled ? "on" : "off"}`, enabled: false },
      { label: `Recording: ${policy.screenRecordingEnabled ? "on" : "off"}`, enabled: false },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ])
  );
}

async function enroll(token: string, serverUrl: string) {
  config.setServerUrl(serverUrl);
  const result = await apiClient.enroll({
    enrollmentToken: token,
    hostname: os.hostname(),
    platform,
    osVersion: os.release(),
    agentVersion: app.getVersion(),
  });
  config.setEnrollment(result.deviceId, result.tenantId, result.token);
}

function openEnrollWindow() {
  enrollWin = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    title: "Enroll device",
    webPreferences: { preload: path.join(__dirname, "enroll-preload.js"), contextIsolation: true },
  });
  void enrollWin.loadFile(path.join(__dirname, "enroll.html"));
}

async function startMonitoring() {
  const cfg = await apiClient.fetchConfig().catch(() => null);
  const policy = cfg?.policy ?? config.policy;
  if (cfg) config.setPolicy(policy);

  if (!policy.monitoringEnabled) {
    buildTray(policy);
    return;
  }

  if (policy.notifyEmployeeOnStart) await ensureConsent();
  buildTray(policy);

  tracker = new ActivityTracker(policy);
  shotter = new Screenshotter(policy);
  recorder = new ScreenRecorder(policy);
  tracker.start();
  shotter.start();
  if (policy.screenRecordingEnabled) void recorder.start();

  // Poll for policy changes every 60s.
  setInterval(async () => {
    const next = await apiClient.fetchConfig().catch(() => null);
    if (!next) return;
    config.setPolicy(next.policy);
    tracker?.updatePolicy(next.policy);
    shotter?.updatePolicy(next.policy);
    recorder?.updatePolicy(next.policy);
    buildTray(next.policy);
  }, 60_000);
}

app.whenReady().then(async () => {
  // Keep the agent running with no dock icon on macOS.
  if (app.dock) app.dock.hide();

  ipcMain.handle("enroll:submit", async (_e, { token, serverUrl }) => {
    try {
      await enroll(token, serverUrl);
      enrollWin?.close();
      enrollWin = null;
      await startMonitoring();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  if (!config.isEnrolled) {
    openEnrollWindow();
  } else {
    await startMonitoring();
  }
});

// Agent is a background service — keep running when all windows close.
// Registering an (empty) handler overrides Electron's default quit-on-close
// on Windows/Linux, so the agent stays alive in the tray.
app.on("window-all-closed", () => {
  // Intentionally left blank.
});
