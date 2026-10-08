"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HorizontalBars, LegendKey, ShareMeter, StackedColumns, StatTile } from "./_shared/charts";
import {
  AppSummary,
  dailyActivity,
  DailyActivity,
  dayKey,
  dayWindows,
  downloadCsv,
  duration,
  mapLimit,
  topApps,
} from "./_shared/data";
import {
  Button,
  colors,
  defaultFilters,
  FilterBar,
  Filters,
  Notice,
  rangeFor,
  Section,
  Shell,
  useEmployees,
  useRequireAuth,
} from "./_shared/ui";

const TOP_APPS = 10;

interface EmployeeRow {
  userId: string;
  name: string;
  email: string;
  activeSeconds: number;
  idleSeconds: number;
  topApp: string | null;
}

export default function ReportsPage() {
  const ready = useRequireAuth();
  const { employees, byId, error: employeesError } = useEmployees();
  const [filters, setFilters] = useState<Filters>(() => defaultFilters("7d"));
  const range = useMemo(() => rangeFor(filters), [filters]);

  const [daily, setDaily] = useState<DailyActivity[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [topAppByUser, setTopAppByUser] = useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!ready) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    const userId = filters.userId || undefined;
    Promise.all([dailyActivity(range, userId), topApps(range, userId)])
      .then(([d, a]) => {
        if (id !== requestId.current) return;
        setDaily(d);
        setApps(a);
      })
      .catch((e) => id === requestId.current && setError((e as Error).message))
      .finally(() => id === requestId.current && setLoading(false));
  }, [ready, range, filters.userId]);

  // Top app per employee, only for people with tracked time in this slice.
  useEffect(() => {
    if (!ready) return;
    const id = requestId.current;
    const userIds = [...new Set(daily.map((d) => d.userId).filter((u): u is string => !!u))];
    if (userIds.length === 0) {
      setTopAppByUser(new Map());
      return;
    }
    mapLimit(userIds, 4, async (u) => {
      const list = await topApps(range, u).catch(() => [] as AppSummary[]);
      return [u, list[0]?.appName ?? null] as const;
    }).then((pairs) => id === requestId.current && setTopAppByUser(new Map(pairs)));
  }, [ready, daily, range]);

  // ---- derived views ------------------------------------------------------

  const perDay = useMemo(() => {
    const totals = new Map<string, { active: number; idle: number }>();
    for (const w of dayWindows(range)) totals.set(dayKey(w.from), { active: 0, idle: 0 });
    for (const r of daily) {
      const t = totals.get(r.day);
      if (!t) continue;
      t.active += r.activeSeconds;
      t.idle += r.idleSeconds;
    }
    return [...totals.entries()].map(([day, t]) => {
      const [y, m, d] = day.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      return {
        day,
        active: t.active,
        idle: t.idle,
        label: date.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
        title: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
      };
    });
  }, [daily, range]);

  const totals = useMemo(() => {
    const active = perDay.reduce((a, d) => a + d.active, 0);
    const idle = perDay.reduce((a, d) => a + d.idle, 0);
    return { active, idle, share: active + idle ? active / (active + idle) : 0 };
  }, [perDay]);

  const employeeRows: EmployeeRow[] = useMemo(() => {
    const acc = new Map<string, EmployeeRow>();
    for (const r of daily) {
      if (!r.userId) continue;
      let row = acc.get(r.userId);
      if (!row) {
        const e = byId.get(r.userId);
        row = {
          userId: r.userId,
          name: e?.name ?? "Unknown employee",
          email: e?.email ?? "",
          activeSeconds: 0,
          idleSeconds: 0,
          topApp: null,
        };
        acc.set(r.userId, row);
      }
      row.activeSeconds += r.activeSeconds;
      row.idleSeconds += r.idleSeconds;
    }
    return [...acc.values()]
      .map((r) => ({ ...r, topApp: topAppByUser.get(r.userId) ?? null }))
      .sort((a, b) => b.activeSeconds - a.activeSeconds);
  }, [daily, byId, topAppByUser]);

  const appBars = useMemo(() => {
    const head = apps.slice(0, TOP_APPS).map((a) => ({ label: a.appName, value: a.activeSeconds }));
    const rest = apps.slice(TOP_APPS).reduce((s, a) => s + a.activeSeconds, 0);
    return rest > 0 ? [...head, { label: "Other", value: rest }] : head;
  }, [apps]);

  // ---- export -------------------------------------------------------------

  const slug = `${dayKey(range.from)}_to_${dayKey(new Date(range.to.getTime() - 1))}`;
  const who = filters.userId ? byId.get(filters.userId)?.name ?? "employee" : "all";

  function exportDaily() {
    const rows = daily
      .slice()
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => {
        const e = r.userId ? byId.get(r.userId) : undefined;
        return [r.day, e?.name ?? "", e?.email ?? "", r.activeSeconds, r.idleSeconds, (r.activeSeconds / 3600).toFixed(2), (r.idleSeconds / 3600).toFixed(2)];
      });
    downloadCsv(`activity-daily_${who}_${slug}.csv`, ["date", "employee", "email", "active_seconds", "idle_seconds", "active_hours", "idle_hours"], rows);
  }
  function exportApps() {
    const total = apps.reduce((s, a) => s + a.activeSeconds, 0);
    downloadCsv(
      `top-apps_${who}_${slug}.csv`,
      ["app", "active_seconds", "active_hours", "share_pct"],
      apps.map((a) => [a.appName, a.activeSeconds, (a.activeSeconds / 3600).toFixed(2), total ? ((a.activeSeconds / total) * 100).toFixed(1) : "0"])
    );
  }
  function exportEmployees() {
    downloadCsv(
      `employees_${who}_${slug}.csv`,
      ["employee", "email", "active_seconds", "idle_seconds", "active_hours", "idle_hours", "active_share_pct", "top_app"],
      employeeRows.map((r) => {
        const t = r.activeSeconds + r.idleSeconds;
        return [r.name, r.email, r.activeSeconds, r.idleSeconds, (r.activeSeconds / 3600).toFixed(2), (r.idleSeconds / 3600).toFixed(2), t ? ((r.activeSeconds / t) * 100).toFixed(1) : "0", r.topApp ?? ""];
      })
    );
  }

  if (!ready) return null;

  const dim = { opacity: loading ? 0.55 : 1, transition: "opacity 120ms" } as const;
  const series = [
    { label: "Active", color: colors.active },
    { label: "Idle", color: colors.idle },
  ];

  return (
    <Shell title="Reports">
      <FilterBar filters={filters} onChange={setFilters} employees={employees} />
      {employeesError && <Notice tone="error">Could not load employees: {employeesError}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div
        style={{
          ...dim,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 12,
          marginTop: 20,
        }}
      >
        <StatTile label="Active time" value={duration(totals.active)} />
        <StatTile label="Idle time" value={duration(totals.idle)} />
        <StatTile label="Active share" value={`${Math.round(totals.share * 100)}%`} note="of tracked time" />
        <StatTile label="Employees with activity" value={String(employeeRows.length)} />
      </div>

      <Section
        title="Active vs idle per day"
        actions={
          <>
            <Button onClick={() => setShowTable((v) => !v)} pressed={showTable}>
              {showTable ? "Show chart" : "Show table"}
            </Button>
            <Button onClick={exportDaily} disabled={daily.length === 0}>
              Export CSV
            </Button>
          </>
        }
      >
        <div style={dim}>
          {showTable ? (
            <DataTable
              head={["Date", "Active", "Idle", "Active share"]}
              rows={perDay.map((d) => [d.title, duration(d.active), duration(d.idle), d.active + d.idle ? `${Math.round((d.active / (d.active + d.idle)) * 100)}%` : "—"])}
            />
          ) : (
            <>
              <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
                {series.map((s) => (
                  <LegendKey key={s.label} color={s.color} label={s.label} />
                ))}
              </div>
              <StackedColumns
                series={series}
                data={perDay.map((d) => ({ key: d.day, label: d.label, title: d.title, values: [d.active, d.idle] }))}
              />
            </>
          )}
        </div>
      </Section>

      <Section
        title="Top applications by active time"
        actions={
          <Button onClick={exportApps} disabled={apps.length === 0}>
            Export CSV
          </Button>
        }
      >
        <div style={dim}>
          {appBars.length ? (
            <HorizontalBars data={appBars} color={colors.active} />
          ) : (
            <p style={{ color: colors.textSecondary, margin: 0 }}>No application activity in this range.</p>
          )}
        </div>
      </Section>

      <Section
        title="Per-employee summary"
        actions={
          <Button onClick={exportEmployees} disabled={employeeRows.length === 0}>
            Export CSV
          </Button>
        }
      >
        <div style={{ ...dim, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 560 }}>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th align="right">Active</Th>
                <Th align="right">Idle</Th>
                <Th>Active share</Th>
                <Th>Top app</Th>
              </tr>
            </thead>
            <tbody>
              {employeeRows.map((r) => (
                <tr key={r.userId}>
                  <Td>
                    <div>{r.name}</div>
                    {r.email && <div style={{ fontSize: 12, color: colors.textMuted }}>{r.email}</div>}
                  </Td>
                  <Td align="right">{duration(r.activeSeconds)}</Td>
                  <Td align="right">{duration(r.idleSeconds)}</Td>
                  <Td>
                    <ShareMeter share={r.activeSeconds + r.idleSeconds ? r.activeSeconds / (r.activeSeconds + r.idleSeconds) : 0} />
                  </Td>
                  <Td>{r.topApp ?? "—"}</Td>
                </tr>
              ))}
              {employeeRows.length === 0 && (
                <tr>
                  <Td colSpan={5}>{loading ? "Loading…" : "No tracked activity in this range."}</Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </Shell>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <Th key={h} align={i === 0 ? "left" : "right"}>
                {h}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              {r.map((c, i) => (
                <Td key={i} align={i === 0 ? "left" : "right"}>
                  {c}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{ textAlign: align, padding: "8px 6px", color: colors.textSecondary, borderBottom: `1px solid ${colors.border}`, fontWeight: 600 }}>
      {children}
    </th>
  );
}

function Td({ children, colSpan, align = "left" }: { children: React.ReactNode; colSpan?: number; align?: "left" | "right" }) {
  return (
    <td
      colSpan={colSpan}
      style={{ padding: "8px 6px", borderBottom: `1px solid ${colors.hairline}`, textAlign: align, fontVariantNumeric: align === "right" ? "tabular-nums" : undefined }}
    >
      {children}
    </td>
  );
}
