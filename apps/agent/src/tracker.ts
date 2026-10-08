import { powerMonitor } from "electron";
import { v4 as uuid } from "uuid";
import activeWin from "active-win";
import { ActivityEvent, DevicePolicy } from "@emptrack/shared";
import { apiClient } from "./api";

/**
 * Samples the foreground application / window title / browser URL on an
 * interval and tracks idle transitions. Buffers events and flushes them in
 * batches so a brief network outage never loses data.
 */
export class ActivityTracker {
  private timer: NodeJS.Timeout | null = null;
  private buffer: ActivityEvent[] = [];
  private wasIdle = false;
  private lastSampleAt = Date.now();

  constructor(private policy: DevicePolicy) {}

  updatePolicy(policy: DevicePolicy) {
    this.policy = policy;
  }

  start() {
    this.push("SESSION_START");
    const intervalMs = this.policy.activitySampleSeconds * 1000;
    this.timer = setInterval(() => this.sample().catch(() => {}), intervalMs);
    // Flush buffered events every 30s independent of the sample rate.
    setInterval(() => this.flush().catch(() => {}), 30_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.push("SESSION_END");
    void this.flush();
  }

  private idleSeconds(): number {
    return powerMonitor.getSystemIdleTime();
  }

  private async sample() {
    if (!this.policy.activityTrackingEnabled) return;

    const idle = this.idleSeconds();
    const isIdle = idle >= this.policy.idleThresholdSeconds;
    if (isIdle && !this.wasIdle) this.push("IDLE_START");
    if (!isIdle && this.wasIdle) this.push("IDLE_END");
    this.wasIdle = isIdle;
    if (isIdle) return;

    const now = Date.now();
    const activeSeconds = Math.round((now - this.lastSampleAt) / 1000);
    this.lastSampleAt = now;

    try {
      const win = await activeWin();
      if (!win) return;
      const url = (win as any).url as string | undefined; // populated for browsers
      this.push("APP_ACTIVE", {
        appName: win.owner?.name,
        windowTitle: win.title,
        url,
        activeSeconds,
      });
    } catch {
      // active-win needs screen-recording permission on macOS; ignore until granted.
    }
  }

  private push(type: ActivityEvent["type"], extra: Partial<ActivityEvent> = {}) {
    this.buffer.push({
      clientEventId: uuid(),
      capturedAt: new Date().toISOString(),
      type,
      ...extra,
    });
    if (this.buffer.length >= 50) void this.flush();
  }

  private async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await apiClient.sendActivity(batch);
    } catch {
      // Re-queue on failure so we retry on the next flush tick.
      this.buffer.unshift(...batch);
    }
  }
}
