import { describe, expect, it } from "vitest";
import express from "express";
import { AddressInfo } from "net";
import { buildDevicePolicy, deviceToken } from "@emptrack/test-utils";

// Proves the backend test harness: env defaults load, routers can be mounted
// on a throwaway express app, and test-utils tokens pass the real guards.
describe("backend test harness", () => {
  it("serves the agent router with a mocked database", async () => {
    const { prisma } = await import("../src/prisma");
    const policy = buildDevicePolicy({ screenshotIntervalSeconds: 60 });
    Object.defineProperty(prisma, "device", {
      configurable: true,
      value: {
        findFirst: async () => ({ id: "d1", tenantId: "t1" }),
        update: async () => ({}),
      },
    });
    Object.defineProperty(prisma, "tenantPolicy", {
      configurable: true,
      value: { findUnique: async () => ({ ...policy, workingHoursStart: null, workingHoursEnd: null }) },
    });
    const { agentRouter } = await import("../src/routes/agent");

    const app = express().use(express.json()).use("/api/agent", agentRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/agent/config`, {
        headers: { authorization: `Bearer ${deviceToken({ deviceId: "d1", tenantId: "t1" })}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ deviceId: "d1", tenantId: "t1" });
      expect(body.policy.screenshotIntervalSeconds).toBe(60);
    } finally {
      server.close();
    }
  });
});
