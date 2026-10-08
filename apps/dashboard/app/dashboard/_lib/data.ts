// Data types and helpers for the devices & activity views. The backend scopes
// every /api/reports call to the tenant in the caller's token, so these views
// always show the active company's data only.
import { api, getToken } from "../../../lib/api";

export interface Device {
  id: string;
  tenantId: string;
  userId: string | null;
  enrolled: boolean;
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

export type ActivityType = "APP_ACTIVE" | "IDLE_START" | "IDLE_END" | "SESSION_START" | "SESSION_END";

export interface ActivityLog {
  id: string;
  deviceId: string;
  userId: string | null;
  type: ActivityType;
  appName: string | null;
  windowTitle: string | null;
  url: string | null;
  activeSeconds: number;
  capturedAt: string;
}

export interface AppSummary {
  appName: string;
  activeSeconds: number;
}

export interface SiteSummary {
  site: string;
  activeSeconds: number;
  category?: "productive" | "unproductive" | "neutral";
}

export interface TimeRange {
  from: Date;
  to: Date;
}

export const RANGES = [
  { key: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { key: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

export function rangeFor(key: RangeKey): TimeRange {
  const to = new Date();
  const ms = RANGES.find((r) => r.key === key)!.ms;
  return { from: new Date(to.getTime() - ms), to };
}

function query(params: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function fetchDevices() {
  return api<Device[]>("/api/reports/devices");
}

export function fetchAppSummary(range: TimeRange, userId?: string) {
  return api<AppSummary[]>(
    `/api/reports/activity/summary${query({ from: range.from.toISOString(), to: range.to.toISOString(), userId })}`
  );
}

export function fetchActivity(range: TimeRange, filter: { userId?: string; deviceId?: string } = {}) {
  return api<ActivityLog[]>(
    `/api/reports/activity${query({ from: range.from.toISOString(), to: range.to.toISOString(), ...filter })}`
  );
}

// Exact per-site totals, aggregated server-side over every sample in range.
export function fetchSiteSummary(range: TimeRange, filter: { userId?: string; deviceId?: string } = {}) {
  return api<SiteSummary[]>(
    `/api/reports/sites/summary${query({ from: range.from.toISOString(), to: range.to.toISOString(), ...filter })}`
  );
}

// --- Tenant context ---------------------------------------------------------

export interface TokenClaims {
  /** Company being viewed; every reports call is scoped to it. */
  tenantId: string;
  tenantName: string | null;
  role: string;
  email: string;
}

// The active company comes from the dashboard session that lib/api.ts keeps in
// localStorage (it sends that company as X-Tenant-Id on every request). With
// no session record, fall back to the signed-in token's own company.
export function activeTenant(): TokenClaims | null {
  try {
    const raw = window.localStorage.getItem("emptrack_session");
    if (raw) {
      const s = JSON.parse(raw) as {
        activeTenantId?: string;
        tenants?: { id: string; name: string }[];
        user?: { email: string; role: string; tenantId: string };
      };
      const tenantId = s.activeTenantId ?? s.user?.tenantId;
      if (tenantId && s.user) {
        const name = s.tenants?.find((t) => t.id === tenantId)?.name ?? null;
        return { tenantId, tenantName: name, role: s.user.role, email: s.user.email };
      }
    }
  } catch {
    // Fall through to the token.
  }
  const token = getToken();
  if (!token) return null;
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload));
    return { tenantId: claims.tenantId, tenantName: null, role: claims.role, email: claims.email };
  } catch {
    return null;
  }
}

// --- Device status ----------------------------------------------------------

// The agent flushes activity every 30s and polls config every 60s, so a device
// that has not been heard from in 2 minutes is no longer live.
const ONLINE_MS = 2 * 60 * 1000;
const AWAY_MS = 15 * 60 * 1000;

export type DeviceStatus = "online" | "idle" | "away" | "offline" | "pending";

export function deviceStatus(d: Device, lastEvent?: ActivityLog, now = Date.now()): DeviceStatus {
  if (!d.enrolled) return "pending";
  if (!d.lastSeenAt) return "offline";
  const age = now - new Date(d.lastSeenAt).getTime();
  if (age <= ONLINE_MS) return lastEvent?.type === "IDLE_START" ? "idle" : "online";
  if (age <= AWAY_MS) return "away";
  return "offline";
}

export const STATUS_META: Record<DeviceStatus, { label: string; color: string }> = {
  online: { label: "Online", color: "#34d399" },
  idle: { label: "Idle", color: "#fbbf24" },
  away: { label: "Away", color: "#fb923c" },
  offline: { label: "Offline", color: "#64748b" },
  pending: { label: "Not enrolled", color: "#818cf8" },
};

// --- Aggregation ------------------------------------------------------------

export function siteOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function topApps(logs: ActivityLog[], limit = 10): AppSummary[] {
  const totals = new Map<string, number>();
  for (const l of logs) {
    if (l.type !== "APP_ACTIVE") continue;
    const k = l.appName ?? "Unknown";
    totals.set(k, (totals.get(k) ?? 0) + l.activeSeconds);
  }
  return [...totals.entries()]
    .map(([appName, activeSeconds]) => ({ appName, activeSeconds }))
    .sort((a, b) => b.activeSeconds - a.activeSeconds)
    .slice(0, limit);
}

// Latest event per device, used to tell "online" from "online but idle".
export function latestByDevice(logs: ActivityLog[]) {
  const out: Record<string, ActivityLog | undefined> = {};
  for (const l of logs) {
    const cur = out[l.deviceId];
    if (!cur || l.capturedAt > cur.capturedAt) out[l.deviceId] = l;
  }
  return out;
}

// --- Formatting -------------------------------------------------------------

export function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export function relativeTime(iso: string | null, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
