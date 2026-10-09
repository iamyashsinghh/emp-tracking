import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activeWin from "active-win";
import { buildDevicePolicy } from "@emptrack/test-utils";

const sent: Array<{ type: string; appName?: string; activeSeconds?: number }> = [];
vi.mock("../src/api", () => ({
  apiClient: { sendActivity: vi.fn(async (batch: typeof sent) => void sent.push(...batch)) },
}));

const { ActivityTracker, UNKNOWN_APP } = await import("../src/tracker");

const policy = buildDevicePolicy({
  activitySampleSeconds: 10,
  workingHoursStart: undefined,
  workingHoursEnd: undefined,
});

async function runFor(seconds: number) {
  const tracker = new ActivityTracker(policy);
  tracker.start();
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  await tracker.stop();
  return sent.filter((e) => e.type === "APP_ACTIVE");
}

describe("activity tracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(activeWin).mockReset();
  });

  it("records the foreground app every sample", async () => {
    vi.mocked(activeWin).mockResolvedValue({
      title: "Inbox",
      id: 1,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      owner: { name: "firefox", processId: 1, path: "/usr/bin/firefox" },
      memoryUsage: 0,
      platform: "linux",
    } as never);
    const active = await runFor(30);
    expect(active).toHaveLength(3);
    expect(active[0]).toMatchObject({ appName: "firefox", activeSeconds: 10 });
  });

  // Wayland or missing xprop/xwininfo on Linux: the employee is working but
  // the OS won't name the window. That time must still reach the dashboard.
  it("still counts active time when the active window can't be read", async () => {
    vi.mocked(activeWin).mockResolvedValue(undefined);
    expect(await runFor(30)).toHaveLength(3);

    sent.length = 0;
    vi.mocked(activeWin).mockRejectedValue(new Error("spawn xprop ENOENT"));
    const active = await runFor(20);
    expect(active).toHaveLength(2);
    expect(active.every((e) => e.appName === UNKNOWN_APP && e.activeSeconds === 10)).toBe(true);
  });
});
