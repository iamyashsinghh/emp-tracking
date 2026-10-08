import { describe, expect, it } from "vitest";

// Proves the agent test harness: electron, electron-store and active-win are
// faked, so agent modules load under plain Node.
describe("agent test harness", () => {
  it("loads agent config against the in-memory store", async () => {
    const { config } = await import("../src/config");
    expect(config.serverUrl).toBe("http://agent-test.local");
    expect(config.isEnrolled).toBe(false);
    expect(config.policy.monitoringEnabled).toBe(true);
  });
});
