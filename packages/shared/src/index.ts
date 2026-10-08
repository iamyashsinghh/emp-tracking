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

  // Transparency: the agent always shows it is running. These only tune how.
  showTrayIcon: z.boolean().default(true),
  notifyEmployeeOnStart: z.boolean().default(true),

  // Only collect inside working hours (24h local time, HH:mm). Empty = always.
  workingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  workingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
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
