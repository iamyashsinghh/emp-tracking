import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityLog, activeTenant, Device, deviceStatus, duration, latestByDevice, relativeTime, siteOf, topApps } from "./data";
import { Timeline } from "../_components/ui";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function device(over: Partial<Device> = {}): Device {
  return {
    id: "d1",
    tenantId: "t1",
    userId: "u1",
    enrolled: true,
    hostname: "host",
    platform: "win32",
    osVersion: null,
    agentVersion: null,
    lastSeenAt: ago(30_000),
    createdAt: ago(86_400_000),
    user: { id: "u1", name: "Asha", email: "asha@demo.co" },
    ...over,
  };
}

let seq = 0;
function log(over: Partial<ActivityLog> = {}): ActivityLog {
  return {
    id: `l${++seq}`,
    deviceId: "d1",
    userId: "u1",
    type: "APP_ACTIVE",
    appName: "Chrome",
    windowTitle: null,
    url: null,
    activeSeconds: 30,
    capturedAt: ago(60_000),
    ...over,
  };
}

describe("deviceStatus", () => {
  it("is online within 2 minutes, idle when the latest event is IDLE_START", () => {
    expect(deviceStatus(device(), undefined, NOW)).toBe("online");
    expect(deviceStatus(device(), log({ type: "IDLE_START" }), NOW)).toBe("idle");
  });

  it("is away within 15 minutes and offline after", () => {
    expect(deviceStatus(device({ lastSeenAt: ago(5 * 60_000) }), undefined, NOW)).toBe("away");
    expect(deviceStatus(device({ lastSeenAt: ago(20 * 60_000) }), undefined, NOW)).toBe("offline");
    expect(deviceStatus(device({ lastSeenAt: null }), undefined, NOW)).toBe("offline");
  });

  it("marks devices whose agent never enrolled", () => {
    expect(deviceStatus(device({ enrolled: false }), undefined, NOW)).toBe("pending");
  });
});

describe("aggregation", () => {
  it("sums active seconds per app, APP_ACTIVE only, largest first", () => {
    const rows = topApps([
      log({ appName: "Slack", activeSeconds: 10 }),
      log({ appName: "Chrome", activeSeconds: 30 }),
      log({ appName: "Chrome", activeSeconds: 30 }),
      log({ appName: "Chrome", type: "IDLE_START", activeSeconds: 999 }),
    ]);
    expect(rows).toEqual([
      { appName: "Chrome", activeSeconds: 60 },
      { appName: "Slack", activeSeconds: 10 },
    ]);
  });

  it("extracts a bare hostname from URLs", () => {
    expect(siteOf("https://www.github.com/a/b")).toBe("github.com");
    expect(siteOf("not a url")).toBeNull();
    expect(siteOf(null)).toBeNull();
  });

  it("keeps the newest event per device", () => {
    const old = log({ deviceId: "d1", capturedAt: ago(120_000) });
    const fresh = log({ deviceId: "d1", capturedAt: ago(10_000) });
    const other = log({ deviceId: "d2" });
    expect(latestByDevice([old, fresh, other])).toEqual({ d1: fresh, d2: other });
  });
});

describe("formatting", () => {
  it("formats durations and relative times", () => {
    expect(duration(45)).toBe("45s");
    expect(duration(150)).toBe("2m");
    expect(duration(3_900)).toBe("1h 5m");
    expect(relativeTime(null, NOW)).toBe("never");
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe("3h ago");
  });
});

describe("activeTenant", () => {
  it("uses the dashboard session's active company when present", () => {
    window.localStorage.setItem(
      "emptrack_session",
      JSON.stringify({
        token: "x",
        activeTenantId: "t2",
        tenants: [
          { id: "t1", name: "Home Co" },
          { id: "t2", name: "Acme" },
        ],
        user: { id: "u1", email: "owner@demo.co", role: "SUPER_ADMIN", tenantId: "t1" },
      })
    );
    expect(activeTenant()).toEqual({ tenantId: "t2", tenantName: "Acme", role: "SUPER_ADMIN", email: "owner@demo.co" });
  });

  it("falls back to the token's own company", () => {
    const payload = btoa(JSON.stringify({ tenantId: "t1", role: "ADMIN", email: "a@demo.co" }));
    window.localStorage.setItem("emptrack_token", `h.${payload}.s`);
    expect(activeTenant()).toEqual({ tenantId: "t1", tenantName: null, role: "ADMIN", email: "a@demo.co" });
  });

  it("is null when signed out", () => {
    expect(activeTenant()).toBeNull();
  });
});

describe("Timeline", () => {
  it("collapses consecutive samples of the same window into one row", () => {
    render(
      <Timeline
        logs={[
          log({ appName: "Code", windowTitle: "main.ts", capturedAt: ago(90_000) }),
          log({ appName: "Code", windowTitle: "main.ts", capturedAt: ago(60_000) }),
          log({ type: "IDLE_START", appName: null, capturedAt: ago(30_000) }),
        ]}
      />
    );
    expect(screen.getAllByText("Code")).toHaveLength(1);
    expect(screen.getByText("1m")).toBeInTheDocument();
    expect(screen.getByText("Went idle")).toBeInTheDocument();
  });
});
