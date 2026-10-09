import { Router } from "express";
import { devicePolicySchema, enrollDeviceSchema, DevicePolicy } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireDevice, signDeviceToken } from "../auth";

export const agentRouter = Router();

const DEFAULT_POLICY: DevicePolicy = devicePolicySchema.parse({});

/**
 * Everything the dashboard saved, in the shape the agent reads. Copies every
 * field the shared schema knows, so a new policy setting reaches devices
 * without touching this route (a hand-written list here once dropped
 * activeWindowOnly, excludedApps and the daily caps, and agents silently ran on
 * the defaults).
 */
export function policyFromRow(row: Record<string, unknown>): DevicePolicy {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(devicePolicySchema.shape)) {
    // null means "not set" in the database; the schema default applies.
    if (row[key] !== null && row[key] !== undefined) picked[key] = row[key];
  }
  return devicePolicySchema.parse(picked);
}

// First run: the agent exchanges its one-time enrollment token for a
// long-lived device token. The token is invalidated after use.
agentRouter.post("/enroll", async (req, res) => {
  const parsed = enrollDeviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const device = await prisma.device.findUnique({
    where: { enrollmentToken: parsed.data.enrollmentToken },
  });
  if (!device) return res.status(401).json({ error: "Invalid enrollment token" });
  if (device.enrolled) return res.status(409).json({ error: "Token already used" });

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      enrolled: true,
      hostname: parsed.data.hostname,
      platform: parsed.data.platform,
      osVersion: parsed.data.osVersion,
      agentVersion: parsed.data.agentVersion,
      lastSeenAt: new Date(),
    },
  });

  const token = signDeviceToken({ deviceId: updated.id, tenantId: updated.tenantId });
  res.json({ deviceId: updated.id, tenantId: updated.tenantId, token });
});

// The agent polls this to pick up policy changes (interval, recording on/off…).
agentRouter.get("/config", requireDevice, async (req, res) => {
  const policyRow = await prisma.tenantPolicy.findUnique({
    where: { tenantId: req.device!.tenantId },
  });
  await prisma.device.update({
    where: { id: req.device!.deviceId },
    data: { lastSeenAt: new Date() },
  });

  const policy: DevicePolicy = policyRow ? policyFromRow(policyRow) : DEFAULT_POLICY;

  res.json({
    deviceId: req.device!.deviceId,
    tenantId: req.device!.tenantId,
    policy,
    serverTime: new Date().toISOString(),
  });
});
