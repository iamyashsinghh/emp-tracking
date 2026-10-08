"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  ActivityLog,
  AppSummary,
  Device,
  deviceStatus,
  DeviceStatus,
  fetchActivity,
  fetchAppSummary,
  fetchDevices,
  latestByDevice,
  rangeFor,
  RangeKey,
  STATUS_META,
} from "./_lib/data";
import {
  BarList,
  DevicesTable,
  Empty,
  ErrorText,
  RangePicker,
  Section,
  Shell,
  StatTile,
  useAuthGuard,
  useNow,
  useTopSites,
} from "./_components/ui";
import Link from "next/link";

interface MediaItem {
  id: string;
  kind: "SCREENSHOT" | "RECORDING";
  capturedAt: string;
  url: string;
  durationSeconds: number | null;
}

export default function Overview() {
  const claims = useAuthGuard();
  const now = useNow();
  const [rangeKey, setRangeKey] = useState<RangeKey>("24h");
  const [devices, setDevices] = useState<Device[]>([]);
  const [recent, setRecent] = useState<ActivityLog[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Device list + live status, refreshed every 30s.
  useEffect(() => {
    if (!claims) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [d, r] = await Promise.all([fetchDevices(), fetchActivity(rangeFor("1h"))]);
        if (cancelled) return;
        setDevices(d);
        setRecent(r);
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
  }, [claims]);

  // Top apps / sites / media for the selected range.
  useEffect(() => {
    if (!claims) return;
    const range = rangeFor(rangeKey);
    (async () => {
      try {
        const [a, l, m] = await Promise.all([
          fetchAppSummary(range),
          fetchActivity(range),
          api<MediaItem[]>(`/api/reports/media?from=${range.from.toISOString()}&to=${range.to.toISOString()}`),
        ]);
        setApps(a);
        setLogs(l);
        setMedia(m);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [claims, rangeKey]);

  const lastEvents = useMemo(() => latestByDevice(recent), [recent]);
  const counts = useMemo(() => {
    const c: Record<DeviceStatus, number> = { online: 0, idle: 0, away: 0, offline: 0, pending: 0 };
    for (const d of devices) c[deviceStatus(d, lastEvents[d.id], now)]++;
    return c;
  }, [devices, lastEvents, now]);
  const sites = useTopSites(!!claims, rangeKey, {}, logs, setError);

  return (
    <Shell title="Activity overview" claims={claims}>
      <ErrorText error={error} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 24 }}>
        <StatTile label="Devices" value={devices.length} />
        {(["online", "idle", "away", "offline"] as const).map((s) => (
          <StatTile key={s} label={STATUS_META[s].label} value={counts[s]} color={STATUS_META[s].color} />
        ))}
      </div>

      <Section
        title={`Devices (${devices.length})`}
        action={
          <Link href="/dashboard/devices" style={{ color: "#93c5fd", fontSize: 14, textDecoration: "none" }}>
            View all
          </Link>
        }
      >
        <DevicesTable devices={devices.slice(0, 10)} lastEvents={lastEvents} now={now} />
      </Section>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 28 }}>
        <RangePicker value={rangeKey} onChange={setRangeKey} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <Section title="Top applications">
          <BarList items={apps.slice(0, 10).map((a) => ({ label: a.appName, seconds: a.activeSeconds }))} empty="No activity recorded yet." />
        </Section>
        <Section title="Top websites">
          <BarList items={sites.map((s) => ({ label: s.site, seconds: s.activeSeconds }))} empty="No website visits recorded yet." />
        </Section>
      </div>

      <Section title="Recent screenshots & recordings">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
          {media.map((m) =>
            m.kind === "SCREENSHOT" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={m.id} src={m.url} alt={m.capturedAt} style={{ width: "100%", borderRadius: 8, border: "1px solid #223" }} />
            ) : (
              <video key={m.id} src={m.url} controls style={{ width: "100%", borderRadius: 8, border: "1px solid #223" }} />
            )
          )}
        </div>
        {media.length === 0 && <Empty>No media captured yet.</Empty>}
      </Section>
    </Shell>
  );
}
