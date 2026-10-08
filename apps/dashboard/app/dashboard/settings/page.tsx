"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getToken } from "../../../lib/api";
import {
  Card,
  FieldError,
  Label,
  NumberInput,
  Row,
  SecondsField,
  TagList,
  TimeInput,
  Toggle,
  colors,
  primaryButton,
  secondaryButton,
} from "./controls";
import {
  LIMITS,
  POLICY_EDITOR_ROLES,
  Policy,
  PolicyKey,
  diff,
  fetchMe,
  fetchPolicy,
  humanSeconds,
  savePolicy,
  validate,
} from "./policy";

type Status =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

export default function PolicySettingsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [saved, setSaved] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const me = await fetchMe();
        if (!POLICY_EDITOR_ROLES.includes(me.role)) {
          setStatus({ kind: "forbidden" });
          return;
        }
        const policy = await fetchPolicy();
        if (!policy) {
          setStatus({ kind: "error", message: "No monitoring policy exists for this company yet." });
          return;
        }
        setSaved(policy);
        setDraft(policy);
        setStatus({ kind: "ready" });
      } catch (e) {
        setStatus({ kind: "error", message: (e as Error).message });
      }
    })();
  }, [router]);

  const errors = useMemo(() => (draft ? validate(draft) : {}), [draft]);
  const patch = useMemo(() => (saved && draft ? diff(saved, draft) : {}), [saved, draft]);
  const dirty = Object.keys(patch).length > 0;
  const hasErrors = Object.keys(errors).length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function set<K extends PolicyKey>(key: K, value: Policy[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setSavedAt(null);
  }

  async function save() {
    if (!dirty || hasErrors) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await savePolicy(patch);
      setSaved(next);
      setDraft(next);
      setSavedAt(new Date());
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (status.kind === "loading") return <Shell><p style={{ color: colors.muted }}>Loading policy…</p></Shell>;
  if (status.kind === "forbidden") {
    return (
      <Shell>
        <Card title="Admins only">
          <p style={{ color: colors.muted, margin: 0 }}>
            Only the company owner or an admin can view and change monitoring settings.
          </p>
        </Card>
      </Shell>
    );
  }
  if (status.kind === "error" || !draft) {
    return (
      <Shell>
        <p style={{ color: colors.error }}>{status.kind === "error" ? status.message : "Could not load policy."}</p>
      </Shell>
    );
  }

  const master = draft.monitoringEnabled;
  const perDay = (interval: number) => (interval > 0 ? Math.floor((8 * 3600) / interval) : 0);

  return (
    <Shell>
      <Card
        title="Monitoring"
        description="Master switch for every device in your company. When off, agents collect nothing at all."
      >
        <Row>
          <Label
            title="Monitoring enabled"
            hint={master ? "Agents are collecting data using the rules below." : "Paused. All rules below are ignored."}
          />
          <Toggle label="Monitoring enabled" checked={master} onChange={(v) => set("monitoringEnabled", v)} />
        </Row>
      </Card>

      <Card title="Screenshots" description="Periodic still captures of the employee's screen." dimmed={!master}>
        <Row>
          <Label title="Take screenshots" />
          <Toggle label="Take screenshots" checked={draft.screenshotsEnabled} onChange={(v) => set("screenshotsEnabled", v)} />
        </Row>
        <Row>
          <Label
            title="Screenshot interval"
            hint={
              draft.screenshotsEnabled
                ? `One screenshot every ${humanSeconds(draft.screenshotIntervalSeconds)}, about ${perDay(draft.screenshotIntervalSeconds)} in an 8 hour day.`
                : "Screenshots are off."
            }
          />
          <SecondsField
            label="Screenshot interval in seconds"
            value={draft.screenshotIntervalSeconds}
            onChange={(v) => set("screenshotIntervalSeconds", v)}
            {...LIMITS.screenshotIntervalSeconds}
            presets={[30, 60, 300, 600, 900]}
            disabled={!draft.screenshotsEnabled}
          />
          <FieldError message={errors.screenshotIntervalSeconds} />
        </Row>
        <Row>
          <Label title="Blur screenshots" hint="Stores a blurred image so activity is visible but details are not readable." />
          <Toggle
            label="Blur screenshots"
            checked={draft.screenshotBlur}
            onChange={(v) => set("screenshotBlur", v)}
            disabled={!draft.screenshotsEnabled}
          />
        </Row>
        <Row>
          <Label title="Daily screenshot limit" hint="Most screenshots per device per day. 0 means no limit." />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <NumberInput
              label="Daily screenshot limit"
              value={draft.screenshotDailyCap}
              onChange={(v) => set("screenshotDailyCap", v)}
              {...LIMITS.screenshotDailyCap}
              unit="screenshots / day"
              disabled={!draft.screenshotsEnabled}
            />
            <span style={{ color: colors.muted, fontSize: 13, minWidth: 70 }}>
              {draft.screenshotDailyCap === 0 ? "= no limit" : ""}
            </span>
          </span>
          <FieldError message={errors.screenshotDailyCap} />
        </Row>
      </Card>

      <Card title="Screen recording" description="Continuous video of the screen, uploaded in chunks." dimmed={!master}>
        <Row>
          <Label
            title="Record screen"
            hint={draft.screenRecordingEnabled ? "Recording is ON. This uses much more storage than screenshots." : undefined}
          />
          <Toggle
            label="Record screen"
            checked={draft.screenRecordingEnabled}
            onChange={(v) => set("screenRecordingEnabled", v)}
          />
        </Row>
        <Row>
          <Label title="Chunk length" hint="How long each video segment is before it is uploaded." />
          <SecondsField
            label="Recording chunk length in seconds"
            value={draft.recordingChunkSeconds}
            onChange={(v) => set("recordingChunkSeconds", v)}
            {...LIMITS.recordingChunkSeconds}
            presets={[60, 300, 600]}
            disabled={!draft.screenRecordingEnabled}
          />
          <FieldError message={errors.recordingChunkSeconds} />
        </Row>
        <Row>
          <Label title="Frame rate" hint="Lower is lighter on bandwidth and storage." />
          <NumberInput
            label="Recording frames per second"
            value={draft.recordingFps}
            onChange={(v) => set("recordingFps", v)}
            {...LIMITS.recordingFps}
            unit="fps"
            disabled={!draft.screenRecordingEnabled}
          />
          <FieldError message={errors.recordingFps} />
        </Row>
        <Row>
          <Label title="Video quality" hint="Target bitrate. 1500 kbps is a good default; higher means sharper video and bigger files." />
          <NumberInput
            label="Recording bitrate in kbps"
            value={draft.recordingBitrateKbps}
            onChange={(v) => set("recordingBitrateKbps", v)}
            {...LIMITS.recordingBitrateKbps}
            unit="kbps"
            disabled={!draft.screenRecordingEnabled}
          />
          <FieldError message={errors.recordingBitrateKbps} />
        </Row>
        <Row>
          <Label title="Daily recording limit" hint="Most minutes of video per device per day. 0 means no limit." />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <NumberInput
              label="Daily recording limit in minutes"
              value={draft.recordingDailyCapMinutes}
              onChange={(v) => set("recordingDailyCapMinutes", v)}
              {...LIMITS.recordingDailyCapMinutes}
              unit="minutes / day"
              disabled={!draft.screenRecordingEnabled}
            />
            <span style={{ color: colors.muted, fontSize: 13, minWidth: 70 }}>
              = {draft.recordingDailyCapMinutes ? humanSeconds(draft.recordingDailyCapMinutes * 60) : "no limit"}
            </span>
          </span>
          <FieldError message={errors.recordingDailyCapMinutes} />
        </Row>
      </Card>

      <Card title="App & window activity" description="Which app and window is in use, and when the employee is idle." dimmed={!master}>
        <Row>
          <Label title="Track apps and websites" />
          <Toggle
            label="Track apps and websites"
            checked={draft.activityTrackingEnabled}
            onChange={(v) => set("activityTrackingEnabled", v)}
          />
        </Row>
        <Row>
          <Label title="Sample every" hint="How often the agent checks the active window." />
          <SecondsField
            label="Activity sample interval in seconds"
            value={draft.activitySampleSeconds}
            onChange={(v) => set("activitySampleSeconds", v)}
            {...LIMITS.activitySampleSeconds}
            presets={[10, 30, 60]}
            disabled={!draft.activityTrackingEnabled}
          />
          <FieldError message={errors.activitySampleSeconds} />
        </Row>
        <Row>
          <Label title="Idle after" hint="No keyboard or mouse input for this long marks the employee idle." />
          <SecondsField
            label="Idle threshold in seconds"
            value={draft.idleThresholdSeconds}
            onChange={(v) => set("idleThresholdSeconds", v)}
            {...LIMITS.idleThresholdSeconds}
            presets={[120, 300, 600]}
          />
          <FieldError message={errors.idleThresholdSeconds} />
        </Row>
      </Card>

      <Card title="What gets captured" description="Applies to screenshots and screen recording." dimmed={!master}>
        <Row>
          <Label
            title="Active window only"
            hint={
              draft.activeWindowOnly
                ? "ON: only the window the employee is working in is captured."
                : "OFF: the whole screen is captured."
            }
          />
          <Toggle label="Active window only" checked={draft.activeWindowOnly} onChange={(v) => set("activeWindowOnly", v)} />
        </Row>
        <Row>
          <Label
            title="Excluded apps"
            hint="Nothing is captured while one of these apps is in front (for example banking or personal chat)."
          />
          <TagList
            values={draft.excludedApps}
            onChange={(v) => set("excludedApps", v)}
            placeholder="e.g. WhatsApp, KeePass"
          />
        </Row>
      </Card>

      <Card title="Schedule" dimmed={!master}>
        <Row>
          <Label
            title="Working hours"
            hint="Collect only between these times on the employee's local clock. Leave both empty to collect any time."
          />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <TimeInput label="Working hours start" value={draft.workingHoursStart ?? ""} onChange={(v) => set("workingHoursStart", v || null)} />
            <span style={{ color: colors.muted }}>to</span>
            <TimeInput label="Working hours end" value={draft.workingHoursEnd ?? ""} onChange={(v) => set("workingHoursEnd", v || null)} />
          </span>
          <FieldError message={errors.workingHoursStart ?? errors.workingHoursEnd} />
        </Row>
      </Card>

      <Card title="Transparency" description="Employees always know the agent is running. These control how it shows." dimmed={!master}>
        <Row>
          <Label title="Show tray icon" />
          <Toggle label="Show tray icon" checked={draft.showTrayIcon} onChange={(v) => set("showTrayIcon", v)} />
        </Row>
        <Row>
          <Label title="Notify employee when monitoring starts" />
          <Toggle
            label="Notify employee when monitoring starts"
            checked={draft.notifyEmployeeOnStart}
            onChange={(v) => set("notifyEmployeeOnStart", v)}
          />
        </Row>
      </Card>


      <div
        style={{
          position: "sticky",
          bottom: 0,
          marginTop: 24,
          padding: "14px 0",
          background: "#0b1220",
          borderTop: `1px solid ${colors.border}`,
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13, color: saveError ? colors.error : colors.muted, marginRight: "auto" }}>
          {saveError
            ? `Save failed: ${saveError}`
            : hasErrors
              ? "Fix the highlighted fields to save."
              : dirty
                ? "You have unsaved changes."
                : savedAt
                  ? `Saved at ${savedAt.toLocaleTimeString()}. Devices pick this up on their next config check.`
                  : "All changes saved."}
        </span>
        <button type="button" style={secondaryButton} disabled={!dirty || saving} onClick={() => saved && setDraft(saved)}>
          Discard
        </button>
        <button
          type="button"
          style={{ ...primaryButton, opacity: !dirty || hasErrors || saving ? 0.5 : 1 }}
          disabled={!dirty || hasErrors || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "28px 16px" }}>
      <Link href="/dashboard" style={{ color: colors.muted, fontSize: 13, textDecoration: "none" }}>
        ← Back to overview
      </Link>
      <h1 style={{ fontSize: 24, margin: "10px 0 0" }}>Monitoring policy</h1>
      <p style={{ color: colors.muted, fontSize: 14, margin: "4px 0 0" }}>
        Applies to every device in your company. All intervals are in seconds.
      </p>
      {children}
    </main>
  );
}
