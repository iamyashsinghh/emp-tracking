import { Router } from "express";
import { mediaUploadRequestSchema } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireDevice } from "../auth";
import { presignUpload } from "../storage";

export const mediaRouter = Router();

function extFor(kind: string, contentType: string): string {
  if (kind === "RECORDING") return contentType.includes("mp4") ? "mp4" : "webm";
  return contentType.includes("png") ? "png" : "jpg";
}

// Agent requests a presigned PUT, uploads bytes straight to object storage,
// then confirms. The server never proxies the media bytes.
mediaRouter.post("/upload-url", requireDevice, async (req, res) => {
  const parsed = mediaUploadRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const device = await prisma.device.findUnique({ where: { id: req.device!.deviceId } });
  if (!device) return res.status(401).json({ error: "Unknown device" });

  const captured = new Date(parsed.data.capturedAt);
  const day = captured.toISOString().slice(0, 10);
  const ext = extFor(parsed.data.kind, parsed.data.contentType);
  const key = `${device.tenantId}/${device.id}/${parsed.data.kind.toLowerCase()}/${day}/${captured.getTime()}.${ext}`;

  const asset = await prisma.mediaAsset.create({
    data: {
      tenantId: device.tenantId,
      deviceId: device.id,
      userId: device.userId,
      kind: parsed.data.kind,
      storageKey: key,
      contentType: parsed.data.contentType,
      durationSeconds: parsed.data.durationSeconds,
      capturedAt: captured,
    },
  });

  const { uploadUrl, requiredHeaders } = await presignUpload(key, parsed.data.contentType);
  res.json({ mediaId: asset.id, uploadUrl, requiredHeaders });
});

// Agent confirms the bytes landed so the dashboard can show the asset.
mediaRouter.post("/:mediaId/confirm", requireDevice, async (req, res) => {
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: req.params.mediaId, tenantId: req.device!.tenantId },
  });
  if (!asset) return res.status(404).json({ error: "Not found" });

  const updated = await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { uploaded: true, sizeBytes: req.body?.sizeBytes ?? null },
  });
  res.json({ ok: true, mediaId: updated.id });
});
