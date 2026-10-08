import { Router } from "express";
import { Role } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireUser } from "../auth";
import { presignDownload } from "../storage";

export const reportsRouter = Router();

function range(req: { query: Record<string, unknown> }) {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from
    ? new Date(String(req.query.from))
    : new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from, to };
}

// Devices in the caller's company, with last-seen heartbeat.
reportsRouter.get("/devices", requireUser(Role.SuperAdmin, Role.Admin, Role.Manager), async (req, res) => {
  const devices = await prisma.device.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { lastSeenAt: "desc" },
  });
  res.json(devices);
});

// Per-app time summary for the tenant over a time range.
reportsRouter.get("/activity/summary", requireUser(Role.SuperAdmin, Role.Admin, Role.Manager), async (req, res) => {
  const { from, to } = range(req);
  const grouped = await prisma.activityLog.groupBy({
    by: ["appName"],
    where: {
      tenantId: req.auth!.tenantId,
      type: "APP_ACTIVE",
      capturedAt: { gte: from, lte: to },
      ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
    },
    _sum: { activeSeconds: true },
    orderBy: { _sum: { activeSeconds: "desc" } },
    take: 50,
  });
  res.json(
    grouped.map((g) => ({ appName: g.appName ?? "Unknown", activeSeconds: g._sum.activeSeconds ?? 0 }))
  );
});

// Raw activity timeline for one user/device.
reportsRouter.get("/activity", requireUser(Role.SuperAdmin, Role.Admin, Role.Manager), async (req, res) => {
  const { from, to } = range(req);
  const logs = await prisma.activityLog.findMany({
    where: {
      tenantId: req.auth!.tenantId,
      capturedAt: { gte: from, lte: to },
      ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
      ...(req.query.deviceId ? { deviceId: String(req.query.deviceId) } : {}),
    },
    orderBy: { capturedAt: "desc" },
    take: 500,
  });
  res.json(logs);
});

// Screenshots / recordings with short-lived playback URLs.
reportsRouter.get("/media", requireUser(Role.SuperAdmin, Role.Admin, Role.Manager), async (req, res) => {
  const { from, to } = range(req);
  const assets = await prisma.mediaAsset.findMany({
    where: {
      tenantId: req.auth!.tenantId,
      uploaded: true,
      capturedAt: { gte: from, lte: to },
      ...(req.query.kind ? { kind: String(req.query.kind) as "SCREENSHOT" | "RECORDING" } : {}),
      ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
      ...(req.query.deviceId ? { deviceId: String(req.query.deviceId) } : {}),
    },
    orderBy: { capturedAt: "desc" },
    take: 200,
  });

  const withUrls = await Promise.all(
    assets.map(async (a) => ({
      id: a.id,
      kind: a.kind,
      capturedAt: a.capturedAt,
      durationSeconds: a.durationSeconds,
      contentType: a.contentType,
      url: await presignDownload(a.storageKey),
    }))
  );
  res.json(withUrls);
});
