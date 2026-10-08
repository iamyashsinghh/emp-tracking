import { BrowserWindow, dialog } from "electron";
import { config } from "./config";

/**
 * Transparency notice. Responsible workplace monitoring is disclosed to the
 * employee: on first run the agent shows what it collects and records that the
 * notice was acknowledged. This keeps the tool a visible, consent-based
 * workplace product rather than covert surveillance.
 */
export async function ensureConsent(parent?: BrowserWindow): Promise<void> {
  if (config.consentAcceptedAt) return;

  await dialog.showMessageBox(parent!, {
    type: "info",
    title: "Workplace monitoring notice",
    message: "This device is monitored by your employer",
    detail:
      "While you are signed in, this company device records activity for work purposes: " +
      "the active application and window, visited work URLs, idle time, periodic screenshots, " +
      "and (when enabled by your administrator) screen recordings.\n\n" +
      "A tray icon stays visible whenever monitoring is active. Contact your administrator " +
      "with any questions about your company's monitoring policy.",
    buttons: ["I understand"],
    defaultId: 0,
  });

  config.acceptConsent();
}
