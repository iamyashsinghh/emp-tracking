"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ActivityLog,
  Device,
  deviceStatus,
  DeviceStatus,
  fetchActivity,
  fetchDevices,
  latestByDevice,
  rangeFor,
  STATUS_META,
} from "../_lib/data";
import { DevicesTable, ErrorText, muted, Section, Shell, useAuthGuard, useNow } from "../_components/ui";

const FILTERS: (DeviceStatus | "all")[] = ["all", "online", "idle", "away", "offline", "pending"];

export default function DevicesPage() {
  const claims = useAuthGuard();
  const now = useNow();
  const [devices, setDevices] = useState<Device[]>([]);
  const [recent, setRecent] = useState<ActivityLog[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<DeviceStatus | "all">("all");
  const [error, setError] = useState<string | null>(null);

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

  const lastEvents = useMemo(() => latestByDevice(recent), [recent]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return devices.filter((d) => {
      if (status !== "all" && deviceStatus(d, lastEvents[d.id], now) !== status) return false;
      if (!q) return true;
      return [d.user?.name, d.user?.email, d.hostname, d.platform].some((v) => v?.toLowerCase().includes(q));
    });
  }, [devices, lastEvents, now, search, status]);

  return (
    <Shell title="Devices" claims={claims}>
      <ErrorText error={error} />
      <Section
        title={`Enrolled devices (${filtered.length} of ${devices.length})`}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employee or host"
              style={{ background: "#0b1220", color: "#e6edf7", border: "1px solid #334", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as DeviceStatus | "all")}
              style={{ background: "#0b1220", color: "#e6edf7", border: "1px solid #334", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f === "all" ? "All statuses" : STATUS_META[f].label}
                </option>
              ))}
            </select>
          </div>
        }
      >
        <DevicesTable devices={filtered} lastEvents={lastEvents} now={now} />
        <p style={{ color: muted, fontSize: 12, marginBottom: 0 }}>
          Online means the agent checked in within the last 2 minutes; Away within 15 minutes.
        </p>
      </Section>
    </Shell>
  );
}
