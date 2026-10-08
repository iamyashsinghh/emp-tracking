import { z } from "zod";

/**
 * Shared contracts between the desktop agent, backend API and dashboard.
 * Keeping these in one place means the agent and the server can never
 * drift apart on what an activity event or a device config looks like.
 */

// ---------------------------------------------------------------------------
// Roles & auth
// ---------------------------------------------------------------------------

export const Role = {
  SuperAdmin: "SUPER_ADMIN", // platform owner, can manage every tenant
  Admin: "ADMIN", // manages a single tenant (company)
  Manager: "MANAGER", // views activity for their team
  Employee: "EMPLOYEE", // monitored user
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Agent enrollment & config
// ---------------------------------------------------------------------------

/** The agent authenticates with a per-device enrollment token, not a password. */
export const enrollDeviceSchema = z.object({
  enrollmentToken: z.string().min(10),
  hostname: z.string().min(1),
  platform: z.enum(["win32", "darwin", "linux"]),
  osVersion: z.string().optional(),
  agentVersion: z.string().optional(),
});
export type EnrollDeviceInput = z.infer<typeof enrollDeviceSchema>;

/**
 * Monitoring policy pushed down to each device. Everything is configurable
 * per tenant so different companies can run different rules, and intervals
 * are expressed in seconds as requested.
 */
export const devicePolicySchema = z.object({
  // Master switch — if false the agent collects nothing.
  monitoringEnabled: z.boolean().default(true),

  // App / active-window + URL tracking.
  activityTrackingEnabled: z.boolean().default(true),
  activitySampleSeconds: z.number().int().min(5).max(3600).default(30),

  // Idle detection.
  idleThresholdSeconds: z.number().int().min(30).max(7200).default(300),

  // Periodic screenshots.
  screenshotsEnabled: z.boolean().default(true),
  screenshotIntervalSeconds: z.number().int().min(5).max(3600).default(300),
  // Blur screenshots for lighter privacy footprint.
  screenshotBlur: z.boolean().default(false),

  // Continuous screen recording (video).
  screenRecordingEnabled: z.boolean().default(false),
  // Length of each recorded chunk before it is uploaded and rotated.
  recordingChunkSeconds: z.number().int().min(30).max(3600).default(300),
  recordingFps: z.number().int().min(1).max(30).default(5),
  // Target video bitrate for recordings, in kbps.
  recordingBitrateKbps: z.number().int().min(100).max(50000).default(1500),

  // --- Canonical capture controls (ONE agreed name each) -------------------
  // Bind every consumer (tenants route, agent screenshot/recorder, dashboard
  // settings) to exactly these fields.
  // Apps (by process/app identifier) to skip entirely — no capture while foreground.
  excludedApps: z.array(z.string()).default([]),
  // Capture only the active window (true) or the whole screen (false).
  activeWindowOnly: z.boolean().default(true),
  // Max SCREENSHOTS per device per day (count); 0 = no cap.
  screenshotDailyCap: z.number().int().min(0).default(0),
  // Max screen-RECORDING MINUTES per device per day; 0 = no cap.
  recordingDailyCapMinutes: z.number().int().min(0).default(0),

  // Transparency: the agent always shows it is running. These only tune how.
  showTrayIcon: z.boolean().default(true),
  notifyEmployeeOnStart: z.boolean().default(true),

  // Only collect inside working hours (24h local time, HH:mm).
  // null/absent = always on; send null to clear a saved value.
  workingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  workingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});
export type DevicePolicy = z.infer<typeof devicePolicySchema>;

export const deviceConfigResponseSchema = z.object({
  deviceId: z.string(),
  tenantId: z.string(),
  policy: devicePolicySchema,
  serverTime: z.string(),
});
export type DeviceConfigResponse = z.infer<typeof deviceConfigResponseSchema>;

// ---------------------------------------------------------------------------
// Activity events
// ---------------------------------------------------------------------------

export const activityEventSchema = z.object({
  // Client generated id so retries are idempotent on the server.
  clientEventId: z.string().uuid(),
  capturedAt: z.string(), // ISO timestamp
  type: z.enum(["APP_ACTIVE", "IDLE_START", "IDLE_END", "SESSION_START", "SESSION_END"]),
  appName: z.string().optional(),
  windowTitle: z.string().optional(),
  url: z.string().optional(),
  // Seconds the user was active on this app/window since the previous sample.
  activeSeconds: z.number().int().min(0).optional(),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityBatchSchema = z.object({
  events: z.array(activityEventSchema).min(1).max(500),
});
export type ActivityBatch = z.infer<typeof activityBatchSchema>;

// ---------------------------------------------------------------------------
// Media (screenshots & recordings)
// ---------------------------------------------------------------------------

export const mediaKind = z.enum(["SCREENSHOT", "RECORDING"]);
export type MediaKind = z.infer<typeof mediaKind>;

/** Agent asks the server for a presigned upload URL, then PUTs the bytes. */
export const mediaUploadRequestSchema = z.object({
  kind: mediaKind,
  capturedAt: z.string(),
  contentType: z.string(),
  // Only for recordings: the duration of the chunk in seconds.
  durationSeconds: z.number().int().min(0).optional(),
});
export type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;

export const mediaUploadResponseSchema = z.object({
  mediaId: z.string(),
  uploadUrl: z.string(),
  // Headers the agent must echo on the PUT so the signature matches.
  requiredHeaders: z.record(z.string()),
});
export type MediaUploadResponse = z.infer<typeof mediaUploadResponseSchema>;

// ---------------------------------------------------------------------------
// Admin input schemas (shared by backend validation and dashboard forms)
// ---------------------------------------------------------------------------

export const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase letters, digits and hyphens only"),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum([Role.Admin, Role.Manager, Role.Employee]).default(Role.Employee),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Date-range + optional subject filters shared by every reporting query. */
export const reportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  deviceId: z.string().optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTOs (the exact shapes the API returns and the dashboard consumes)
// ---------------------------------------------------------------------------

export interface TenantDTO {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface UserDTO {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt?: string;
}

export interface LoginResponse {
  token: string;
  user: Pick<UserDTO, "id" | "name" | "email" | "role" | "tenantId">;
}

export interface DeviceDTO {
  id: string;
  tenantId: string;
  userId: string | null;
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  enrolled: boolean;
  lastSeenAt: string | null;
}

/** Device plus the employee it is bound to, as the device list returns it. */
export interface DeviceWithUserDTO extends DeviceDTO {
  user: Pick<UserDTO, "id" | "name" | "email"> | null;
}

export interface ActivityLogDTO {
  id: string;
  deviceId: string;
  userId: string | null;
  type: ActivityEvent["type"];
  appName: string | null;
  windowTitle: string | null;
  url: string | null;
  activeSeconds: number;
  capturedAt: string;
}

/** One row of the "time spent per application" summary. */
export interface AppUsageSummary {
  appName: string;
  activeSeconds: number;
}

/** A screenshot or recording with a short-lived playback URL. */
export interface MediaItemDTO {
  id: string;
  kind: MediaKind;
  capturedAt: string;
  durationSeconds: number | null;
  contentType: string;
  url: string;
}

/** Standard error envelope returned by the API on 4xx/5xx. */
export interface ApiError {
  error: string | Record<string, unknown>;
}

/** Issued to an admin when they enroll a new device for an employee. */
export interface DeviceEnrollmentTicket {
  deviceId: string;
  enrollmentToken: string;
}

// ---------------------------------------------------------------------------
// Teams & productivity rules (reporting)
// ---------------------------------------------------------------------------

export const TeamRole = { Member: "MEMBER", Manager: "MANAGER" } as const;
export type TeamRole = (typeof TeamRole)[keyof typeof TeamRole];

export const RuleMatchType = { App: "APP", UrlDomain: "URL_DOMAIN" } as const;
export type RuleMatchType = (typeof RuleMatchType)[keyof typeof RuleMatchType];

export const ProductivityClass = {
  Productive: "PRODUCTIVE",
  Unproductive: "UNPRODUCTIVE",
  Neutral: "NEUTRAL",
} as const;
export type ProductivityClass = (typeof ProductivityClass)[keyof typeof ProductivityClass];

export const createTeamSchema = z.object({
  name: z.string().min(1),
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const addTeamMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum([TeamRole.Member, TeamRole.Manager]).default(TeamRole.Member),
});
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;

export const createProductivityRuleSchema = z.object({
  matchType: z.enum([RuleMatchType.App, RuleMatchType.UrlDomain]),
  pattern: z.string().min(1),
  classification: z
    .enum([ProductivityClass.Productive, ProductivityClass.Unproductive, ProductivityClass.Neutral])
    .default(ProductivityClass.Neutral),
});
export type CreateProductivityRuleInput = z.infer<typeof createProductivityRuleSchema>;

export interface TeamDTO {
  id: string;
  tenantId: string;
  name: string;
  memberCount?: number;
  createdAt: string;
}

export interface TeamMembershipDTO {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  user?: Pick<UserDTO, "id" | "name" | "email">;
}

export interface ProductivityRuleDTO {
  id: string;
  tenantId: string;
  matchType: RuleMatchType;
  pattern: string;
  classification: ProductivityClass;
}
