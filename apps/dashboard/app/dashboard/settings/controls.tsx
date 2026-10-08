"use client";

import { useState } from "react";
import { humanSeconds } from "./policy";

export const colors = {
  card: "#131c2e",
  border: "#223",
  muted: "#9ab",
  on: "#22c55e",
  off: "#475569",
  accent: "#3b82f6",
  error: "#f87171",
};

export function Card({
  title,
  description,
  children,
  dimmed,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  dimmed?: boolean;
}) {
  return (
    <section
      style={{
        marginTop: 20,
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 20,
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <h2 style={{ fontSize: 16, margin: 0 }}>{title}</h2>
      {description && <p style={{ color: colors.muted, fontSize: 13, margin: "4px 0 0" }}>{description}</p>}
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        padding: "12px 0",
        borderTop: "1px solid #1b2538",
        flexWrap: "wrap",
      }}
    >
      {children}
    </div>
  );
}

export function Label({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ flex: "1 1 260px", minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {hint && <div style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

/** A switch that always spells out its state, so ON/OFF is never ambiguous. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        background: "transparent",
        border: "none",
        color: "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "relative",
          width: 46,
          height: 26,
          borderRadius: 999,
          background: checked ? colors.on : colors.off,
          transition: "background 120ms",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 23 : 3,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 120ms",
          }}
        />
      </span>
      <span style={{ width: 28, fontSize: 13, fontWeight: 700, color: checked ? colors.on : colors.muted }}>
        {checked ? "ON" : "OFF"}
      </span>
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: 110,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #334",
  background: "#0b1220",
  color: "inherit",
  fontSize: 14,
};

/**
 * Number input that keeps its own text so the admin can clear it and
 * type freely; the parent receives NaN while the box is empty, which
 * validation then flags.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  unit,
  disabled,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max?: number;
  unit: string;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        style={inputStyle}
      />
      <span style={{ color: colors.muted, fontSize: 13 }}>{unit}</span>
    </span>
  );
}

/** Seconds input with quick presets and a plain-language readout. */
export function SecondsField({
  value,
  onChange,
  min,
  max,
  presets,
  disabled,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max?: number;
  presets: number[];
  disabled?: boolean;
  label: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
        <NumberInput value={value} onChange={onChange} min={min} max={max} unit="seconds" disabled={disabled} label={label} />
        <span style={{ color: colors.muted, fontSize: 13, minWidth: 90 }}>= {humanSeconds(value)}</span>
      </span>
      <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {presets.map((p) => {
          const active = p === value;
          return (
            <button
              key={p}
              type="button"
              disabled={disabled}
              onClick={() => onChange(p)}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 999,
                border: `1px solid ${active ? colors.accent : "#334"}`,
                background: active ? colors.accent : "transparent",
                color: active ? "#fff" : colors.muted,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {humanSeconds(p)}
            </button>
          );
        })}
      </span>
    </div>
  );
}

export function TimeInput({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="time"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, width: 120 }}
    />
  );
}

/** Editable list of app names, e.g. excluded apps. */
export function TagList({
  values,
  onChange,
  disabled,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  const [text, setText] = useState("");

  function add() {
    const name = text.trim();
    if (!name) return;
    if (!values.some((v) => v.toLowerCase() === name.toLowerCase())) onChange([...values, name]);
    setText("");
  }

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="App name to exclude"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          style={{ ...inputStyle, width: "100%", maxWidth: 320 }}
        />
        <button type="button" onClick={add} disabled={disabled || !text.trim()} style={secondaryButton}>
          Add
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {values.map((v) => (
          <span
            key={v}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 6px 4px 10px",
              borderRadius: 999,
              background: "#1b2538",
              fontSize: 13,
            }}
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              disabled={disabled}
              onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ background: "transparent", border: "none", color: colors.muted, cursor: "pointer", fontSize: 14 }}
            >
              ×
            </button>
          </span>
        ))}
        {values.length === 0 && <span style={{ color: colors.muted, fontSize: 13 }}>No apps excluded.</span>}
      </div>
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <div style={{ width: "100%", color: colors.error, fontSize: 12, textAlign: "right" }}>{message}</div>;
}

export const primaryButton: React.CSSProperties = {
  padding: "9px 18px",
  borderRadius: 8,
  border: "none",
  background: colors.accent,
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

export const secondaryButton: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid #334",
  background: "transparent",
  color: colors.muted,
  cursor: "pointer",
};
