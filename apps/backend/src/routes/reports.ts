import { Request, Response, Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { Role } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireUser } from "../auth";
import { presignDownload } from "../storage";

export const reportsRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 92;
// Idle events further back than this are not used to reconstruct a period
// that was already open when the requested range starts.
const IDLE_LOOKBACK_MS = DAY_MS;

const viewers = [Role.SuperAdmin, Role.Admin, Role.Manager];
const everyone = [...viewers, Role.Employee];

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const idList = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().min(1)).max(500));

const filterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  userId: z.string().min(1).optional(),
  userIds: idList.optional(),
  deviceId: z.string().min(1).optional(),
  // Shift used to bucket activity into the viewer's local calendar days.
  tzOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  format: z.enum(["json", "csv"]).default("json"),
  // Only honoured for super admins, who can report on any company.
  tenantId: z.string().min(1).optional(),
});

interface Filters {
  tenantId: string;
  from: Date;
  to: Date;
  userIds?: string[];
  deviceId?: string;
  tzOffsetMinutes: number;
  limit: number;
  format: "json" | "csv";
}

/**
 * Parses query filters and pins them to the caller's tenant. Employees are
 * always narrowed to their own data. Sends a 400 and returns null on bad input.
 */
function filters(req: Request, res: Response): Filters | null {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return null;
  }
  const q = parsed.data;
  const auth = req.auth!;

  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - DAY_MS);
  if (from >= to) {
    res.status(400).json({ error: "`from` must be before `to`" });
    return null;
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    res.status(400).json({ error: `Date range is limited to ${MAX_RANGE_DAYS} days` });
    return null;
  }

  let userIds: string[] | undefined;
  if (q.userId || q.userIds) userIds = [...new Set([...(q.userId ? [q.userId] : []), ...(q.userIds ?? [])])];
  if (auth.role === Role.Employee) userIds = [auth.userId];

  return {
    tenantId: auth.role === Role.SuperAdmin && q.tenantId ? q.tenantId : auth.tenantId,
    from,
    to,
    userIds,
    deviceId: q.deviceId,
    tzOffsetMinutes: q.tzOffsetMinutes,
    limit: q.limit,
    format: q.format,
  };
}

function scopeSql(f: Filters, alias = "a"): Prisma.Sql {
  const col = (c: string) => Prisma.raw(`${alias}."${c}"`);
  const parts: Prisma.Sql[] = [Prisma.sql`${col("tenantId")} = ${f.tenantId}`];
  if (f.userIds) parts.push(Prisma.sql`${col("userId")} IN (${Prisma.join(f.userIds)})`);
  if (f.deviceId) parts.push(Prisma.sql`${col("deviceId")} = ${f.deviceId}`);
  return Prisma.join(parts, " AND ");
}

// ---------------------------------------------------------------------------
// Productivity classification
// ---------------------------------------------------------------------------

export type Category = "productive" | "unproductive" | "neutral";

// Default rules until companies can define their own. Matched as lowercase
// substrings against the site domain first, then the app name.
const RULES: Record<Exclude<Category, "neutral">, string[]> = {
  productive: [
    "code", "visual studio", "intellij", "pycharm", "webstorm", "xcode", "android studio",
    "terminal", "iterm", "powershell", "cmd.exe", "excel", "word", "powerpoint",
    "outlook", "teams", "slack", "zoom", "notion", "figma", "jira", "confluence",
    "github", "gitlab", "bitbucket", "stackoverflow", "docs.google", "sheets.google",
    "mail.google", "calendar.google", "atlassian", "linear.app", "trello", "asana",
    "postman", "docker", "sublime", "vim", "emacs",
  ],
  unproductive: [
    "youtube", "netflix", "primevideo", "hotstar", "instagram", "facebook", "twitter",
    "x.com", "tiktok", "reddit", "snapchat", "spotify", "twitch", "steam", "epicgames",
    "9gag", "pinterest", "cricbuzz", "amazon.", "flipkart", "myntra",
  ],
};

export function classify(appName: string | null, domain: string | null): Category {
  for (const target of [domain, appName]) {
    if (!target) continue;
    const t = target.toLowerCase();
    if (RULES.unproductive.some((k) => t.includes(k))) return "unproductive";
    if (RULES.productive.some((k) => t.includes(k))) return "productive";
  }
  return "neutral";
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface UsageRow {
  userId: string | null;
  day: string;
  appName: string | null;
  domain: string | null;
  seconds: number;
}

/** Active seconds grouped by user, local day, app and site domain. */
async function loadUsage(f: Filters): Promise<UsageRow[]> {
  const rows = await prisma.$queryRaw<
    { userId: string | null; day: Date; appName: string | null; domain: string | null; seconds: bigint | number }[]
  >(Prisma.sql`
    SELECT a."userId",
           (a."capturedAt" + make_interval(mins => ${f.tzOffsetMinutes}::int))::date AS day,
           a."appName",
           lower(substring(a."url" from '^(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?(?:www\\.)?([^/:?#]+)')) AS domain,
           SUM(a."activeSeconds") AS seconds
      FROM "ActivityLog" a
     WHERE ${scopeSql(f)}
       AND a."type" = 'APP_ACTIVE'
       AND a."capturedAt" >= ${f.from} AND a."capturedAt" <= ${f.to}
     GROUP BY 1, 2, 3, 4
  `);
  return rows.map((r) => ({
    userId: r.userId,
    day: r.day.toISOString().slice(0, 10),
    appName: r.appName,
    domain: r.domain,
    seconds: Number(r.seconds),
  }));
}

interface IdleRow {
  userId: string | null;
  day: string;
  seconds: number;
}

/**
 * Idle time reconstructed from IDLE_START / IDLE_END pairs per device and
 * clipped to the range. A period still open at the end of a device's events
 * is closed by the next SESSION_END, otherwise at the device's last heartbeat
 * so a machine that went offline mid-idle is not counted idle forever.
 */
async function loadIdle(f: Filters): Promise<IdleRow[]> {
  const events = await prisma.activityLog.findMany({
    where: {
      tenantId: f.tenantId,
      type: { in: ["IDLE_START", "IDLE_END", "SESSION_END"] },
      capturedAt: { gte: new Date(f.from.getTime() - IDLE_LOOKBACK_MS), lte: f.to },
      ...(f.userIds ? { userId: { in: f.userIds } } : {}),
      ...(f.deviceId ? { deviceId: f.deviceId } : {}),
    },
    select: { deviceId: true, userId: true, type: true, capturedAt: true },
    orderBy: [{ deviceId: "asc" }, { capturedAt: "asc" }],
  });
  const deviceIds = [...new Set(events.map((e) => e.deviceId))];
  const lastSeen = new Map(
    (
      await prisma.device.findMany({
        where: { tenantId: f.tenantId, id: { in: deviceIds } },
        select: { id: true, lastSeenAt: true },
      })
    ).map((d) => [d.id, d.lastSeenAt])
  );
  const closeOpen = (deviceId: string, start: Date) => {
    const seen = lastSeen.get(deviceId);
    return seen && seen > start ? seen : start;
  };

  const out = new Map<string, IdleRow>();
  const add = (userId: string | null, start: Date, end: Date) => {
    const s = Math.max(start.getTime(), f.from.getTime());
    const e = Math.min(end.getTime(), f.to.getTime());
    // Split across local day boundaries so daily totals stay correct.
    const offset = f.tzOffsetMinutes * 60_000;
    let cur = s;
    while (cur < e) {
      const localDayStart = Math.floor((cur + offset) / DAY_MS) * DAY_MS - offset;
      const next = Math.min(e, localDayStart + DAY_MS);
      const day = new Date(localDayStart + offset).toISOString().slice(0, 10);
      const key = `${userId ?? ""}|${day}`;
      const row = out.get(key) ?? { userId, day, seconds: 0 };
      row.seconds += Math.round((next - cur) / 1000);
      out.set(key, row);
      cur = next;
    }
  };

  let device: string | null = null;
  let open: { userId: string | null; at: Date } | null = null;
  for (const ev of events) {
    if (ev.deviceId !== device) {
      if (open && device) add(open.userId, open.at, closeOpen(device, open.at));
      device = ev.deviceId;
      open = null;
    }
    if (ev.type === "IDLE_START") {
      if (!open) open = { userId: ev.userId, at: ev.capturedAt };
    } else if (open) {
      add(open.userId, open.at, ev.capturedAt);
      open = null;
    }
  }
  if (open && device) add(open.userId, open.at, closeOpen(device, open.at));

  return [...out.values()];
}

async function loadUsers(f: Filters, ids: Iterable<string | null>) {
  const wanted = [...new Set([...ids].filter((x): x is string => !!x))];
  const users = await prisma.user.findMany({
    where: { tenantId: f.tenantId, id: { in: wanted } },
    select: { id: true, name: true, email: true, role: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

interface Totals {
  activeSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
}

const emptyTotals = (): Totals => ({
  activeSeconds: 0,
  idleSeconds: 0,
  productiveSeconds: 0,
  unproductiveSeconds: 0,
  neutralSeconds: 0,
});

function addUsage(t: Totals, r: UsageRow) {
  t.activeSeconds += r.seconds;
  t[`${classify(r.appName, r.domain)}Seconds`] += r.seconds;
}

function withRatios(t: Totals) {
  const tracked = t.activeSeconds + t.idleSeconds;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    ...t,
    activePercent: pct(t.activeSeconds, tracked),
    productivityPercent: pct(t.productiveSeconds, t.activeSeconds),
  };
}

function topBy(rows: UsageRow[], key: (r: UsageRow) => string | null, limit: number) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + r.seconds);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function topApps(rows: UsageRow[], limit: number) {
  return topBy(rows, (r) => r.appName ?? "Unknown", limit).map(([appName, activeSeconds]) => ({
    appName,
    activeSeconds,
    category: classify(appName, null),
  }));
}

function topSites(rows: UsageRow[], limit: number) {
  return topBy(rows, (r) => r.domain, limit).map(([domain, activeSeconds]) => ({
    domain,
    activeSeconds,
    category: classify(null, domain),
  }));
}

function perEmployee(usage: UsageRow[], idle: IdleRow[]) {
  const m = new Map<string, Totals>();
  const get = (id: string | null) => {
    const k = id ?? "";
    const t = m.get(k) ?? emptyTotals();
    m.set(k, t);
    return t;
  };
  for (const r of usage) addUsage(get(r.userId), r);
  for (const r of idle) get(r.userId).idleSeconds += r.seconds;
  return m;
}

function daysIn(f: Filters): string[] {
  const offset = f.tzOffsetMinutes * 60_000;
  const days: string[] = [];
  let d = Math.floor((f.from.getTime() + offset) / DAY_MS) * DAY_MS;
  const end = f.to.getTime() + offset;
  for (; d < end; d += DAY_MS) days.push(new Date(d).toISOString().slice(0, 10));
  return days;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

type Cell = string | number | boolean | null | undefined;

function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Neutralise spreadsheet formula injection from window titles / app names.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, Cell>[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvCell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

function send(
  res: Response,
  f: Filters,
  name: string,
  body: unknown,
  csvRows: () => Record<string, Cell>[],
  columns?: string[]
) {
  if (f.format === "csv") {
    const stamp = `${f.from.toISOString().slice(0, 10)}_${f.to.toISOString().slice(0, 10)}`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}_${stamp}.csv"`);
    return res.send("﻿" + toCsv(csvRows(), columns));
  }
  res.json(body);
}

const range = (f: Filters) => ({ from: f.from.toISOString(), to: f.to.toISOString() });

/** Wraps async handlers so a failed query becomes a 500 instead of a hang. */
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
    fn(req, res).catch((err) => {
      console.error("[reports]", err);
      if (!res.headersSent) res.status(500).json({ error: "Failed to build report" });
    });

// ---------------------------------------------------------------------------
// Analytics endpoints
// ---------------------------------------------------------------------------

// Company (or filtered group) overview: totals, productivity, top apps/sites.
reportsRouter.get(
  "/overview",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const [usage, idle] = await Promise.all([loadUsage(f), loadIdle(f)]);
    const totals = emptyTotals();
    for (const r of usage) addUsage(totals, r);
    for (const r of idle) totals.idleSeconds += r.seconds;
    const activeUsers = new Set(usage.map((r) => r.userId).filter(Boolean)).size;

    const body = {
      range: range(f),
      totals: withRatios(totals),
      activeUsers,
      topApps: topApps(usage, f.limit),
      topSites: topSites(usage, f.limit),
    };
    send(res, f, "overview", body, () => [{ ...range(f), activeUsers, ...withRatios(totals) }]);
  })
);

// Per-employee summary rows.
reportsRouter.get(
  "/employees",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const [usage, idle] = await Promise.all([loadUsage(f), loadIdle(f)]);
    const byUser = perEmployee(usage, idle);
    const users = await loadUsers(f, byUser.keys());

    const usageByUser = new Map<string, UsageRow[]>();
    for (const r of usage) {
      const k = r.userId ?? "";
      usageByUser.set(k, [...(usageByUser.get(k) ?? []), r]);
    }
    const topAppByUser = new Map<string, string>();
    for (const [id, rows] of usageByUser) {
      const top = topApps(rows, 1)[0];
      if (top) topAppByUser.set(id, top.appName);
    }

    const rows = [...byUser.entries()]
      .map(([id, t]) => {
        const u = users.get(id);
        return {
          userId: id || null,
          name: u?.name ?? (id ? "Unknown user" : "Unassigned device"),
          email: u?.email ?? null,
          topApp: topAppByUser.get(id) ?? null,
          ...withRatios(t),
        };
      })
      .sort((a, b) => b.activeSeconds - a.activeSeconds);

    send(res, f, "employees", { range: range(f), employees: rows }, () => rows);
  })
);

// Detail for one employee: totals, daily trend, top apps and sites.
reportsRouter.get(
  "/employees/:userId",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    if (req.auth!.role === Role.Employee && req.params.userId !== req.auth!.userId) {
      return res.status(403).json({ error: "Employees can only view their own report" });
    }
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId, tenantId: f.tenantId },
      select: { id: true, name: true, email: true, role: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const scoped = { ...f, userIds: [user.id] };
    const [usage, idle] = await Promise.all([loadUsage(scoped), loadIdle(scoped)]);
    const totals = perEmployee(usage, idle).get(user.id) ?? emptyTotals();
    const daily = dailySeries(scoped, usage, idle);

    const body = {
      range: range(f),
      user,
      totals: withRatios(totals),
      daily,
      topApps: topApps(usage, f.limit),
      topSites: topSites(usage, f.limit),
    };
    send(res, f, `employee_${user.id}`, body, () => daily);
  })
);

// Aggregate for an ad-hoc team, given as `userIds=a,b,c`, with member rows.
reportsRouter.get(
  "/team",
  requireUser(...viewers),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    if (!f.userIds?.length) return res.status(400).json({ error: "Pass the team's members as userIds" });

    const [usage, idle] = await Promise.all([loadUsage(f), loadIdle(f)]);
    const byUser = perEmployee(usage, idle);
    const users = await loadUsers(f, f.userIds);
    const totals = emptyTotals();
    for (const t of byUser.values()) {
      for (const k of Object.keys(totals) as (keyof Totals)[]) totals[k] += t[k];
    }

    const members = f.userIds
      .filter((id) => users.has(id))
      .map((id) => ({
        userId: id,
        name: users.get(id)!.name,
        email: users.get(id)!.email,
        ...withRatios(byUser.get(id) ?? emptyTotals()),
      }))
      .sort((a, b) => b.activeSeconds - a.activeSeconds);

    const body = {
      range: range(f),
      totals: withRatios(totals),
      members,
      topApps: topApps(usage, f.limit),
      topSites: topSites(usage, f.limit),
    };
    send(res, f, "team", body, () => members);
  })
);

reportsRouter.get(
  "/apps",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const rows = topApps(await loadUsage(f), f.limit);
    send(res, f, "top_apps", { range: range(f), apps: rows }, () => rows);
  })
);

reportsRouter.get(
  "/sites",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const rows = topSites(await loadUsage(f), f.limit);
    send(res, f, "top_sites", { range: range(f), sites: rows }, () => rows);
  })
);

function dailySeries(f: Filters, usage: UsageRow[], idle: IdleRow[]) {
  const byDay = new Map(daysIn(f).map((d) => [d, emptyTotals()]));
  const get = (d: string) => {
    const t = byDay.get(d) ?? emptyTotals();
    byDay.set(d, t);
    return t;
  };
  for (const r of usage) addUsage(get(r.day), r);
  for (const r of idle) get(r.day).idleSeconds += r.seconds;
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, t]) => ({ day, ...withRatios(t) }));
}

// Productive / unproductive / neutral split, overall and per day.
reportsRouter.get(
  "/productivity",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const [usage, idle] = await Promise.all([loadUsage(f), loadIdle(f)]);
    const totals = emptyTotals();
    for (const r of usage) addUsage(totals, r);
    for (const r of idle) totals.idleSeconds += r.seconds;
    const daily = dailySeries(f, usage, idle);

    const body = {
      range: range(f),
      totals: withRatios(totals),
      daily,
      unproductiveApps: topApps(usage, 500).filter((a) => a.category === "unproductive").slice(0, f.limit),
      unproductiveSites: topSites(usage, 500).filter((s) => s.category === "unproductive").slice(0, f.limit),
    };
    send(res, f, "productivity", body, () => daily);
  })
);

// Per-employee, per-day active/idle rows. Mostly useful as a CSV export.
reportsRouter.get(
  "/timesheet",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const [usage, idle] = await Promise.all([loadUsage(f), loadIdle(f)]);
    const cells = new Map<string, { userId: string | null; day: string; t: Totals }>();
    const get = (userId: string | null, day: string) => {
      const k = `${userId ?? ""}|${day}`;
      const c = cells.get(k) ?? { userId, day, t: emptyTotals() };
      cells.set(k, c);
      return c.t;
    };
    for (const r of usage) addUsage(get(r.userId, r.day), r);
    for (const r of idle) get(r.userId, r.day).idleSeconds += r.seconds;
    const users = await loadUsers(f, [...cells.values()].map((c) => c.userId));

    const rows = [...cells.values()]
      .map((c) => ({
        day: c.day,
        userId: c.userId,
        name: c.userId ? users.get(c.userId)?.name ?? "Unknown user" : "Unassigned device",
        email: c.userId ? users.get(c.userId)?.email ?? null : null,
        ...withRatios(c.t),
      }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));

    send(res, f, "timesheet", { range: range(f), rows }, () => rows);
  })
);

// ---------------------------------------------------------------------------
// Raw data endpoints
// ---------------------------------------------------------------------------

// Devices in the caller's company, with last-seen heartbeat.
reportsRouter.get(
  "/devices",
  requireUser(...viewers),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const devices = await prisma.device.findMany({
      where: { tenantId: f.tenantId, ...(f.userIds ? { userId: { in: f.userIds } } : {}) },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { lastSeenAt: "desc" },
    });
    send(res, f, "devices", devices, () =>
      devices.map((d) => ({
        id: d.id,
        hostname: d.hostname,
        platform: d.platform,
        osVersion: d.osVersion,
        agentVersion: d.agentVersion,
        enrolled: d.enrolled,
        lastSeenAt: d.lastSeenAt?.toISOString(),
        userName: d.user?.name,
        userEmail: d.user?.email,
      }))
    );
  })
);

// Per-app time summary. Kept for the dashboard; `/apps` is the richer version.
reportsRouter.get(
  "/activity/summary",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const rows = topApps(await loadUsage(f), 50).map(({ appName, activeSeconds }) => ({ appName, activeSeconds }));
    send(res, f, "activity_summary", rows, () => rows);
  })
);

// Raw activity timeline for one user/device.
reportsRouter.get(
  "/activity",
  requireUser(...everyone),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const logs = await prisma.activityLog.findMany({
      where: {
        tenantId: f.tenantId,
        capturedAt: { gte: f.from, lte: f.to },
        ...(f.userIds ? { userId: { in: f.userIds } } : {}),
        ...(f.deviceId ? { deviceId: f.deviceId } : {}),
      },
      orderBy: { capturedAt: "desc" },
      take: f.format === "csv" ? 50_000 : 500,
    });
    send(res, f, "activity", logs, () =>
      logs.map((l) => ({
        capturedAt: l.capturedAt.toISOString(),
        userId: l.userId,
        deviceId: l.deviceId,
        type: l.type,
        appName: l.appName,
        windowTitle: l.windowTitle,
        url: l.url,
        activeSeconds: l.activeSeconds,
      }))
    );
  })
);

const mediaKindSchema = z.enum(["SCREENSHOT", "RECORDING"]).optional();

// Screenshots / recordings with short-lived playback URLs.
reportsRouter.get(
  "/media",
  requireUser(...viewers),
  handle(async (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const kind = mediaKindSchema.safeParse(req.query.kind);
    if (!kind.success) return res.status(400).json({ error: "kind must be SCREENSHOT or RECORDING" });

    const assets = await prisma.mediaAsset.findMany({
      where: {
        tenantId: f.tenantId,
        uploaded: true,
        capturedAt: { gte: f.from, lte: f.to },
        ...(kind.data ? { kind: kind.data } : {}),
        ...(f.userIds ? { userId: { in: f.userIds } } : {}),
        ...(f.deviceId ? { deviceId: f.deviceId } : {}),
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
  })
);
