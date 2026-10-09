# EmpTrack Agent

Cross-platform desktop monitoring agent (Windows, macOS, Linux) built on Electron.

## What it collects

- **Activity** — foreground app, window title, browser URL, sampled every `activitySampleSeconds`.
- **Idle time** — transitions tracked against `idleThresholdSeconds`.
- **Screenshots** — periodic JPEG of the primary display every `screenshotIntervalSeconds` (optional privacy blur).
- **Screen recording** — rotating WebM chunks every `recordingChunkSeconds` at `recordingFps`, only when enabled in policy.

All intervals and toggles come from the server policy and can be changed per company from the admin dashboard; the agent re-reads policy every 60s.

## Transparency

This is a visible, consent-based workplace tool, not covert software:

- A **tray icon** stays present whenever monitoring is active.
- On first run the agent shows a **monitoring notice** to the employee and records the acknowledgement.
- It only runs on **company-managed devices** that admins enroll with a one-time token.

Deploy only on devices you are authorized to monitor, and follow the monitoring/notice laws that apply to your employees' locations.

## Run in development

```bash
npm install                      # from repo root
npm run build:shared
npm run dev -w apps/agent        # builds + launches Electron
```

On first launch, paste the enrollment token printed by the backend seed (`npm run prisma:seed`) and point it at `http://localhost:4002`.

### macOS permissions

`active-win` and screen capture need **Screen Recording** and **Accessibility** permission (System Settings → Privacy & Security). Grant them to the agent (or to your terminal/Electron in dev) or activity + screenshots stay empty.

## Package installers

```bash
npm run dist -w apps/agent       # electron-builder → dmg / nsis / AppImage
```
