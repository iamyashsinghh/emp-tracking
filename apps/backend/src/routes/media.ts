import crypto from "crypto";
import { Router } from "express";
import { mediaKind, mediaUploadRequestSchema, Role } from "@emptrack/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { requireDevice, requireUser } from "../auth";
import { deleteObjects, presignDownload, presignUpload, statObjectSize } from "../storage";

// ---------------------------------------------------------------------------
// Limits & config
// ---------------------------------------------------------------------------

const ALLOWED_TYPES: Record<string, string[]> = {
  SCREENSHOT: ["image/png", "image/jpeg", "image/webp"],
  RECORDING: ["video/webm", "video/mp4"],
};

const MAX_BYTES: Record<string, number> = {
  SCREENSHOT: 15 * 1024 * 1024,
  RECORDING: 512 * 1024 * 1024,
};

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Default retention; TenantPolicy.mediaRetentionDays overrides it per tenant.
const RETENTION_DAYS = intEnv("MEDIA_RETENTION_DAYS", 30);
// Presigned uploads that were never confirmed are cleaned up after this.
const PENDING_UPLOAD_TTL_HOURS = intEnv("MEDIA_PENDING_TTL_HOURS", 24);
const RETENTION_INTERVAL_MINUTES = intEnv("MEDIA_RETENTION_INTERVAL_MINUTES", 60);

function extFor(kind: string, contentType: string): string {
  if (kind === "RECORDING") return contentType.includes("mp4") ? "mp4" : "webm";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

// ---------------------------------------------------------------------------
// Agent API (device token) — mounted at /api/agent/media
// ---------------------------------------------------------------------------

export const mediaRouter = Router();

// Agent requests a signed upload URL, PUTs the bytes to it (the local storage
// folder via /api/storage, or S3 directly when STORAGE_DRIVER=s3), then confirms.
mediaRouter.post("/upload-url", requireDevice, async (req, res) => {
  const parsed = mediaUploadRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { kind, contentType, durationSeconds } = parsed.data;

  const contentTypeBase = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES[kind].includes(contentTypeBase)) {
    return res.status(415).json({ error: `Unsupported content type for ${kind}: ${contentType}` });
  }

  const captured = new Date(parsed.data.capturedAt);
  if (Number.isNaN(captured.getTime())) return res.status(400).json({ error: "Invalid capturedAt" });

  const device = await prisma.device.findFirst({
    where: { id: req.device!.deviceId, tenantId: req.device!.tenantId },
  });
  if (!device) return res.status(401).json({ error: "Unknown device" });

  // Respect the tenant's monitoring policy server-side too, not only in the agent.
  const policy = await prisma.tenantPolicy.findUnique({ where: { tenantId: device.tenantId } });
  if (policy) {
    const allowed =
      policy.monitoringEnabled &&
      (kind === "SCREENSHOT" ? policy.screenshotsEnabled : policy.screenRecordingEnabled);
    if (!allowed) return res.status(403).json({ error: `${kind} capture is disabled by policy` });
  }

  const day = captured.toISOString().slice(0, 10);
  const ext = extFor(kind, contentTypeBase);
  const nonce = crypto.randomBytes(4).toString("hex");
  // Tenant-prefixed keys keep each company's files in its own folder / bucket prefix.
  const key = `${device.tenantId}/${device.id}/${kind.toLowerCase()}/${day}/${captured.getTime()}-${nonce}.${ext}`;

  const asset = await prisma.mediaAsset.create({
    data: {
      tenantId: device.tenantId,
      deviceId: device.id,
      userId: device.userId,
      kind,
      storageKey: key,
      contentType: contentTypeBase,
      durationSeconds: kind === "RECORDING" ? durationSeconds : undefined,
      capturedAt: captured,
    },
  });

  const { uploadUrl, requiredHeaders } = await presignUpload(key, contentTypeBase, 60 * 10, MAX_BYTES[kind]);
  res.json({ mediaId: asset.id, uploadUrl, requiredHeaders });
});

// Agent confirms the bytes landed so the dashboard can show the asset.
// The size is read from storage rather than trusted from the client.
mediaRouter.post("/:mediaId/confirm", requireDevice, async (req, res) => {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: req.params.mediaId, tenantId: req.device!.tenantId, deviceId: req.device!.deviceId },
  });
  if (!asset) return res.status(404).json({ error: "Not found" });
  if (asset.uploaded) return res.json({ ok: true, mediaId: asset.id });

  const size = await statObjectSize(asset.storageKey);
  if (size === null) return res.status(409).json({ error: "Object not found in storage; upload first" });

  if (size > MAX_BYTES[asset.kind]) {
    await deleteObjects([asset.storageKey]);
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    return res.status(413).json({ error: `File too large (${size} bytes)` });
  }

  const updated = await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { uploaded: true, sizeBytes: size },
  });
  res.json({ ok: true, mediaId: updated.id });
});

// ---------------------------------------------------------------------------
// Dashboard API (user token) — intended mount: /api/media
// ---------------------------------------------------------------------------

export const mediaAdminRouter = Router();

const viewerRoles = [Role.SuperAdmin, Role.Admin, Role.Manager, Role.Employee];

/** Tenant scope plus "employees only see their own captures". */
function scopeFor(auth: { tenantId: string; userId: string; role: string }): Prisma.MediaAssetWhereInput {
  return {
    tenantId: auth.tenantId,
    ...(auth.role === Role.Employee ? { userId: auth.userId } : {}),
  };
}

function parseDate(v: unknown): Date | undefined {
  if (v === undefined) return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function serialize(a: {
  id: string;
  kind: string;
  deviceId: string;
  userId: string | null;
  contentType: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  capturedAt: Date;
}) {
  return {
    id: a.id,
    kind: a.kind,
    deviceId: a.deviceId,
    userId: a.userId,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    durationSeconds: a.durationSeconds,
    capturedAt: a.capturedAt,
  };
}

// List media, newest first, cursor-paginated. Each item carries a short-lived
// presigned URL so the dashboard can render thumbnails directly.
// Query: kind, userId, deviceId, from, to, limit (<=200), cursor (media id).
mediaAdminRouter.get("/", requireUser(...viewerRoles), async (req, res) => {
  const kindParsed = req.query.kind ? mediaKind.safeParse(req.query.kind) : undefined;
  if (kindParsed && !kindParsed.success) return res.status(400).json({ error: "Invalid kind" });

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

  const where: Prisma.MediaAssetWhereInput = {
    ...scopeFor(req.auth!),
    uploaded: true,
    ...(kindParsed?.success ? { kind: kindParsed.data } : {}),
    ...(req.query.deviceId ? { deviceId: String(req.query.deviceId) } : {}),
    ...(req.query.userId && req.auth!.role !== Role.Employee ? { userId: String(req.query.userId) } : {}),
    ...(from || to ? { capturedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  const rows = await prisma.mediaAsset.findMany({
    where,
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, limit);
  const items = await Promise.all(
    page.map(async (a) => ({ ...serialize(a), url: await presignDownload(a.storageKey) }))
  );
  res.json({ items, nextCursor: rows.length > limit ? page[page.length - 1].id : null });
});

// Single asset with a presigned URL. `?download=1` forces a file download.
mediaAdminRouter.get("/:mediaId", requireUser(...viewerRoles), async (req, res) => {
  const asset = await prisma.mediaAsset.findFirst({
    where: { ...scopeFor(req.auth!), id: req.params.mediaId, uploaded: true },
  });
  if (!asset) return res.status(404).json({ error: "Not found" });

  const download = req.query.download === "1" || req.query.download === "true";
  const filename = asset.storageKey.split("/").pop();
  const url = await presignDownload(asset.storageKey, 60 * 10, download ? filename : undefined);
  res.json({ ...serialize(asset), url, expiresInSeconds: 600 });
});

// Admin deletes a capture (object + metadata).
mediaAdminRouter.delete("/:mediaId", requireUser(Role.SuperAdmin, Role.Admin), async (req, res) => {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: req.params.mediaId, tenantId: req.auth!.tenantId },
  });
  if (!asset) return res.status(404).json({ error: "Not found" });

  await deleteObjects([asset.storageKey]);
  await prisma.mediaAsset.delete({ where: { id: asset.id } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Retention / cleanup
// ---------------------------------------------------------------------------

const SWEEP_BATCH = 500;

async function purge(where: Prisma.MediaAssetWhereInput): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = await prisma.mediaAsset.findMany({
      where,
      select: { id: true, storageKey: true },
      take: SWEEP_BATCH,
    });
    if (!batch.length) return total;
    // Storage first: if the row delete fails, the next sweep retries both.
    await deleteObjects(batch.map((b) => b.storageKey));
    const { count } = await prisma.mediaAsset.deleteMany({ where: { id: { in: batch.map((b) => b.id) } } });
    total += count;
    if (batch.length < SWEEP_BATCH) return total;
  }
}

/**
 * Deletes media past the retention window and presigned uploads that were
 * never confirmed. Idempotent, so running it on several instances is safe.
 */
export async function runMediaRetention(now = new Date()): Promise<{ expired: number; abandoned: number }> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const pendingBefore = new Date(now.getTime() - PENDING_UPLOAD_TTL_HOURS * 60 * 60 * 1000);

  // Tenants with their own retention window; everyone else gets the global one.
  const overrides = await prisma.tenantPolicy.findMany({
    where: { mediaRetentionDays: { not: null } },
    select: { tenantId: true, mediaRetentionDays: true },
  });

  let expired = 0;
  for (const o of overrides) {
    if (!o.mediaRetentionDays || o.mediaRetentionDays <= 0) continue;
    expired += await purge({ tenantId: o.tenantId, capturedAt: { lt: daysAgo(o.mediaRetentionDays) } });
  }
  expired += await purge({
    tenantId: { notIn: overrides.map((o) => o.tenantId) },
    capturedAt: { lt: daysAgo(RETENTION_DAYS) },
  });
  const abandoned = await purge({ uploaded: false, createdAt: { lt: pendingBefore } });
  return { expired, abandoned };
}

let retentionTimer: NodeJS.Timeout | null = null;

export function startMediaRetentionJob(): void {
  if (retentionTimer || process.env.MEDIA_RETENTION_DISABLED === "true") return;
  const tick = () =>
    runMediaRetention()
      .then((r) => {
        if (r.expired || r.abandoned) console.log(`[media] retention sweep: ${r.expired} expired, ${r.abandoned} abandoned`);
      })
      .catch((e) => console.warn("[media] retention sweep failed:", e.message));
  retentionTimer = setInterval(tick, RETENTION_INTERVAL_MINUTES * 60 * 1000);
  retentionTimer.unref();
  setTimeout(tick, 30_000).unref();
}

// The server imports this module at boot, so the sweep starts with it.
startMediaRetentionJob();
