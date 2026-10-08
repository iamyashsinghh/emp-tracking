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
3. The agent samples activity + idle, takes screenshots, and (if enabled) records the screen, uploading media straight to S3/MinIO via presigned URLs.
4. The **dashboard** reads per-company activity summaries, timelines, screenshots and recordings.
5. Monitoring **policy** (intervals in seconds, recording on/off, blur, working hours) is set per company and pushed to agents, which re-poll every 60s.

## Quick start (Docker)

```bash
cp .env.example .env            # adjust secrets
docker compose up -d --build    # postgres + minio + backend + dashboard

# first run only: apply schema + seed a demo company
docker compose exec backend npm run prisma:deploy -w apps/backend
docker compose exec backend npm run seed -w apps/backend
```

- Dashboard: http://localhost:3000  (admin@demo.co / admin12345)
- API:       http://localhost:4000/health
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)

The seed prints an **enrollment token** — use it to enroll the agent.

## Local development (without Docker)

```bash
npm install
npm run build:shared

# backend (needs Postgres + MinIO running; `docker compose up -d postgres minio`)
npm run prisma:migrate -w apps/backend
npm run prisma:seed -w apps/backend
npm run dev:backend

# dashboard
npm run dev:dashboard

# agent
npm run dev:agent
```

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
