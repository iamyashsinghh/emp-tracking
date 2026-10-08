import { Router } from "express";
import { activityBatchSchema } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireDevice } from "../auth";

export const activityRouter = Router();

// Agent uploads a batch of activity samples. clientEventId makes retries safe.
activityRouter.post("/", requireDevice, async (req, res) => {
  const parsed = activityBatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const device = await prisma.device.findUnique({ where: { id: req.device!.deviceId } });
  if (!device) return res.status(401).json({ error: "Unknown device" });

  const rows = parsed.data.events.map((e) => ({
    tenantId: req.device!.tenantId,
    deviceId: device.id,
    userId: device.userId,
    clientEventId: e.clientEventId,
    type: e.type,
    appName: e.appName,
    windowTitle: e.windowTitle,
    url: e.url,
    activeSeconds: e.activeSeconds ?? 0,
    capturedAt: new Date(e.capturedAt),
  }));

  // skipDuplicates keeps the ingest idempotent across network retries.
  const result = await prisma.activityLog.createMany({ data: rows, skipDuplicates: true });
  await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

  res.json({ accepted: result.count });
});
