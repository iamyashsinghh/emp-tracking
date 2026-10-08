"use client";

import { api } from "../../../../lib/api";

/**
 * Data helpers for the media gallery and the reports views.
 *
 * These wrap the shared `api()` client with the report endpoints the backend
 * exposes today. Where an aggregate endpoint does not exist yet, the numbers
 * are derived client-side from raw activity and flagged as partial when a
 * page of raw events was truncated by the server's row cap.
 */

export interface Employee {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
}

export interface MediaItem {
  id: string;
  kind: "SCREENSHOT" | "RECORDING";
  capturedAt: string;
  url: string;
  durationSeconds: number | null;
  contentType?: string;
  // Present on /api/media; absent on the legacy /api/reports/media feed.
  userId?: string | null;
  deviceId?: string;
}

export interface MediaPage {
  items: MediaItem[];
  nextCursor: string | null;
}

export interface AppSummary {
  appName: string;
  activeSeconds: number;
}

interface ActivityLog {
  id: string;
  deviceId: string;
  userId: string | null;
  type: "APP_ACTIVE" | "IDLE_START" | "IDLE_END" | "SESSION_START" | "SESSION_END";
  appName: string | null;
  activeSeconds: number;
  capturedAt: string;
}

/** One row per (day, employee): the unit every report chart and CSV is built from. */
export interface DailyActivity {
  day: string; // YYYY-MM-DD, local time
  userId: string | null;
  activeSeconds: number;
  idleSeconds: number;
}

export interface Range {
  from: Date;
  to: Date;
}

/** Server-side row cap on /api/reports/activity and /api/reports/media. */
export const ACTIVITY_PAGE_CAP = 500;
export const MEDIA_PAGE_CAP = 200;
/** Page size requested from /api/media. */
export const MEDIA_PAGE_SIZE = 100;

function qs(params: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function listEmployees() {
  return api<Employee[]>("/api/users");
}

/**
 * One page of media, newest first. Uses the cursor-paginated /api/media and
 * falls back to the legacy /api/reports/media array (no cursor; callers page
 * by moving `to` back) until /api/media is deployed.
 */
export async function listMedia(opts: {
  range: Range;
  userId?: string;
  kind?: string;
  cursor?: string | null;
}): Promise<MediaPage & { legacy: boolean }> {
  const params = {
    from: opts.range.from.toISOString(),
    to: opts.range.to.toISOString(),
    userId: opts.userId,
    kind: opts.kind,
  };
  try {
    const page = await api<MediaPage>(
      `/api/media${qs({ ...params, limit: String(MEDIA_PAGE_SIZE), cursor: opts.cursor ?? undefined })}`
    );
    if (page && Array.isArray(page.items)) return { ...page, legacy: false };
  } catch {
    // Not deployed yet: use the legacy feed below.
  }
  const items = await api<MediaItem[]>(`/api/reports/media${qs(params)}`);
  return { items, nextCursor: null, legacy: true };
}

export function topApps(range: Range, userId?: string) {
  return api<AppSummary[]>(
    `/api/reports/activity/summary${qs({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      userId,
    })}`
  );
}

// ---------------------------------------------------------------------------
// Active vs idle per day
// ---------------------------------------------------------------------------

export function dayKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local-midnight day windows covering the range, clipped to it. */
export function dayWindows(range: Range): Range[] {
  const out: Range[] = [];
  let cursor = new Date(range.from);
  while (cursor < range.to) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    out.push({ from: cursor, to: next < range.to ? next : range.to });
    cursor = next;
  }
  return out;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Turn one window of raw events into per-employee active/idle seconds.
 * Active time is the sum of APP_ACTIVE samples. Idle time pairs IDLE_START
 * with the next IDLE_END on the same device; an idle span still open at the
 * end of the window is closed at the window end (or now, if sooner).
 */
export function summarizeWindow(logs: ActivityLog[], window: Range): DailyActivity[] {
  const byUser = new Map<string, DailyActivity>();
  const day = dayKey(window.from);
  const row = (userId: string | null) => {
    const key = userId ?? "";
    let r = byUser.get(key);
    if (!r) {
      r = { day, userId, activeSeconds: 0, idleSeconds: 0 };
      byUser.set(key, r);
    }
    return r;
  };

  const sorted = [...logs].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const openIdle = new Map<string, { at: number; userId: string | null }>();
  const windowEnd = Math.min(window.to.getTime(), Date.now());

  for (const log of sorted) {
    const at = new Date(log.capturedAt).getTime();
    if (log.type === "APP_ACTIVE") {
      row(log.userId).activeSeconds += log.activeSeconds || 0;
    } else if (log.type === "IDLE_START") {
      if (!openIdle.has(log.deviceId)) openIdle.set(log.deviceId, { at, userId: log.userId });
    } else if (log.type === "IDLE_END" || log.type === "SESSION_END") {
      const open = openIdle.get(log.deviceId);
      if (open) {
        row(open.userId).idleSeconds += Math.max(0, Math.round((at - open.at) / 1000));
        openIdle.delete(log.deviceId);
      }
    }
  }
  for (const open of openIdle.values()) {
    row(open.userId).idleSeconds += Math.max(0, Math.round((windowEnd - open.at) / 1000));
  }
  return [...byUser.values()];
}

/**
 * Active vs idle per day and employee. Prefers the aggregate endpoint
 * (`/api/reports/activity/daily`, which returns only days with activity)
 * and falls back to deriving it from raw
 * activity one day at a time. `partial` is true when any day hit the raw
 * row cap, so the totals undercount.
 */
export async function dailyActivity(
  range: Range,
  userId?: string
): Promise<{ rows: DailyActivity[]; partial: boolean }> {
  try {
    const rows = await api<DailyActivity[]>(
      `/api/reports/activity/daily${qs({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        userId,
        // Bucket into the viewer's local days (e.g. 330 for IST).
        tzOffsetMinutes: String(-range.from.getTimezoneOffset()),
      })}`
    );
    if (Array.isArray(rows)) return { rows, partial: false };
  } catch {
    // Endpoint not deployed yet: derive it below.
  }

  const windows = dayWindows(range);
  let partial = false;
  const perDay = await mapLimit(windows, 4, async (w) => {
    const logs = await api<ActivityLog[]>(
      `/api/reports/activity${qs({ from: w.from.toISOString(), to: w.to.toISOString(), userId })}`
    );
    if (logs.length >= ACTIVITY_PAGE_CAP) partial = true;
    return summarizeWindow(logs, w);
  });
  return { rows: perDay.flat(), partial };
}

// ---------------------------------------------------------------------------
// Formatting & export
// ---------------------------------------------------------------------------

export function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  // Guard against spreadsheet formula injection from app names / window titles.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
