"use client";

import { useEffect, useMemo, useState } from "react";
import { ActivityLog, Device, fetchActivity, fetchDevices, rangeFor, RangeKey, topApps } from "../_lib/data";
import { BarList, ErrorText, muted, RangePicker, Section, Shell, Timeline, useAuthGuard, useTopSites } from "../_components/ui";

const selectStyle: React.CSSProperties = {
  background: "#0b1220",
  color: "#e6edf7",
  border: "1px solid #334",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
};

export default function ActivityPage() {
  const claims = useAuthGuard();
  const [devices, setDevices] = useState<Device[]>([]);
  const [userId, setUserId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [rangeKey, setRangeKey] = useState<RangeKey>("24h");
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!claims) return;
    fetchDevices()
      .then(setDevices)
      .catch((e: Error) => setError(e.message));
  }, [claims]);

  useEffect(() => {
    if (!claims) return;
    fetchActivity(rangeFor(rangeKey), { userId: userId || undefined, deviceId: deviceId || undefined })
      .then(setLogs)
      .catch((e: Error) => setError(e.message));
  }, [claims, rangeKey, userId, deviceId]);

  const employees = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of devices) if (d.user) m.set(d.user.id, d.user.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [devices]);
  const deviceOptions = useMemo(() => devices.filter((d) => !userId || d.user?.id === userId), [devices, userId]);
  const deviceName = useMemo(() => {
    const m = new Map(devices.map((d) => [d.id, `${d.user?.name ?? "Unassigned"} · ${d.hostname ?? "unknown host"}`]));
    return (id: string) => m.get(id);
  }, [devices]);
  const apps = useMemo(() => topApps(logs), [logs]);
  const sites = useTopSites(claims, rangeKey, { userId: userId || undefined, deviceId: deviceId || undefined }, setError);

  return (
    <Shell title="Activity" claims={claims}>
      <ErrorText error={error} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 24 }}>
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setDeviceId("");
          }}
          style={selectStyle}
        >
          <option value="">All employees</option>
          {employees.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} style={selectStyle}>
          <option value="">All devices</option>
          {deviceOptions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.hostname ?? d.id}
            </option>
          ))}
        </select>
        <div style={{ marginLeft: "auto" }}>
          <RangePicker value={rangeKey} onChange={setRangeKey} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <Section title="Top applications">
          <BarList items={apps.map((a) => ({ label: a.appName, seconds: a.activeSeconds }))} empty="No app activity in this period." />
        </Section>
        <Section title="Top websites">
          <BarList items={sites.map((s) => ({ label: s.site, seconds: s.activeSeconds }))} empty="No website visits in this period." />
        </Section>
      </div>

      <Section title="Timeline">
        <Timeline logs={logs} deviceName={deviceId ? undefined : deviceName} />
        {logs.length >= 500 && (
          <p style={{ color: muted, fontSize: 12 }}>Showing the most recent 500 events. Narrow the filters to see everything.</p>
        )}
      </Section>
    </Shell>
  );
}
