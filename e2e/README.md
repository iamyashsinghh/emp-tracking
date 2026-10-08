# End-to-end tests

Drives the real backend over HTTP against a real Postgres, the same way the
desktop agent and the dashboard do. Unit tests live next to each workspace;
this folder is only for flows that cross apps.

## Run locally

```bash
docker compose up -d postgres
createdb -h localhost -U emptrack emptrack_e2e   # throwaway: it is reset every run
npm run build:shared && npm run build -w apps/backend
DATABASE_URL=postgresql://emptrack:emptrack@localhost:5432/emptrack_e2e npm run test:e2e
```

`E2E_PORT` (default 4100) picks the backend port; `E2E_DEBUG=1` prints the
backend's log after the run.

## How it works

- `setup/global-setup.ts` runs `prisma migrate reset` (all migrations), starts
  `apps/backend/dist/index.js`, and waits for `/health`.
- `support/client.ts` is a small fetch client (`call`, `login`).
- `support/db.ts` gives each spec a Prisma client for seeding with
  `@emptrack/test-utils/db` (`resetDatabase`, `seedTenant`, …).
- Specs are `*.e2e.test.ts` and run one file at a time against one backend.

## Flows

- `enroll-ingest-dashboard.e2e.test.ts`: admin issues an enrollment token →
  agent enrolls → pulls policy → uploads activity (idempotent retry) → admin
  sees the device, the per-app summary and the timeline; another tenant sees
  nothing. Media upload and a browser pass are `it.todo` until those land.
