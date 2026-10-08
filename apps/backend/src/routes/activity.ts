import { Router } from "express";
import { z } from "zod";
import { ActivityEvent, activityEventSchema } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireDevice } from "../auth";

export const activityRouter = Router();

// Same bounds as the shared activityBatchSchema, but events are validated one
// by one below so a single bad event never rejects (and, since the agent
// re-queues failed batches, endlessly re-sends) the whole batch.
const MAX_EVENTS_PER_BATCH = 500;
const looseBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH),
});

// Agent clocks drift; tolerate a little skew but refuse obviously wrong times.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
// Offline agents may upload a backlog, but nothing older than this.
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Keep rows small: window titles and URLs can be arbitrarily long.
const MAX_APP_NAME = 255;
const MAX_WINDOW_TITLE = 1024;
const MAX_URL = 2048;

const SESSION_EVENTS = new Set<ActivityEvent["type"]>(["SESSION_START", "SESSION_END"]);

interface RejectedEvent {
  index: number;
  clientEventId?: string;
  reason: string;
}

function clip(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Drops embedded credentials and fragments from browser URLs before storing them. */
function sanitizeUrl(raw: string | undefined): string | null {
  const value = clip(raw, 8192);
  if (!value) return null;
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    u.hash = "";
    return clip(u.toString(), MAX_URL);
  } catch {
    // Not a parseable URL (e.g. a bare hostname from some browsers); keep as-is.
    return clip(value, MAX_URL);
  }
}

function idOf(raw: unknown): string | undefined {
  if (raw && typeof raw === "object" && "clientEventId" in raw) {
    const id = (raw as { clientEventId: unknown }).clientEventId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

// Agent uploads a batch of activity samples (active app/window, browser URL,
// idle transitions). clientEventId makes retries safe.
//
// Response: { accepted, duplicates, dropped, rejected[] }
//  - accepted:   new rows stored
//  - duplicates: events already stored by an earlier (retried) upload
//  - dropped:    valid events discarded because tenant policy disables them
//  - rejected:   invalid events, with the reason; the agent should not retry these
// Any 2xx means the agent can clear the batch from its buffer.
activityRouter.post("/", requireDevice, async (req, res) => {
  const parsed = looseBatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { deviceId, tenantId } = req.device!;

  try {
    const [device, policy] = await Promise.all([
      prisma.device.findFirst({
        where: { id: deviceId, tenantId },
        select: { id: true, userId: true },
      }),
      prisma.tenantPolicy.findUnique({
        where: { tenantId },
        select: {
          monitoringEnabled: true,
          activityTrackingEnabled: true,
          activitySampleSeconds: true,
        },
      }),
    ]);
    if (!device) return res.status(401).json({ error: "Unknown device" });

    const monitoringEnabled = policy?.monitoringEnabled ?? true;
    const activityTrackingEnabled = policy?.activityTrackingEnabled ?? true;
    // One sample can't legitimately cover much more than the sampling interval;
    // larger values usually mean the machine slept or sat idle between samples.
    const maxActiveSeconds = Math.max(60, (policy?.activitySampleSeconds ?? 30) * 2);

    const now = Date.now();
    const rejected: RejectedEvent[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    let inBatchDuplicates = 0;

    const rows = [];
    for (const [index, raw] of parsed.data.events.entries()) {
      const ev = activityEventSchema.safeParse(raw);
      if (!ev.success) {
        const issue = ev.error.issues[0];
        rejected.push({
          index,
          clientEventId: idOf(raw),
          reason: issue ? `${issue.path.join(".") || "event"}: ${issue.message}` : "invalid event",
        });
        continue;
      }
      const e = ev.data;

      const capturedAt = new Date(e.capturedAt);
      const ts = capturedAt.getTime();
      if (Number.isNaN(ts)) {
        rejected.push({ index, clientEventId: e.clientEventId, reason: "capturedAt: invalid timestamp" });
        continue;
      }
      if (ts > now + MAX_FUTURE_SKEW_MS) {
        rejected.push({ index, clientEventId: e.clientEventId, reason: "capturedAt: in the future" });
        continue;
      }
      if (ts < now - MAX_EVENT_AGE_MS) {
        rejected.push({ index, clientEventId: e.clientEventId, reason: "capturedAt: too old" });
        continue;
      }

      if (seen.has(e.clientEventId)) {
        inBatchDuplicates++;
        continue;
      }
      seen.add(e.clientEventId);

      // Enforce policy server-side too, in case an agent is running a stale config.
      if (!monitoringEnabled || (!activityTrackingEnabled && !SESSION_EVENTS.has(e.type))) {
        dropped++;
        continue;
      }

      const isAppSample = e.type === "APP_ACTIVE";
      rows.push({
        tenantId,
        deviceId: device.id,
        userId: device.userId,
        clientEventId: e.clientEventId,
        type: e.type,
        appName: clip(e.appName, MAX_APP_NAME),
        windowTitle: clip(e.windowTitle, MAX_WINDOW_TITLE),
        url: sanitizeUrl(e.url),
        activeSeconds: isAppSample ? Math.min(e.activeSeconds ?? 0, maxActiveSeconds) : 0,
        capturedAt,
      });
    }

    // One round trip for the whole batch; skipDuplicates keeps the ingest
    // idempotent across network retries (unique clientEventId).
    const result = rows.length
      ? await prisma.activityLog.createMany({ data: rows, skipDuplicates: true })
      : { count: 0 };

    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

    res.json({
      accepted: result.count,
      duplicates: rows.length - result.count + inBatchDuplicates,
      dropped,
      rejected,
    });
  } catch (err) {
    // 5xx tells the agent to keep the batch and retry later.
    console.error("[activity] ingest failed", { tenantId, deviceId, err });
    res.status(500).json({ error: "Failed to store activity" });
  }
});
