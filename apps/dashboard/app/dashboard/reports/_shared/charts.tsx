"use client";

import { useEffect, useRef, useState } from "react";
import { duration } from "./data";
import { colors } from "./ui";

/**
 * Hand-built SVG charts (no chart library dependency).
 * Mark specs: bars <= 24px thick, 4px rounded data-end and square baseline,
 * 2px surface gap between stacked segments, hairline recessive grid,
 * text in text tokens only, hover/focus tooltip per mark.
 */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Clean tick step in hours for a max value in seconds. */
function hourTicks(maxSeconds: number) {
  const maxH = Math.max(maxSeconds / 3600, 0.5);
  const steps = [0.25, 0.5, 1, 2, 4, 6, 8, 12, 24, 48, 96, 168, 336];
  const step = steps.find((s) => maxH / s <= 5) ?? Math.ceil(maxH / 5);
  const top = Math.ceil(maxH / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v * 3600);
  return { ticks, top: top * 3600 };
}

function tickLabel(seconds: number) {
  const h = seconds / 3600;
  if (h === 0) return "0";
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

/** Rect with only the top corners rounded (data-end up, baseline square). */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Rect with only the right corners rounded (horizontal bar data-end). */
function rightRoundedRect(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

export function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: colors.textSecondary }}>
      <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  rows: { color: string; label: string; value: string }[];
}

function Tooltip({ t, containerWidth }: { t: TooltipState; containerWidth: number }) {
  const left = Math.min(Math.max(t.x + 12, 0), containerWidth - 180);
  return (
    <div
      role="tooltip"
      style={{
        position: "absolute",
        left,
        top: Math.max(t.y - 10, 0),
        pointerEvents: "none",
        background: "#0b1220",
        border: "1px solid #2c3a57",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 12,
        minWidth: 150,
        boxShadow: "0 6px 20px rgba(0,0,0,.4)",
        zIndex: 5,
      }}
    >
      <div style={{ color: colors.textSecondary, marginBottom: 6 }}>{t.title}</div>
      {t.rows.map((r) => (
        <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
          <span aria-hidden style={{ width: 12, height: 2, background: r.color, display: "inline-block" }} />
          <strong style={{ color: colors.textPrimary, fontWeight: 600 }}>{r.value}</strong>
          <span style={{ color: colors.textSecondary }}>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked columns: active (baseline) + idle per day
// ---------------------------------------------------------------------------

export interface StackDatum {
  key: string;
  label: string; // axis label
  title: string; // tooltip title
  values: number[]; // seconds, bottom -> top, aligned with `series`
}

export function StackedColumns({
  data,
  series,
  height = 260,
}: {
  data: StackDatum[];
  series: { label: string; color: string }[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const margin = { top: 12, right: 8, bottom: 28, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const max = Math.max(0, ...data.map((d) => d.values.reduce((a, b) => a + b, 0)));
  const { ticks, top } = hourTicks(max);
  const band = innerW / Math.max(1, data.length);
  const barW = Math.max(4, Math.min(24, band * 0.6));
  const y = (v: number) => innerH - (v / top) * innerH;
  // Thin out x labels so they never collide.
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(innerW / 56))));

  function show(d: StackDatum, i: number) {
    setHover(d.key);
    const total = d.values.reduce((a, b) => a + b, 0);
    setTip({
      x: margin.left + band * i + band / 2,
      y: margin.top + y(total) - 60,
      title: d.title,
      rows: [...series]
        .map((s, si) => ({ color: s.color, label: s.label, value: duration(d.values[si] ?? 0) }))
        .reverse(),
    });
  }
  function hide() {
    setHover(null);
    setTip(null);
  }

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }} onPointerLeave={hide}>
      <svg width={width} height={height} role="img" aria-label="Active and idle time per day" style={{ display: "block" }}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          {ticks.map((t) => (
            <g key={t} transform={`translate(0,${y(t)})`}>
              <line x1={0} x2={innerW} stroke={colors.hairline} strokeWidth={1} />
              <text x={-8} dy="0.32em" textAnchor="end" fontSize={11} fill={colors.textMuted}>
                {tickLabel(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = band * i + band / 2;
            const x = cx - barW / 2;
            let acc = 0;
            const lastNonZero = d.values.reduce((last, v, si) => (v > 0 ? si : last), -1);
            const segs = d.values.map((v, si) => {
              if (v <= 0) return null;
              const y0 = y(acc);
              acc += v;
              const y1 = y(acc);
              // 2px surface gap above every segment that has one stacked on it.
              const gap = si < lastNonZero ? 2 : 0;
              const h = Math.max(0, y0 - y1 - gap);
              if (h <= 0) return null;
              const yTop = y1 + gap;
              const path =
                si === lastNonZero ? topRoundedRect(x, y1, barW, y0 - y1, 4) : `M${x},${yTop}h${barW}v${h}h${-barW}Z`;
              return <path key={si} d={path} fill={series[si].color} opacity={hover && hover !== d.key ? 0.55 : 1} />;
            });
            return (
              <g key={d.key}>
                {segs}
                {/* Hit target: the whole band, taller than the mark. */}
                <rect
                  x={band * i}
                  y={0}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${d.title}: ${series.map((s, si) => `${s.label} ${duration(d.values[si] ?? 0)}`).join(", ")}`}
                  onPointerEnter={() => show(d, i)}
                  onPointerMove={() => show(d, i)}
                  onFocus={() => show(d, i)}
                  onBlur={hide}
                  style={{ outline: "none" }}
                />
                {i % labelEvery === 0 && (
                  <text x={cx} y={innerH + 18} textAnchor="middle" fontSize={11} fill={colors.textMuted}>
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="#2c3a57" strokeWidth={1} />
        </g>
      </svg>
      {tip && <Tooltip t={tip} containerWidth={width} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars: one series, value at the tip
// ---------------------------------------------------------------------------

export interface BarDatum {
  label: string;
  value: number; // seconds
}

export function HorizontalBars({ data, color }: { data: BarDatum[]; color: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const rowH = 30;
  const barH = 18;
  const labelW = Math.min(180, Math.max(90, width * 0.28));
  const valueW = 64;
  const innerW = Math.max(40, width - labelW - valueW - 8);
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((a, d) => a + d.value, 0);
  const height = data.length * rowH + 4;

  function show(d: BarDatum, i: number) {
    setHover(i);
    setTip({
      x: labelW + (d.value / max) * innerW,
      y: i * rowH - 52,
      title: d.label,
      rows: [{ color, label: `${total ? Math.round((d.value / total) * 100) : 0}% of tracked time`, value: duration(d.value) }],
    });
  }
  function hide() {
    setHover(null);
    setTip(null);
  }

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }} onPointerLeave={hide}>
      <svg width={width} height={height} role="img" aria-label="Top applications by active time" style={{ display: "block" }}>
        {data.map((d, i) => {
          const w = Math.max(2, (d.value / max) * innerW);
          const yy = i * rowH + (rowH - barH) / 2;
          return (
            <g key={d.label + i}>
              <text x={labelW - 10} y={i * rowH + rowH / 2} dy="0.32em" textAnchor="end" fontSize={12} fill={colors.textPrimary}>
                {d.label.length > 26 ? d.label.slice(0, 25) + "…" : d.label}
              </text>
              <path d={rightRoundedRect(labelW, yy, w, barH, 4)} fill={color} opacity={hover !== null && hover !== i ? 0.55 : 1} />
              <text x={labelW + w + 8} y={i * rowH + rowH / 2} dy="0.32em" fontSize={12} fill={colors.textSecondary}>
                {duration(d.value)}
              </text>
              <rect
                x={0}
                y={i * rowH}
                width={width}
                height={rowH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${d.label}: ${duration(d.value)}`}
                onPointerEnter={() => show(d, i)}
                onPointerMove={() => show(d, i)}
                onFocus={() => show(d, i)}
                onBlur={hide}
                style={{ outline: "none" }}
              />
            </g>
          );
        })}
      </svg>
      {tip && <Tooltip t={tip} containerWidth={width} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tile & meter
// ---------------------------------------------------------------------------

export function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 13, color: colors.textSecondary }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4 }}>{value}</div>
      {note && <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

/** Active share meter: the track is a darker step of the same blue. */
export function ShareMeter({ share }: { share: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, share)) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div aria-hidden style={{ flex: 1, minWidth: 60, height: 6, borderRadius: 3, background: "#1c3354" }}>
        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: colors.active }} />
      </div>
      <span style={{ fontSize: 12, color: colors.textSecondary, width: 34, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}
