import { describe, expect, it } from "vitest";
import express from "express";
import { AddressInfo } from "net";
import { buildDevicePolicy, deviceToken } from "@emptrack/test-utils";

// The policy a device receives must be exactly what the dashboard saved.
// A hand-picked field list once dropped activeWindowOnly, so agents kept the
// default (true) and, where the active window can't be read, never took a
// screenshot even with the setting turned off.
describe("GET /api/agent/config", () => {
  it("passes every saved policy setting through to the device", async () => {
    const { prisma } = await import("../src/prisma");
    const saved = {
      ...buildDevicePolicy({
        activeWindowOnly: false,
        excludedApps: ["Slack"],
        screenshotDailyCap: 40,
        recordingDailyCapMinutes: 90,
        recordingBitrateKbps: 800,
        screenshotIntervalSeconds: 30,
        activitySampleSeconds: 10,
      }),
      id: "p1",
      tenantId: "t1",
      mediaRetentionDays: 30,
      workingHoursStart: "10:00",
      workingHoursEnd: "19:00",
      updatedAt: new Date(),
    };
    Object.defineProperty(prisma, "device", {
      configurable: true,
      value: { findFirst: async () => ({ id: "d1", tenantId: "t1" }), update: async () => ({}) },
    });
    Object.defineProperty(prisma, "tenantPolicy", {
      configurable: true,
      value: { findUnique: async () => saved },
    });
    const { agentRouter } = await import("../src/routes/agent");

    const server = express().use(express.json()).use("/api/agent", agentRouter).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/agent/config`, {
        headers: { authorization: `Bearer ${deviceToken({ deviceId: "d1", tenantId: "t1" })}` },
      });
      expect(res.status).toBe(200);
      const { policy } = await res.json();
      expect(policy).toMatchObject({
        activeWindowOnly: false,
        excludedApps: ["Slack"],
        screenshotDailyCap: 40,
        recordingDailyCapMinutes: 90,
        recordingBitrateKbps: 800,
        screenshotIntervalSeconds: 30,
        activitySampleSeconds: 10,
        workingHoursStart: "10:00",
        workingHoursEnd: "19:00",
      });
      // Server-only fields stay on the server.
      expect(policy).not.toHaveProperty("mediaRetentionDays");
      expect(policy).not.toHaveProperty("tenantId");
    } finally {
      server.close();
    }
  });

  it("treats unset working hours as always on", async () => {
    const { policyFromRow } = await import("../src/routes/agent");
    const policy = policyFromRow({ ...buildDevicePolicy(), workingHoursStart: null, workingHoursEnd: null });
    expect(policy.workingHoursStart).toBeUndefined();
    expect(policy.workingHoursEnd).toBeUndefined();
  });
});
