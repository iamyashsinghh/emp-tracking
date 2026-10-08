"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getToken } from "../../../../lib/api";
import { dayKey, Employee, listEmployees, Range } from "./data";

export const colors = {
  surface: "#131c2e",
  border: "#223",
  hairline: "#1b2538",
  textPrimary: "#e6edf7",
  textSecondary: "#9ab",
  textMuted: "#6b7a90",
  // Categorical slots 1–2 (dark steps), validated against the #131c2e surface.
  active: "#3987e5",
  idle: "#d95926",
  danger: "#f87171",
};

/** Redirects to /login when there is no session token. */
export function useRequireAuth() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!getToken()) router.replace("/login");
    else setReady(true);
  }, [router]);
  return ready;
}

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/media", label: "Media" },
  { href: "/dashboard/reports", label: "Reports" },
];

export function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 16px" }}>
      <nav style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {NAV.map((n) => {
          const on = pathname === n.href;
          return (
            <Link
              key={n.href}
              href={n.href}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                fontSize: 14,
                textDecoration: "none",
                color: on ? colors.textPrimary : colors.textSecondary,
                background: on ? "#1c2840" : "transparent",
                border: `1px solid ${on ? "#2c3a57" : "transparent"}`,
              }}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
      <h1 style={{ fontSize: 24, margin: "0 0 16px" }}>{title}</h1>
      {children}
    </main>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        marginTop: 20,
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 20,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{title}</h2>
        {actions && <div style={{ display: "flex", gap: 8 }}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export const controlStyle: React.CSSProperties = {
  background: "#0f1728",
  color: colors.textPrimary,
  border: "1px solid #2c3a57",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 14,
  colorScheme: "dark",
};

export function Button({
  children,
  onClick,
  pressed,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      style={{
        ...controlStyle,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        background: pressed ? "#1f3459" : controlStyle.background,
        borderColor: pressed ? colors.active : "#2c3a57",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Filters: date range first, then employee, in one row above the content.
// ---------------------------------------------------------------------------

export type Preset = "today" | "7d" | "30d" | "custom";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "custom", label: "Custom" },
];

export interface Filters {
  preset: Preset;
  customFrom: string; // YYYY-MM-DD
  customTo: string;
  userId: string; // "" = everyone
}

export function defaultFilters(preset: Preset = "7d"): Filters {
  const today = dayKey(new Date());
  return { preset, customFrom: today, customTo: today, userId: "" };
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseDay(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Inclusive local-day range for the selected preset. */
export function rangeFor(f: Filters): Range {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  switch (f.preset) {
    case "today":
      return { from: startOfDay(now), to: tomorrow };
    case "7d":
      return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6), to: tomorrow };
    case "30d":
      return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29), to: tomorrow };
    case "custom": {
      let a = parseDay(f.customFrom);
      let b = parseDay(f.customTo);
      if (b < a) [a, b] = [b, a];
      // Keep custom ranges to 92 days so the per-day fallback stays bounded.
      const maxEnd = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 91);
      if (b > maxEnd) b = maxEnd;
      return { from: a, to: new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1) };
    }
  }
}

export function useEmployees() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!getToken()) return;
    listEmployees()
      .then((list) => setEmployees([...list].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => setError((e as Error).message));
  }, []);
  const byId = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  return { employees, byId, error };
}

export function FilterBar({
  filters,
  onChange,
  employees,
  children,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  employees: Employee[];
  children?: React.ReactNode;
}) {
  const today = dayKey(new Date());
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <div role="group" aria-label="Date range" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <Button key={p.id} pressed={filters.preset === p.id} onClick={() => onChange({ ...filters, preset: p.id })}>
            {p.label}
          </Button>
        ))}
      </div>
      {filters.preset === "custom" && (
        <>
          <input
            type="date"
            aria-label="From"
            value={filters.customFrom}
            max={today}
            onChange={(e) => e.target.value && onChange({ ...filters, customFrom: e.target.value })}
            style={controlStyle}
          />
          <span style={{ color: colors.textSecondary }}>to</span>
          <input
            type="date"
            aria-label="To"
            value={filters.customTo}
            max={today}
            onChange={(e) => e.target.value && onChange({ ...filters, customTo: e.target.value })}
            style={controlStyle}
          />
        </>
      )}
      <select
        aria-label="Employee"
        value={filters.userId}
        onChange={(e) => onChange({ ...filters, userId: e.target.value })}
        style={controlStyle}
      >
        <option value="">All employees</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      style={{
        margin: "12px 0 0",
        fontSize: 13,
        color: tone === "error" ? colors.danger : colors.textSecondary,
      }}
    >
      {children}
    </p>
  );
}
