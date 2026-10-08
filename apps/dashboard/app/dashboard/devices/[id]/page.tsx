"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityLog,
  Device,
  deviceStatus,
  duration,
  fetchActivity,
  fetchDevices,
  rangeFor,
  RangeKey,
  relativeTime,
  topApps,
} from "../../_lib/data";
import {
  BarList,
  ErrorText,
  muted,
  RangePicker,
  Section,
  Shell,
  StatTile,
  StatusBadge,
  Timeline,
  useAuthGuard,
  useNow,
  useTopSites,
} from "../../_components/ui";

export default function DeviceDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const claims = useAuthGuard();
  const now = useNow();
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [rangeKey, setRangeKey] = useState<RangeKey>("24h");
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The reports API is tenant-scoped, so a device from another company is
  // simply absent from this list and shows as not found.
  useEffect(() => {
    if (!claims || !id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const all = await fetchDevices();
        if (!cancelled) setDevice(all.find((d) => d.id === id) ?? null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [claims, id]);

  useEffect(() => {
    if (!claims || !id) return;
    fetchActivity(rangeFor(rangeKey), { deviceId: id })
      .then(setLogs)
      .catch((e: Error) => setError(e.message));
  }, [claims, id, rangeKey]);

  const apps = useMemo(() => topApps(logs), [logs]);
  const sites = useTopSites(!!claims && !!id, rangeKey, { deviceId: id }, logs, setError);
  const activeSeconds = useMemo(() => logs.reduce((s, l) => s + (l.type === "APP_ACTIVE" ? l.activeSeconds : 0), 0), [logs]);
  const idleCount = useMemo(() => logs.filter((l) => l.type === "IDLE_START").length, [logs]);
  const latest = logs[0];

  if (device === null) {
    return (
      <Shell title="Device not found" claims={claims}>
        <p style={{ color: muted }}>
          This device is not enrolled in your company. <Link href="/dashboard/devices" style={{ color: "#93c5fd" }}>Back to devices</Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell title={device ? device.user?.name ?? device.hostname ?? "Device" : "Loading…"} claims={claims}>
      <ErrorText error={error} />
      <p style={{ marginTop: 12 }}>
        <Link href="/dashboard/devices" style={{ color: "#93c5fd", textDecoration: "none", fontSize: 14 }}>
          ← All devices
        </Link>
      </p>

      {device && (
        <Section title="Device" action={<StatusBadge status={deviceStatus(device, latest, now)} />}>
          <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: 0, fontSize: 14 }}>
            <Field label="Employee" value={device.user ? `${device.user.name} (${device.user.email})` : "Unassigned"} />
            <Field label="Host" value={device.hostname} />
            <Field label="Platform" value={[device.platform, device.osVersion].filter(Boolean).join(" ") || null} />
            <Field label="Agent version" value={device.agentVersion} />
            <Field label="Last seen" value={device.lastSeenAt ? `${relativeTime(device.lastSeenAt, now)} · ${new Date(device.lastSeenAt).toLocaleString()}` : "never"} />
            <Field label="Enrolled" value={device.enrolled ? "Yes" : "Waiting for agent"} />
          </dl>
        </Section>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 28 }}>
        <RangePicker value={rangeKey} onChange={setRangeKey} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 12 }}>
        <StatTile label="Active time" value={duration(activeSeconds)} />
        <StatTile label="Apps used" value={apps.length} />
        <StatTile label="Idle periods" value={idleCount} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <Section title="Top applications">
          <BarList items={apps.map((a) => ({ label: a.appName, seconds: a.activeSeconds }))} empty="No app activity in this period." />
        </Section>
        <Section title="Top websites">
          <BarList items={sites.map((s) => ({ label: s.site, seconds: s.activeSeconds }))} empty="No website visits in this period." />
        </Section>
      </div>
      <Section title="Activity timeline">
        <Timeline logs={logs} />
        {logs.length >= 500 && (
          <p style={{ color: muted, fontSize: 12 }}>Showing the most recent 500 events. Pick a shorter range to see everything.</p>
        )}
      </Section>
    </Shell>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt style={{ color: muted, fontSize: 12 }}>{label}</dt>
      <dd style={{ margin: "2px 0 0" }}>{value ?? "—"}</dd>
    </div>
  );
}
