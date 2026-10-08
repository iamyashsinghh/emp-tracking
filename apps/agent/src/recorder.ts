import path from "path";
import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import { DevicePolicy } from "@emptrack/shared";
import { uploadMedia } from "./uploader";

/**
 * Continuous screen recording. A hidden renderer window runs MediaRecorder on
 * the captured desktop stream (that is the only place the browser media APIs
 * exist), rotates a new file every recordingChunkSeconds, and hands each
 * finished chunk back to the main process over IPC for upload.
 */
export class ScreenRecorder {
  private win: BrowserWindow | null = null;
  private running = false;

  constructor(private policy: DevicePolicy) {}

  updatePolicy(policy: DevicePolicy) {
    const wasOn = this.running;
    this.policy = policy;
    if (policy.screenRecordingEnabled && !wasOn) this.start();
    if (!policy.screenRecordingEnabled && wasOn) this.stop();
  }

  async start() {
    if (this.running || !this.policy.screenRecordingEnabled) return;
    this.running = true;

    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    if (sources.length === 0) {
      this.running = false;
      return;
    }

    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "capture-preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    ipcMain.removeHandler("recorder:chunk");
    ipcMain.handle("recorder:chunk", async (_e, payload: { buffer: ArrayBuffer; durationSeconds: number }) => {
      try {
        await uploadMedia("RECORDING", "video/webm", Buffer.from(payload.buffer), payload.durationSeconds);
      } catch (err) {
        console.warn("[recorder] upload failed:", (err as Error).message);
      }
    });

    await this.win.loadFile(path.join(__dirname, "capture.html"));
    this.win.webContents.send("recorder:begin", {
      sourceId: sources[0].id,
      chunkSeconds: this.policy.recordingChunkSeconds,
      fps: this.policy.recordingFps,
    });
  }

  stop() {
    this.running = false;
    if (this.win) {
      this.win.webContents.send("recorder:stop");
      this.win.destroy();
      this.win = null;
    }
  }
}
