import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import {
  activityBatchSchema,
  activityEventSchema,
  devicePolicySchema,
  enrollDeviceSchema,
} from "@emptrack/shared";
import {
  buildActivityBatch,
  buildActivityEvent,
  buildActivityEvents,
  buildDevice,
  buildDevicePolicy,
  buildEnrollInput,
  buildTenantPolicy,
  buildUser,
  deviceToken,
  userToken,
} from "./index";

// Guards the fixtures themselves: if a shared contract changes, these fail
// here first instead of in every module's tests.
describe("factories match the shared contracts", () => {
  it("builds a valid activity event and batch", () => {
    expect(activityEventSchema.safeParse(buildActivityEvent()).success).toBe(true);
    expect(activityBatchSchema.safeParse(buildActivityBatch()).success).toBe(true);
  });

  it("spaces a run of events and cycles apps", () => {
    const events = buildActivityEvents(4, { start: new Date("2026-01-01T00:00:00Z"), stepSeconds: 60, apps: ["A", "B"] });
    expect(events.map((e) => e.appName)).toEqual(["A", "B", "A", "B"]);
    expect(events[1].capturedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(new Set(events.map((e) => e.clientEventId)).size).toBe(4);
  });

  it("builds a valid enrollment payload and policy", () => {
    expect(enrollDeviceSchema.safeParse(buildEnrollInput()).success).toBe(true);
    expect(devicePolicySchema.safeParse(buildDevicePolicy({ screenshotIntervalSeconds: 60 })).success).toBe(true);
  });

  it("keeps the tenant policy row in step with the policy defaults", () => {
    const row = buildTenantPolicy();
    const defaults = buildDevicePolicy();
    for (const [key, value] of Object.entries(defaults)) {
      expect(row[key as keyof typeof row], key).toBe(value);
    }
  });

  it("generates unique users and devices and applies overrides", () => {
    const a = buildUser();
    const b = buildUser({ role: "ADMIN" });
    expect(a.email).not.toBe(b.email);
    expect(b.role).toBe("ADMIN");
    expect(buildDevice().enrollmentToken.length).toBeGreaterThanOrEqual(10);
  });
});

describe("token helpers", () => {
  it("mints user and device tokens the backend can verify", () => {
    const secret = process.env.JWT_SECRET!;
    const u = jwt.verify(userToken({ userId: "u1", tenantId: "t1", role: "ADMIN", email: "a@b.c" }), secret) as any;
    expect(u).toMatchObject({ userId: "u1", tenantId: "t1", role: "ADMIN" });
    const d = jwt.verify(deviceToken({ deviceId: "d1", tenantId: "t1" }), secret) as any;
    expect(d).toMatchObject({ deviceId: "d1", kind: "device" });
  });
});
