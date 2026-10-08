import { desktopCapturer, screen } from "electron";
import { DevicePolicy } from "@emptrack/shared";
import { uploadMedia } from "./uploader";

/**
 * Periodic screenshots. Uses Electron's desktopCapturer to grab a full-size
 * thumbnail of the primary display, encodes it as JPEG and uploads it.
 */
export class Screenshotter {
  private timer: NodeJS.Timeout | null = null;

  constructor(private policy: DevicePolicy) {}

  updatePolicy(policy: DevicePolicy) {
    this.policy = policy;
    this.restart();
  }

  start() {
    if (!this.policy.screenshotsEnabled) return;
    const intervalMs = this.policy.screenshotIntervalSeconds * 1000;
    this.timer = setInterval(() => this.capture().catch((e) => console.warn("[screenshot]", e.message)), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private restart() {
    this.stop();
    this.start();
  }

  private async capture() {
    if (!this.policy.screenshotsEnabled) return;
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scale = primary.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (sources.length === 0) return;

    let image = sources[0].thumbnail;
    if (this.policy.screenshotBlur) {
      // Cheap privacy mode: downscale so fine detail (text) is unreadable.
      image = image.resize({ width: Math.round(width / 4) });
    }
    const jpeg = image.toJPEG(70);
    await uploadMedia("SCREENSHOT", "image/jpeg", jpeg);
  }
}
