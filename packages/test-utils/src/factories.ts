import { randomBytes, randomUUID } from "crypto";
import type { ActivityLog, Device, Tenant, TenantPolicy, User } from "@prisma/client";
import {
  ActivityBatch,
  ActivityEvent,
  DevicePolicy,
  EnrollDeviceInput,
  Role,
  devicePolicySchema,
} from "@emptrack/shared";
import { fakeId, nextSeq } from "./sequence";

/**
 * In-memory builders. They return plain objects shaped like the Prisma rows
 * or the shared wire contracts, with every field filled so a test only spells
 * out what it cares about: `buildUser({ role: Role.Admin })`.
 *
 * Prisma row types come from the generated client, so a schema change that
 * breaks a factory shows up as a type error here rather than a confusing
 * runtime failure in someone's test.
 */

const FIXED_NOW = new Date("2026-01-15T09:00:00.000Z");

/** The clock factories stamp rows with. Tests that need "now" should pass it. */
export function fixedNow(): Date {
  return new Date(FIXED_NOW);
}

export function buildTenant(overrides: Partial<Tenant> = {}): Tenant {
  const n = nextSeq();
  return {
    id: fakeId("tenant"),
    name: `Test Company ${n}`,
    slug: `test-co-${n}`,
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
    ...overrides,
  };
}

export function buildDevicePolicy(overrides: Partial<DevicePolicy> = {}): DevicePolicy {
  return devicePolicySchema.parse(overrides);
}

export function buildTenantPolicy(overrides: Partial<TenantPolicy> = {}): TenantPolicy {
  const p = buildDevicePolicy();
  return {
    id: fakeId("policy"),
    tenantId: overrides.tenantId ?? fakeId("tenant"),
    monitoringEnabled: p.monitoringEnabled,
    activityTrackingEnabled: p.activityTrackingEnabled,
    activitySampleSeconds: p.activitySampleSeconds,
    idleThresholdSeconds: p.idleThresholdSeconds,
    screenshotsEnabled: p.screenshotsEnabled,
    screenshotIntervalSeconds: p.screenshotIntervalSeconds,
    screenshotBlur: p.screenshotBlur,
    screenRecordingEnabled: p.screenRecordingEnabled,
    recordingChunkSeconds: p.recordingChunkSeconds,
    recordingFps: p.recordingFps,
    showTrayIcon: p.showTrayIcon,
    notifyEmployeeOnStart: p.notifyEmployeeOnStart,
    workingHoursStart: null,
    workingHoursEnd: null,
    updatedAt: fixedNow(),
    ...overrides,
  };
}

/** Password every factory user gets unless overridden; meets loginSchema's min length. */
export const DEFAULT_PASSWORD = "password1234";

export function buildUser(overrides: Partial<User> = {}): User {
  const n = nextSeq();
  return {
    id: fakeId("user"),
    tenantId: fakeId("tenant"),
    email: `user${n}@test.local`,
    name: `Test User ${n}`,
    // Not a real hash: in-memory users never go through bcrypt. db.ts hashes.
    passwordHash: `plain:${DEFAULT_PASSWORD}`,
    role: Role.Employee,
    isActive: true,
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
    ...overrides,
  };
}

export function buildDevice(overrides: Partial<Device> = {}): Device {
  const n = nextSeq();
  return {
    id: fakeId("device"),
    tenantId: fakeId("tenant"),
    userId: null,
    enrollmentToken: randomBytes(24).toString("hex"),
    enrolled: false,
    hostname: `test-host-${n}`,
    platform: "linux",
    osVersion: "6.0.0",
    agentVersion: "0.1.0",
    lastSeenAt: null,
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
    ...overrides,
  };
}

export function buildEnrollInput(overrides: Partial<EnrollDeviceInput> = {}): EnrollDeviceInput {
  return {
    enrollmentToken: randomBytes(24).toString("hex"),
    hostname: `test-host-${nextSeq()}`,
    platform: "linux",
    osVersion: "6.0.0",
    agentVersion: "0.1.0",
    ...overrides,
  };
}

/** One agent-side activity sample, valid against `activityEventSchema`. */
export function buildActivityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    clientEventId: randomUUID(),
    capturedAt: fixedNow().toISOString(),
    type: "APP_ACTIVE",
    appName: "Code",
    windowTitle: "index.ts — emp-tracking",
    activeSeconds: 30,
    ...overrides,
  };
}

/**
 * A realistic run of samples: `count` APP_ACTIVE events cycling through
 * `apps`, spaced `stepSeconds` apart starting at `start`.
 */
export function buildActivityEvents(
  count: number,
  opts: { start?: Date; stepSeconds?: number; apps?: string[] } = {}
): ActivityEvent[] {
  const start = opts.start ?? fixedNow();
  const step = opts.stepSeconds ?? 30;
  const apps = opts.apps ?? ["Code", "Chrome", "Slack"];
  return Array.from({ length: count }, (_, i) =>
    buildActivityEvent({
      capturedAt: new Date(start.getTime() + i * step * 1000).toISOString(),
      appName: apps[i % apps.length],
      windowTitle: `${apps[i % apps.length]} window`,
      activeSeconds: step,
    })
  );
}

export function buildActivityBatch(events: ActivityEvent[] = buildActivityEvents(3)): ActivityBatch {
  return { events };
}

/** A stored ActivityLog row, e.g. for mocking Prisma in report tests. */
export function buildActivityLog(overrides: Partial<ActivityLog> = {}): ActivityLog {
  return {
    id: fakeId("activity"),
    tenantId: fakeId("tenant"),
    deviceId: fakeId("device"),
    userId: null,
    clientEventId: randomUUID(),
    type: "APP_ACTIVE",
    appName: "Code",
    windowTitle: "index.ts — emp-tracking",
    url: null,
    activeSeconds: 30,
    capturedAt: fixedNow(),
    createdAt: fixedNow(),
    ...overrides,
  };
}
