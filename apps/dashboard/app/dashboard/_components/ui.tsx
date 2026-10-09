"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearToken, getToken } from "../../../lib/api";
import {
  ActivityLog,
  activeTenant,
  Device,
  deviceStatus,
  DeviceStatus,
  duration,
  RANGES,
  RangeKey,
  fetchSiteSummary,
  rangeFor,
  relativeTime,
  siteOf,
  SiteSummary,
  STATUS_META,
  TokenClaims,
} from "../_lib/data";

export const muted = "#9ab";

// Redirects to /login when signed out; returns the active company context.
// Re-reads it on cross-tab storage events and on a short tick, so switching
// company anywhere in the app re-scopes (and refetches) these views. The
// returned object only changes identity when the context actually changes.
export function useAuthGuard(): TokenClaims | null {
  const router = useRouter();
  const [claims, setClaims] = useState<TokenClaims | null>(null);
  useEffect(() => {
    let last = "";
    const sync = () => {
      if (!getToken()) {
        router.replace("/login");
        return;
      }
      const next = activeTenant();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setClaims(next);
      }
    };
    sync();
    const t = setInterval(sync, 2_000);
    window.addEventListener("storage", sync);
    return () => {
      clearInterval(t);
      window.removeEventListener("storage", sync);
    };
  }, [router]);
  return claims;
}

// Re-renders every `ms` so relative times and live status stay current.
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Top websites for a range, from the server-side per-site summary.
export function useTopSites(
  claims: TokenClaims | null,
  rangeKey: RangeKey,
  filter: { userId?: string; deviceId?: string },
  onError: (msg: string) => void
): SiteSummary[] {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const { userId, deviceId } = filter;
  useEffect(() => {
    if (!claims) return;
    let cancelled = false;
    fetchSiteSummary(rangeFor(rangeKey), { userId, deviceId })
      .then((s) => !cancelled && setSites(s.slice(0, 10)))
      .catch((e: Error) => !cancelled && onError(e.message));
    return () => {
      cancelled = true;
    };
    // onError is a state setter; stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims, rangeKey, userId, deviceId]);
  return sites;
}

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/devices", label: "Devices" },
  { href: "/dashboard/employees", label: "Employees" },
  { href: "/dashboard/activity", label: "Activity" },
  { href: "/dashboard/settings", label: "Settings" },
];

export function Shell({ title, claims, children }: { title: string; claims: TokenClaims | null; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  function logout() {
    clearToken();
    router.replace("/login");
  }
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 28 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, margin: 0 }}>{title}</h1>
          {claims && (
            <p style={{ color: muted, fontSize: 13, margin: "4px 0 0" }}>
              {claims.tenantName ?? <code>{claims.tenantId}</code>} · {claims.email} ({claims.role})
            </p>
          )}
        </div>
        <nav style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {NAV.map((n) => {
            const active = n.href === "/dashboard" ? pathname === n.href : pathname?.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  textDecoration: "none",
                  color: active ? "#e6edf7" : muted,
                  background: active ? "#1b2538" : "transparent",
                  fontSize: 14,
                }}
              >
                {n.label}
              </Link>
            );
          })}
          <button onClick={logout} style={{ background: "transparent", color: muted, border: "1px solid #334", padding: "8px 14px", borderRadius: 8, cursor: "pointer", marginLeft: 8 }}>
            Sign out
          </button>
        </nav>
      </header>
      {children}
    </main>
  );
}

export function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28, background: "#131c2e", border: "1px solid #223", borderRadius: 12, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p style={{ color: "#f87171" }}>{error}</p> : null;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: muted, margin: 0 }}>{children}</p>;
}

export const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 14 };
export function Th({ children }: { children?: React.ReactNode }) {
  return <th style={{ textAlign: "left", padding: "8px 6px", color: muted, borderBottom: "1px solid #223", fontWeight: 600 }}>{children}</th>;
}
export function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return <td colSpan={colSpan} style={{ padding: "8px 6px", borderBottom: "1px solid #1b2538" }}>{children}</td>;
}

export function StatusBadge({ status }: { status: DeviceStatus }) {
  const m = STATUS_META[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: m.color }} />
      {m.label}
    </span>
  );
}

export function RangePicker({ value, onChange }: { value: RangeKey; onChange: (k: RangeKey) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {RANGES.map((r) => (
        <button
          key={r.key}
          onClick={() => onChange(r.key)}
          style={{
            background: value === r.key ? "#1b2538" : "transparent",
            color: value === r.key ? "#e6edf7" : muted,
            border: "1px solid #334",
            padding: "4px 10px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function StatTile({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ background: "#131c2e", border: "1px solid #223", borderRadius: 12, padding: 16 }}>
      <div style={{ color: muted, fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4, color: color ?? "#e6edf7" }}>{value}</div>
    </div>
  );
}

// Horizontal bar list for top apps / sites.
export function BarList({ items, empty }: { items: { label: string; seconds: number }[]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  const max = Math.max(...items.map((i) => i.seconds), 1);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((i) => (
        <div key={i.label}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 3 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 12 }}>{i.label}</span>
            <span style={{ color: muted, flexShrink: 0 }}>{duration(i.seconds)}</span>
          </div>
          <div style={{ height: 6, background: "#1b2538", borderRadius: 3 }}>
            <div style={{ width: `${(i.seconds / max) * 100}%`, height: "100%", background: "#60a5fa", borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DevicesTable({
  devices,
  lastEvents = {},
  now,
}: {
  devices: Device[];
  lastEvents?: Record<string, ActivityLog | undefined>;
  now: number;
}) {
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <Th>Status</Th>
          <Th>Employee</Th>
          <Th>Host</Th>
          <Th>Platform</Th>
          <Th>Agent</Th>
          <Th>Last seen</Th>
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => (
          <tr key={d.id}>
            <Td>
              <StatusBadge status={deviceStatus(d, lastEvents[d.id], now)} />
            </Td>
            <Td>
              <Link href={`/dashboard/devices/${d.id}`} style={{ color: "#93c5fd", textDecoration: "none" }}>
                {d.user?.name ?? "Unassigned"}
              </Link>
              {d.user && <div style={{ color: muted, fontSize: 12 }}>{d.user.email}</div>}
            </Td>
            <Td>{d.hostname ?? "—"}</Td>
            <Td>{[d.platform, d.osVersion].filter(Boolean).join(" ") || "—"}</Td>
            <Td>{d.agentVersion ?? "—"}</Td>
            <Td>
              <span title={d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : undefined}>{relativeTime(d.lastSeenAt, now)}</span>
            </Td>
          </tr>
        ))}
        {devices.length === 0 && (
          <tr>
            <Td colSpan={6}>No devices match.</Td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

const EVENT_LABEL: Record<ActivityLog["type"], string> = {
  APP_ACTIVE: "Active",
  IDLE_START: "Went idle",
  IDLE_END: "Back from idle",
  SESSION_START: "Session started",
  SESSION_END: "Session ended",
};

// Collapses consecutive samples of the same app/window into one row so the
// timeline reads as "what they were doing" rather than every 30s sample.
interface TimelineRow {
  key: string;
  type: ActivityLog["type"];
  appName: string | null;
  windowTitle: string | null;
  site: string | null;
  start: string;
  end: string;
  seconds: number;
  deviceId: string;
}

function collapse(logs: ActivityLog[]): TimelineRow[] {
  const sorted = [...logs].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const rows: TimelineRow[] = [];
  for (const l of sorted) {
    const site = siteOf(l.url);
    const prev = rows[rows.length - 1];
    if (
      prev &&
      l.type === "APP_ACTIVE" &&
      prev.type === "APP_ACTIVE" &&
      prev.deviceId === l.deviceId &&
      prev.appName === l.appName &&
      prev.windowTitle === l.windowTitle &&
      prev.site === site
    ) {
      prev.end = l.capturedAt;
      prev.seconds += l.activeSeconds;
      continue;
    }
    rows.push({
      key: l.id,
      type: l.type,
      appName: l.appName,
      windowTitle: l.windowTitle,
      site,
      start: l.capturedAt,
      end: l.capturedAt,
      seconds: l.activeSeconds,
      deviceId: l.deviceId,
    });
  }
  return rows.reverse();
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function Timeline({ logs, deviceName }: { logs: ActivityLog[]; deviceName?: (deviceId: string) => string | undefined }) {
  const rows = collapse(logs);
  if (rows.length === 0) return <Empty>No activity in this period.</Empty>;
  let lastDay = "";
  return (
    <div style={{ display: "grid" }}>
      {rows.map((r) => {
        const day = new Date(r.start).toLocaleDateString();
        const showDay = day !== lastDay;
        lastDay = day;
        const isApp = r.type === "APP_ACTIVE";
        return (
          <div key={r.key}>
            {showDay && <div style={{ color: muted, fontSize: 12, padding: "10px 0 4px", fontWeight: 600 }}>{day}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "110px 1fr auto", gap: 12, padding: "7px 0", borderBottom: "1px solid #1b2538", fontSize: 14 }}>
              <span style={{ color: muted }}>{r.start === r.end ? time(r.start) : `${time(r.start)}–${time(r.end)}`}</span>
              <span style={{ minWidth: 0 }}>
                {isApp ? (
                  <>
                    <strong style={{ fontWeight: 600 }}>{r.appName ?? "Unknown app"}</strong>
                    {r.site && <span style={{ color: "#93c5fd" }}> · {r.site}</span>}
                    {r.windowTitle && (
                      <div style={{ color: muted, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.windowTitle}</div>
                    )}
                  </>
                ) : (
                  <span style={{ color: r.type === "IDLE_START" ? "#fbbf24" : muted, fontStyle: "italic" }}>{EVENT_LABEL[r.type]}</span>
                )}
                {deviceName && <div style={{ color: muted, fontSize: 12 }}>{deviceName(r.deviceId)}</div>}
              </span>
              <span style={{ color: muted }}>{isApp && r.seconds > 0 ? duration(r.seconds) : ""}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
