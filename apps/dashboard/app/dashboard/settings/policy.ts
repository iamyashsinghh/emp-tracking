import { api } from "../../../lib/api";

/**
 * Local mirror of the tenant monitoring policy returned by
 * GET /api/tenants/policy. It follows devicePolicySchema in
 * packages/shared, but the dashboard does not depend on that package,
 * so the shape (and the min/max limits below) are repeated here.
 */
export interface Policy {
  monitoringEnabled: boolean;
  activityTrackingEnabled: boolean;
  activitySampleSeconds: number;
  idleThresholdSeconds: number;
  screenshotsEnabled: boolean;
  screenshotIntervalSeconds: number;
  screenshotBlur: boolean;
  screenRecordingEnabled: boolean;
  recordingChunkSeconds: number;
  recordingFps: number;
  showTrayIcon: boolean;
  notifyEmployeeOnStart: boolean;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;

  // Not in the shared schema yet. The page only enables these controls
  // once the backend starts returning the key, so nothing is silently
  // dropped by the server.
  activeWindowOnly?: boolean;
  dailyCapMinutes?: number;
  excludedApps?: string[];
}

export type PolicyKey = keyof Policy;

/** Fields that need a shared-schema + Prisma change before they persist. */
export const PENDING_KEYS = ["activeWindowOnly", "dailyCapMinutes", "excludedApps"] as const;

export const LIMITS = {
  activitySampleSeconds: { min: 5, max: 3600 },
  idleThresholdSeconds: { min: 30, max: 7200 },
  screenshotIntervalSeconds: { min: 5, max: 3600 },
  recordingChunkSeconds: { min: 30, max: 3600 },
  recordingFps: { min: 1, max: 30 },
  dailyCapMinutes: { min: 0, max: 1440 },
} as const;

export type LimitedKey = keyof typeof LIMITS;

const HHMM = /^\d{2}:\d{2}$/;

export interface Me {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string;
}

/** Roles allowed to change policy; mirrors requireUser on the backend route. */
export const POLICY_EDITOR_ROLES = ["SUPER_ADMIN", "ADMIN"];

export function fetchMe() {
  return api<Me>("/api/auth/me");
}

export function fetchPolicy() {
  return api<Policy | null>("/api/tenants/policy");
}

export function savePolicy(patch: Partial<Policy>) {
  return api<Policy>("/api/tenants/policy", { method: "PUT", body: JSON.stringify(patch) });
}

/** Returns a message per invalid field; empty object means the draft can be saved. */
export function validate(p: Policy): Partial<Record<PolicyKey, string>> {
  const errors: Partial<Record<PolicyKey, string>> = {};
  for (const key of Object.keys(LIMITS) as LimitedKey[]) {
    const value = p[key];
    if (value === undefined) continue;
    const { min, max } = LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      errors[key] = `Enter a whole number between ${min} and ${max}.`;
    }
  }
  const start = p.workingHoursStart ?? "";
  const end = p.workingHoursEnd ?? "";
  if (start && !HHMM.test(start)) errors.workingHoursStart = "Use HH:mm.";
  if (end && !HHMM.test(end)) errors.workingHoursEnd = "Use HH:mm.";
  if (Boolean(start) !== Boolean(end)) {
    errors.workingHoursEnd = "Set both a start and an end time, or leave both empty.";
  }
  return errors;
}

/**
 * Builds the PUT body: only fields that changed, and only fields the
 * backend accepts. Empty working hours are left out because the schema
 * accepts a time string or nothing, not null.
 */
export function diff(saved: Policy, draft: Policy, supported: Set<string>): Partial<Policy> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as PolicyKey[]) {
    if (!supported.has(key)) continue;
    const a = saved[key];
    const b = draft[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if ((key === "workingHoursStart" || key === "workingHoursEnd") && !b) continue;
    patch[key] = b;
  }
  return patch as Partial<Policy>;
}

/** 300 -> "5 min", 90 -> "1 min 30 s", 3600 -> "1 h". */
export function humanSeconds(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s) parts.push(`${s} s`);
  return parts.join(" ");
}
