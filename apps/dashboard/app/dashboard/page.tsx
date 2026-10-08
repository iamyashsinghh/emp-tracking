"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, clearToken, getToken } from "../../lib/api";

interface Device {
  id: string;
  hostname: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  user: { name: string; email: string } | null;
}
interface AppSummary {
  appName: string;
  activeSeconds: number;
}
interface MediaItem {
  id: string;
  kind: "SCREENSHOT" | "RECORDING";
  capturedAt: string;
  url: string;
  durationSeconds: number | null;
}

function hours(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Dashboard() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[]>([]);
  const [summary, setSummary] = useState<AppSummary[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        setDevices(await api<Device[]>("/api/reports/devices"));
        setSummary(await api<AppSummary[]>("/api/reports/activity/summary"));
        setMedia(await api<MediaItem[]>("/api/reports/media"));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [router]);

  function logout() {
    clearToken();
    router.replace("/login");
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 28 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 24 }}>Activity overview</h1>
        <button onClick={logout} style={{ background: "transparent", color: "#9ab", border: "1px solid #334", padding: "8px 14px", borderRadius: 8, cursor: "pointer" }}>
          Sign out
        </button>
      </header>
      {error && <p style={{ color: "#f87171" }}>{error}</p>}

      <Section title={`Devices (${devices.length})`}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Employee</Th>
              <Th>Host</Th>
              <Th>Platform</Th>
              <Th>Last seen</Th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <Td>{d.user?.name ?? "—"}</Td>
                <Td>{d.hostname ?? "—"}</Td>
                <Td>{d.platform ?? "—"}</Td>
                <Td>{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}</Td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr>
                <Td colSpan={4}>No devices enrolled yet.</Td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="Top applications (last 24h)">
        {summary.map((s) => (
          <div key={s.appName} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #1b2538" }}>
            <span>{s.appName}</span>
            <span style={{ color: "#9ab" }}>{hours(s.activeSeconds)}</span>
          </div>
        ))}
        {summary.length === 0 && <p style={{ color: "#9ab" }}>No activity recorded yet.</p>}
      </Section>

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
          {media.length === 0 && <p style={{ color: "#9ab" }}>No media captured yet.</p>}
        </div>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28, background: "#131c2e", border: "1px solid #223", borderRadius: 12, padding: 20 }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>{title}</h2>
      {children}
    </section>
  );
}
const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 14 };
function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ textAlign: "left", padding: "8px 6px", color: "#9ab", borderBottom: "1px solid #223", fontWeight: 600 }}>{children}</th>;
}
function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return <td colSpan={colSpan} style={{ padding: "8px 6px", borderBottom: "1px solid #1b2538" }}>{children}</td>;
}
