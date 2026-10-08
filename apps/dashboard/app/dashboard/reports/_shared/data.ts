"use client";

import { api } from "../../../../lib/api";

/**
 * Data helpers for the media gallery and the reports views.
 *
 * These wrap the shared `api()` client with the /api/media and
 * /api/reports endpoints.
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
  userId: string | null;
  deviceId: string;
}

export interface MediaPage {
  items: MediaItem[];
  nextCursor: string | null;
}

export interface AppSummary {
  appName: string;
  activeSeconds: number;
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

/** Page size requested from /api/media. */
export const MEDIA_PAGE_SIZE = 100;

function qs(params: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function listEmployees() {
  return api<Employee[]>("/api/users?take=200");
}

/** One page of media, newest first; pass `nextCursor` back for older items. */
export function listMedia(opts: { range: Range; userId?: string; kind?: string; cursor?: string | null }) {
  return api<MediaPage>(
    `/api/media${qs({
      from: opts.range.from.toISOString(),
      to: opts.range.to.toISOString(),
      userId: opts.userId,
      kind: opts.kind,
      limit: String(MEDIA_PAGE_SIZE),
      cursor: opts.cursor ?? undefined,
    })}`
  );
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
 * Active vs idle per day and employee, bucketed into the viewer's local days.
 * The server only returns days with activity; callers fill gaps with 0.
 */
export function dailyActivity(range: Range, userId?: string) {
  return api<DailyActivity[]>(
    `/api/reports/activity/daily${qs({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      userId,
      // Minutes east of UTC, e.g. 330 for IST.
      tzOffsetMinutes: String(-range.from.getTimezoneOffset()),
    })}`
  );
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
