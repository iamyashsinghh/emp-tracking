import { BrowserWindow, dialog } from "electron";
import { DevicePolicy } from "@emptrack/shared";
import { config, ConsentScope } from "./config";

/**
 * Transparency notice. Responsible workplace monitoring is disclosed to the
 * employee: before anything is captured the agent shows exactly what it
 * collects under the current policy and records that the notice was
 * acknowledged. If the administrator later widens the policy (for example
 * turns on screen recording) the notice is shown again before the new
 * capture starts. This keeps the tool a visible, consent-based workplace
 * product rather than covert surveillance.
 */

export function scopeFor(policy: DevicePolicy): ConsentScope {
  return {
    activity: policy.activityTrackingEnabled,
    screenshots: policy.screenshotsEnabled,
    recording: policy.screenRecordingEnabled,
  };
}

/** True when the policy collects something the employee has not been told about. */
export function needsConsent(policy: DevicePolicy): boolean {
  const seen = config.consentScope;
  if (!config.consentAcceptedAt || !seen) return true;
  const want = scopeFor(policy);
  return (want.activity && !seen.activity) || (want.screenshots && !seen.screenshots) || (want.recording && !seen.recording);
}

export function describeCollection(policy: DevicePolicy): string[] {
  const lines: string[] = [];
  if (policy.activityTrackingEnabled) {
    lines.push(
      `• The active application, window title and visited work URLs (sampled every ${policy.activitySampleSeconds}s)`
    );
  }
  lines.push(`• Idle time (after ${Math.round(policy.idleThresholdSeconds / 60)} min without input)`);
  if (policy.screenshotsEnabled) {
    lines.push(
      `• A screenshot of your screen every ${formatSeconds(policy.screenshotIntervalSeconds)}` +
        (policy.screenshotBlur ? " (blurred)" : "")
    );
  }
  if (policy.screenRecordingEnabled) {
    lines.push(`• Continuous screen recording at ${policy.recordingFps} fps`);
  }
  if (policy.workingHoursStart && policy.workingHoursEnd) {
    lines.push(`Collection only runs between ${policy.workingHoursStart} and ${policy.workingHoursEnd}.`);
  }
  return lines;
}

function formatSeconds(s: number): string {
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** Shows the notice without changing anything (tray → "What is collected?"). */
export async function showMonitoringNotice(policy: DevicePolicy): Promise<void> {
  await dialog.showMessageBox({
    type: "info",
    title: "Workplace monitoring notice",
    message: "This device is monitored by your employer",
    detail: noticeText(policy),
    buttons: ["OK"],
  });
}

function noticeText(policy: DevicePolicy): string {
  return (
    "While you are signed in, this company device records the following for work purposes:\n\n" +
    describeCollection(policy).join("\n") +
    "\n\nA tray icon stays visible whenever monitoring is active, and you can open this notice " +
    "from it at any time. Contact your administrator with any questions about your company's " +
    "monitoring policy."
  );
}

/**
 * Makes sure the employee has acknowledged the notice for everything the
 * policy collects. Resolves true when capture may start; false when the
 * employee chose not to acknowledge yet, in which case nothing is captured.
 */
export async function ensureConsent(policy: DevicePolicy, parent?: BrowserWindow): Promise<boolean> {
  if (!needsConsent(policy)) return true;

  const firstTime = !config.consentAcceptedAt;
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: "Workplace monitoring notice",
    message: firstTime
      ? "This device is monitored by your employer"
      : "Your employer has changed what this device monitors",
    detail: noticeText(policy),
    buttons: ["I understand", "Not now"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (response !== 0) return false;

  config.acceptConsent(scopeFor(policy));
  return true;
}
