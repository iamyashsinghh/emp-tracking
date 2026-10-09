import fs from "fs";
import path from "path";
import { app } from "electron";

/**
 * Small diagnostics log for support: why the agent is (not) collecting.
 * Lines go to the console and to `<userData>/agent.log` (e.g.
 * ~/.config/EmpTrack Agent/agent.log on Linux), so a non-technical user can
 * send the file when the dashboard stays empty. The file is trimmed when it
 * grows past 1 MB.
 */

const MAX_BYTES = 1024 * 1024;
let logFile: string | null = null;

function file(): string | null {
  if (logFile) return logFile;
  try {
    logFile = path.join(app.getPath("userData"), "agent.log");
    return logFile;
  } catch {
    return null;
  }
}

export function diag(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`;
  console.log(line);
  const f = file();
  if (!f) return;
  try {
    if (fs.existsSync(f) && fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, `${f}.1`);
    fs.appendFileSync(f, line + "\n");
  } catch {
    // Logging must never break collection.
  }
}

const lastState = new Map<string, string>();

/** Logs only when the state for `key` changes, so per-tick checks don't spam. */
export function diagState(scope: string, key: string, state: string): void {
  if (lastState.get(key) === state) return;
  lastState.set(key, state);
  diag(scope, state);
}

/** Describes the device clock, for "outside working hours" reports. */
export function localClock(now = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm} ${tz}`;
}
