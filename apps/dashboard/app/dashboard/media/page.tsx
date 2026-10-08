"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dayKey, duration, listMedia, MEDIA_PAGE_CAP, MediaItem } from "../reports/_shared/data";
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
} from "../reports/_shared/ui";

type Kind = "" | "SCREENSHOT" | "RECORDING";

const KINDS: { id: Kind; label: string }[] = [
  { id: "", label: "All" },
  { id: "SCREENSHOT", label: "Screenshots" },
  { id: "RECORDING", label: "Recordings" },
];

export default function MediaPage() {
  const ready = useRequireAuth();
  const { employees, byId, error: employeesError } = useEmployees();
  const [filters, setFilters] = useState<Filters>(() => defaultFilters("today"));
  const [kind, setKind] = useState<Kind>("");
  const [items, setItems] = useState<MediaItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const requestId = useRef(0);

  const range = useMemo(() => rangeFor(filters), [filters]);

  const load = useCallback(
    async (append: boolean) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        // Results are newest-first. /api/media pages by cursor; the legacy
        // feed pages by moving `to` to just before the oldest item we have.
        const oldest = append && items.length ? new Date(items[items.length - 1].capturedAt) : null;
        const page = await listMedia({
          range: { from: range.from, to: oldest && !nextCursor ? new Date(oldest.getTime() - 1) : range.to },
          userId: filters.userId || undefined,
          kind: kind || undefined,
          cursor: append ? nextCursor : null,
        });
        if (id !== requestId.current) return;
        setItems((prev) => {
          if (!append) return page.items;
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
        });
        setNextCursor(page.nextCursor);
        setHasMore(page.legacy ? page.items.length >= MEDIA_PAGE_CAP : page.nextCursor !== null);
      } catch (e) {
        if (id === requestId.current) setError((e as Error).message);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [items, nextCursor, range, filters.userId, kind]
  );

  // Presigned URLs are short-lived: if one fails to load, refresh the list
  // once per filter selection (a second failure means the object is gone).
  const refreshed = useRef(false);
  const onMediaError = useCallback(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    load(false);
  }, [load]);

  // Reload from the top whenever the filters change.
  useEffect(() => {
    if (!ready) return;
    refreshed.current = false;
    setOpenIndex(null);
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, range, filters.userId, kind]);

  const groups = useMemo(() => {
    const out: { day: string; label: string; entries: { item: MediaItem; index: number }[] }[] = [];
    items.forEach((item, index) => {
      const d = new Date(item.capturedAt);
      const key = dayKey(d);
      let g = out[out.length - 1];
      if (!g || g.day !== key) {
        g = {
          day: key,
          label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
          entries: [],
        };
        out.push(g);
      }
      g.entries.push({ item, index });
    });
    return out;
  }, [items]);

  const counts = useMemo(() => {
    let shots = 0;
    let recs = 0;
    for (const i of items) i.kind === "SCREENSHOT" ? shots++ : recs++;
    return { shots, recs };
  }, [items]);

  const employeeName = filters.userId ? byId.get(filters.userId)?.name : undefined;

  if (!ready) return null;

  return (
    <Shell title="Screenshots & recordings">
      <FilterBar filters={filters} onChange={setFilters} employees={employees}>
        <div role="group" aria-label="Media type" style={{ display: "flex", gap: 6 }}>
          {KINDS.map((k) => (
            <Button key={k.id || "all"} pressed={kind === k.id} onClick={() => setKind(k.id)}>
              {k.label}
            </Button>
          ))}
        </div>
      </FilterBar>
      {employeesError && <Notice tone="error">Could not load employees: {employeesError}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <Section
        title={`${employeeName ?? "All employees"} · ${counts.shots} screenshot${counts.shots === 1 ? "" : "s"}, ${counts.recs} recording${counts.recs === 1 ? "" : "s"}${hasMore ? "+" : ""}`}
        actions={
            <Button
            onClick={() => {
              refreshed.current = false;
              load(false);
            }}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </Button>
        }
      >
        <div style={{ opacity: loading && items.length ? 0.55 : 1, transition: "opacity 120ms" }}>
          {groups.map((g) => (
            <div key={g.day} style={{ marginBottom: 22 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: colors.textSecondary, margin: "0 0 10px" }}>{g.label}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                {g.entries.map(({ item, index }) => (
                  <Thumb
                    key={item.id}
                    item={item}
                    who={!filters.userId && item.userId ? byId.get(item.userId)?.name : undefined}
                    onOpen={() => setOpenIndex(index)}
                    onError={onMediaError}
                  />
                ))}
              </div>
            </div>
          ))}
          {!loading && items.length === 0 && !error && (
            <p style={{ color: colors.textSecondary, margin: 0 }}>No media captured for this filter.</p>
          )}
        </div>
        {hasMore && (
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => load(true)} disabled={loading}>
              {loading ? "Loading…" : "Load older"}
            </Button>
          </div>
        )}
      </Section>

      {openIndex !== null && items[openIndex] && (
        <Viewer
          items={items}
          index={openIndex}
          employeeName={(items[openIndex].userId && byId.get(items[openIndex].userId!)?.name) || employeeName}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          onError={onMediaError}
        />
      )}
    </Shell>
  );
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function Thumb({
  item,
  who,
  onOpen,
  onError,
}: {
  item: MediaItem;
  who?: string;
  onOpen: () => void;
  onError: () => void;
}) {
  const label = `${item.kind === "SCREENSHOT" ? "Screenshot" : "Recording"}${who ? ` of ${who}` : ""} at ${new Date(item.capturedAt).toLocaleString()}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${label}`}
      style={{
        position: "relative",
        padding: 0,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        overflow: "hidden",
        background: "#0b1220",
        cursor: "pointer",
        aspectRatio: "16 / 10",
        display: "block",
        width: "100%",
      }}
    >
      {item.kind === "SCREENSHOT" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.url}
          alt=""
          loading="lazy"
          onError={onError}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <video
          src={item.url}
          preload="metadata"
          muted
          playsInline
          onError={onError}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", pointerEvents: "none" }}
        />
      )}
      {item.kind === "RECORDING" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: "#fff",
            fontSize: 28,
            textShadow: "0 1px 6px rgba(0,0,0,.7)",
          }}
        >
          ▶
        </span>
      )}
      <span
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          justifyContent: "space-between",
          padding: "16px 8px 6px",
          fontSize: 12,
          color: "#fff",
          background: "linear-gradient(transparent, rgba(0,0,0,.75))",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {timeLabel(item.capturedAt)}
          {who ? ` · ${who}` : ""}
        </span>
        {item.kind === "RECORDING" && item.durationSeconds != null && <span>{duration(item.durationSeconds)}</span>}
      </span>
    </button>
  );
}

function Viewer({
  items,
  index,
  employeeName,
  onIndex,
  onClose,
  onError,
}: {
  items: MediaItem[];
  index: number;
  employeeName?: string;
  onIndex: (i: number) => void;
  onClose: () => void;
  onError: () => void;
}) {
  const item = items[index];
  const prev = index > 0 ? index - 1 : null; // newer
  const next = index < items.length - 1 ? index + 1 : null; // older

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && prev !== null) onIndex(prev);
      else if (e.key === "ArrowRight" && next !== null) onIndex(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onIndex, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Media viewer"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(3,6,12,.88)",
        display: "flex",
        flexDirection: "column",
        padding: 16,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}
      >
        <div style={{ fontSize: 14 }}>
          <strong>{item.kind === "SCREENSHOT" ? "Screenshot" : "Recording"}</strong>
          <span style={{ color: colors.textSecondary }}>
            {" · "}
            {new Date(item.capturedAt).toLocaleString()}
            {employeeName ? ` · ${employeeName}` : ""}
            {item.kind === "RECORDING" && item.durationSeconds != null ? ` · ${duration(item.durationSeconds)}` : ""}
            {` · ${index + 1} of ${items.length}`}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={() => prev !== null && onIndex(prev)} disabled={prev === null}>
            ← Newer
          </Button>
          <Button onClick={() => next !== null && onIndex(next)} disabled={next === null}>
            Older →
          </Button>
          <a href={item.url} target="_blank" rel="noreferrer" style={{ ...linkButton }}>
            Open original
          </a>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()} style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center" }}>
        {item.kind === "SCREENSHOT" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={item.id}
            src={item.url}
            alt={`Screenshot at ${new Date(item.capturedAt).toLocaleString()}`}
            onError={onError}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 6 }}
          />
        ) : (
          <video
            key={item.id}
            src={item.url}
            controls
            autoPlay
            playsInline
            onError={onError}
            style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 6, background: "#000" }}
          />
        )}
      </div>
    </div>
  );
}

const linkButton: React.CSSProperties = {
  background: "#0f1728",
  color: colors.textPrimary,
  border: "1px solid #2c3a57",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 14,
  textDecoration: "none",
};
