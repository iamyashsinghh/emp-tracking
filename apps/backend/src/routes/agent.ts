import { Router } from "express";
import { devicePolicySchema, enrollDeviceSchema, DevicePolicy } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireDevice, signDeviceToken } from "../auth";

export const agentRouter = Router();

const DEFAULT_POLICY: DevicePolicy = devicePolicySchema.parse({});

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

  const policy: DevicePolicy = policyRow
    ? devicePolicySchema.parse({
        monitoringEnabled: policyRow.monitoringEnabled,
        activityTrackingEnabled: policyRow.activityTrackingEnabled,
        activitySampleSeconds: policyRow.activitySampleSeconds,
        idleThresholdSeconds: policyRow.idleThresholdSeconds,
        screenshotsEnabled: policyRow.screenshotsEnabled,
        screenshotIntervalSeconds: policyRow.screenshotIntervalSeconds,
        screenshotBlur: policyRow.screenshotBlur,
        screenRecordingEnabled: policyRow.screenRecordingEnabled,
        recordingChunkSeconds: policyRow.recordingChunkSeconds,
        recordingFps: policyRow.recordingFps,
        showTrayIcon: policyRow.showTrayIcon,
        notifyEmployeeOnStart: policyRow.notifyEmployeeOnStart,
        workingHoursStart: policyRow.workingHoursStart ?? undefined,
        workingHoursEnd: policyRow.workingHoursEnd ?? undefined,
      })
    : DEFAULT_POLICY;

  res.json({
    deviceId: req.device!.deviceId,
    tenantId: req.device!.tenantId,
    policy,
    serverTime: new Date().toISOString(),
  });
});
