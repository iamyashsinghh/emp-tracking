# EmpTrack — Employee Monitoring SaaS

A multi-tenant employee monitoring platform for internal use across multiple companies. A cross-platform desktop agent collects workplace activity, screenshots and screen recordings; a backend API ingests and stores it; an admin dashboard shows it per company.

> **Intended use:** transparent, consent-based monitoring on company-managed devices that you are authorized to monitor. The agent always shows a tray icon and an on-first-run notice to employees. Follow the employee-notice and recording laws that apply where your staff work.

## Architecture

```
emp-tracking/
├── packages/
│   └── shared/        # TypeScript types + zod schemas shared by every app
├── apps/
│   ├── backend/       # Express + Prisma (PostgreSQL) API — admin + agent endpoints
│   ├── dashboard/     # Next.js admin dashboard
│   └── agent/         # Electron desktop agent (Windows / macOS / Linux)
├── docker-compose.yml # Postgres + MinIO (S3) + backend + dashboard
└── .github/workflows  # CI: build shared, backend, dashboard, agent
```

### Multi-tenancy

One database serves every company. A **Tenant** is a company; every tenant-scoped
row (`User`, `Device`, `ActivityLog`, `MediaAsset`) carries `tenantId`, and all
queries are scoped by the caller's tenant for hard isolation. Roles:
`SUPER_ADMIN` (platform owner, manages all tenants), `ADMIN` (one company),
`MANAGER` (views their team), `EMPLOYEE` (monitored).

### Data flow

1. Admin creates a company, adds employees, and issues a one-time **enrollment token** per device.
2. The **agent** redeems the token for a long-lived device token, then shows the employee a monitoring notice.
3. The agent samples activity + idle, takes screenshots, and (if enabled) records the screen, uploading media through short-lived signed URLs to the backend's local storage folder (or S3/MinIO with `STORAGE_DRIVER=s3`).
4. The **dashboard** reads per-company activity summaries, timelines, screenshots and recordings.
5. Monitoring **policy** (intervals in seconds, recording on/off, blur, working hours) is set per company and pushed to agents, which re-poll every 60s.

## Quick start (Docker)

```bash
cp .env.example .env            # adjust secrets
docker compose up -d --build    # postgres + backend (port 4002) + dashboard

# first run only: apply schema + seed a demo company
docker compose exec backend npm run prisma:deploy -w apps/backend
docker compose exec backend npm run seed -w apps/backend
```

- Dashboard: http://localhost:3000  (admin@demo.co / admin12345)
- API:       http://localhost:4002/health

The seed prints an **enrollment token** — use it to enroll the agent.

## Local development (without Docker)

```bash
npm install
npm run build:shared

# backend on :4002 (needs Postgres running; `docker compose up -d postgres`)
# media is written to ./storage (STORAGE_DIR)
npm run prisma:migrate -w apps/backend
npm run prisma:seed -w apps/backend
npm run dev:backend

# dashboard
npm run dev:dashboard

# agent
npm run dev:agent
```

## Using an existing Postgres

`docker compose` starts its own Postgres through the `localdb` profile
(`COMPOSE_PROFILES=localdb` in `.env`). To use a Postgres that already runs on
the host, set `COMPOSE_PROFILES=` (empty) and
`DOCKER_DATABASE_URL=postgresql://<user>:<pass>@host.docker.internal:5432/<db>?schema=public`.
The host Postgres must listen on the Docker bridge (`listen_addresses`) and
allow `172.16.0.0/12` in `pg_hba.conf`.

## Media storage

Screenshots and recordings are stored on disk by default:

| Env var          | Default                 | Meaning |
|------------------|-------------------------|---------|
| `STORAGE_DRIVER` | `local`                 | `local` = files on disk, `s3` = S3/MinIO via the `S3_*` vars |
| `STORAGE_DIR`    | `./storage`             | Root folder; each company gets its own `<tenantId>/` subfolder |
| `PUBLIC_API_URL` | `http://localhost:4002` | Public backend URL used to build the signed upload/download links |

The agent PUTs bytes to `/api/storage/<signed-token>` and the dashboard loads
them from the same kind of link, so nothing else needs to be exposed. In
Docker the folder is the `mediadata` volume. Retention (`MEDIA_RETENTION_DAYS`
or the per-company setting) deletes old files from the folder.

To use S3/MinIO instead: set `STORAGE_DRIVER=s3` and the `S3_*` vars, and for
the bundled MinIO run `docker compose --profile s3 up -d`.

`scripts/smoke-media.mjs` runs the whole upload → store → view flow against a
seeded stack (`API_URL=http://localhost:4002 node scripts/smoke-media.mjs`).

## API surface

| Area       | Endpoint                          | Auth          |
|------------|-----------------------------------|---------------|
| Auth       | `POST /api/auth/login`            | public        |
| Tenants    | `POST/GET /api/tenants`           | super admin   |
| Policy     | `GET/PUT /api/tenants/policy`     | admin         |
| Users      | `GET/POST /api/users`             | admin         |
| Devices    | `POST /api/users/:id/devices`     | admin         |
| Enroll     | `POST /api/agent/enroll`          | enroll token  |
| Config     | `GET /api/agent/config`           | device token  |
| Activity   | `POST /api/agent/activity`        | device token  |
| Media      | `POST /api/agent/media/upload-url`| device token  |
| Reports    | `GET /api/reports/*`              | admin/manager |

## Tech

TypeScript everywhere · Express · Prisma · PostgreSQL · Next.js (App Router) ·
Electron · MinIO/S3 · Docker Compose · zod-validated contracts.

## Status

Scaffold / draft — the structure, data model, API, dashboard and agent capture
loops are in place. Not yet added: Prisma migration files (generated on first
`prisma migrate dev`), automated tests, device-level policy overrides, and
retention/cleanup jobs. See the PR description for the roadmap.
