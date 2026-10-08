import os from "os";
import path from "path";
import { app, BrowserWindow, ipcMain } from "electron";
import { config, normalizeServerUrl } from "./config";
import { apiClient } from "./api";

/**
 * Device enrollment. An administrator issues a one-time enrollment token for
 * a company device from the dashboard; the employee (or IT) pastes it here
 * and the agent exchanges it for a long-lived device token that ties this
 * device to the tenant. Nothing is captured until enrollment succeeds and
 * the monitoring notice has been acknowledged.
 */

const platform = process.platform as "win32" | "darwin" | "linux";

/** Exchanges an enrollment token for device credentials and stores them. */
export async function enrollDevice(rawToken: string, rawServerUrl: string): Promise<void> {
  const token = rawToken.trim();
  if (token.length < 10) throw new Error("That enrollment token looks too short");
  const serverUrl = normalizeServerUrl(rawServerUrl);

  const previousUrl = config.serverUrl;
  config.setServerUrl(serverUrl);
  try {
    const result = await apiClient.enroll({
      enrollmentToken: token,
      hostname: os.hostname(),
      platform,
      osVersion: os.release(),
      agentVersion: app.getVersion(),
    });
    config.setEnrollment(result.deviceId, result.tenantId, result.token);
  } catch (err) {
    config.setServerUrl(previousUrl);
    throw new Error(friendlyError(err));
  }
}

function friendlyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/ 401 /.test(msg)) return "This enrollment token is not valid. Ask your administrator for a new one.";
  if (/ 409 /.test(msg)) return "This enrollment token was already used. Ask your administrator for a new one.";
  if (/ 400 /.test(msg)) return "The server rejected the enrollment request.";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return "Could not reach the server. Check the server URL and your connection.";
  }
  return msg;
}

let win: BrowserWindow | null = null;
let pending: Promise<void> | null = null;

/**
 * Opens the enrollment window and resolves once the device is enrolled.
 * Calling it again while the window is open just focuses it. Rejects if the
 * window is closed without enrolling.
 */
export function runEnrollment(): Promise<void> {
  if (win && pending) {
    win.focus();
    return pending;
  }

  pending = new Promise<void>((resolve, reject) => {
    let done = false;

    ipcMain.removeHandler("enroll:defaults");
    ipcMain.handle("enroll:defaults", () => ({ serverUrl: config.serverUrl }));

    ipcMain.removeHandler("enroll:submit");
    ipcMain.handle("enroll:submit", async (_e, args: { token?: unknown; serverUrl?: unknown }) => {
      try {
        await enrollDevice(String(args?.token ?? ""), String(args?.serverUrl ?? ""));
        done = true;
        resolve();
        setImmediate(() => win?.close());
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    win = new BrowserWindow({
      width: 460,
      height: 470,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "Enroll device · EmpTrack",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "enroll-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // The form is local; never let it navigate or open other windows.
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void win.loadFile(path.join(__dirname, "enroll.html"));

    win.on("closed", () => {
      win = null;
      pending = null;
      ipcMain.removeHandler("enroll:submit");
      ipcMain.removeHandler("enroll:defaults");
      if (!done) reject(new Error("Enrollment window closed"));
    });
  });
  return pending;
}
