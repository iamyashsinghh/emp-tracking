import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityBatchSchema, deviceConfigResponseSchema } from "@emptrack/shared";
import { buildActivityEvents, buildEnrollInput } from "@emptrack/test-utils";
import { resetDatabase, seedTenant, SeededTenant } from "@emptrack/test-utils/db";
import { call, login } from "./support/client";
import { e2ePrisma } from "./support/db";

/**
 * The product's core loop, end to end against a real backend + Postgres:
 *   admin issues an enrollment token → agent enrolls → agent pulls policy →
 *   agent uploads activity → admin sees the device and the activity in the
 *   same reports the dashboard renders.
 *
 * Each step is its own test and they share state in order, so a failure
 * names the step that broke. Add new flows as new *.e2e.test.ts files.
 */
describe("enroll → ingest activity → view in dashboard", () => {
  const prisma = e2ePrisma();
  let seeded: SeededTenant;
  let other: SeededTenant;
  let adminToken: string;
  let enrollmentToken: string;
  let deviceId: string;
  let deviceToken: string;
  const start = new Date(Date.now() - 10 * 60 * 1000);
  const events = buildActivityEvents(6, { start, stepSeconds: 60, apps: ["Code", "Chrome", "Slack"] });

  beforeAll(async () => {
    await resetDatabase(prisma);
    seeded = await seedTenant(prisma, { slug: "e2e-acme", name: "E2E Acme" });
    other = await seedTenant(prisma, { slug: "e2e-globex", name: "E2E Globex" });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admin logs in", async () => {
    adminToken = await login(seeded.admin.email, seeded.admin.password);
    expect(adminToken).toBeTruthy();
  });

  it("admin issues an enrollment token for the employee", async () => {
    const r = await call("POST", `/api/users/${seeded.employee.id}/devices`, { token: adminToken });
    expect(r.status).toBe(201);
    expect(r.body.enrollmentToken).toEqual(expect.any(String));
    enrollmentToken = r.body.enrollmentToken;
  });

  it("agent enrolls with the token, and the token cannot be reused", async () => {
    const input = buildEnrollInput({ enrollmentToken, hostname: "e2e-laptop" });
    const r = await call("POST", "/api/agent/enroll", { body: input });
    expect(r.status).toBe(200);
    expect(r.body.tenantId).toBe(seeded.tenant.id);
    deviceId = r.body.deviceId;
    deviceToken = r.body.token;

    const again = await call("POST", "/api/agent/enroll", { body: input });
    expect(again.status).toBe(409);
  });

  it("agent fetches its policy", async () => {
    const r = await call("GET", "/api/agent/config", { token: deviceToken });
    expect(r.status).toBe(200);
    const parsed = deviceConfigResponseSchema.parse(r.body);
    expect(parsed.deviceId).toBe(deviceId);
  });

  it("agent uploads activity, and a retried batch is not double-counted", async () => {
    const batch = activityBatchSchema.parse({ events });
    const r = await call("POST", "/api/agent/activity", { token: deviceToken, body: batch });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(events.length);

    const retry = await call("POST", "/api/agent/activity", { token: deviceToken, body: batch });
    expect(retry.status).toBe(200);
    expect(retry.body.accepted).toBe(0);
  });

  it("dashboard lists the enrolled device", async () => {
    const r = await call<any[]>("GET", "/api/reports/devices", { token: adminToken });
    expect(r.status).toBe(200);
    const device = r.body.find((d) => d.id === deviceId);
    expect(device).toMatchObject({ enrolled: true, hostname: "e2e-laptop" });
    expect(device.user?.id).toBe(seeded.employee.id);
  });

  it("dashboard shows the per-app summary and the raw timeline", async () => {
    const summary = await call<{ appName: string; activeSeconds: number }[]>(
      "GET",
      "/api/reports/activity/summary",
      { token: adminToken }
    );
    expect(summary.status).toBe(200);
    const byApp = Object.fromEntries(summary.body.map((s) => [s.appName, s.activeSeconds]));
    expect(byApp).toMatchObject({ Code: 120, Chrome: 120, Slack: 120 });

    const timeline = await call<any[]>("GET", `/api/reports/activity?deviceId=${deviceId}`, { token: adminToken });
    expect(timeline.status).toBe(200);
    expect(timeline.body).toHaveLength(events.length);
  });

  it("another company's admin sees none of it", async () => {
    const otherToken = await login(other.admin.email, other.admin.password);
    const devices = await call<any[]>("GET", "/api/reports/devices", { token: otherToken });
    expect(devices.status).toBe(200);
    expect(devices.body.find((d) => d.id === deviceId)).toBeUndefined();
    const summary = await call<any[]>("GET", "/api/reports/activity/summary", { token: otherToken });
    expect(summary.body).toEqual([]);
  });

  it("agent token is refused on dashboard endpoints", async () => {
    const r = await call("GET", "/api/reports/devices", { token: deviceToken });
    expect(r.status).toBe(403);
  });

  // Next steps for this flow, once those modules land:
  it.todo("agent uploads a screenshot through the presigned URL and the dashboard lists it (needs MinIO)");
  it.todo("dashboard UI renders the device and app summary in a real browser (Playwright)");
});
