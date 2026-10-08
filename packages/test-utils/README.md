# @emptrack/test-utils

Shared test tooling. Every workspace runs **vitest**:

```bash
npm test                     # all workspaces' unit tests from the repo root
npm test -w apps/backend     # one workspace
npm run test:e2e             # cross-app flows, see e2e/README.md
```

Put unit tests in `<workspace>/test/**/*.test.ts` or next to the code as
`src/**/*.test.ts` (excluded from `tsc` builds). Dashboard tests may be
`.test.tsx` anywhere and run in jsdom with Testing Library + jest-dom.

## What's here

| Import | Use |
| --- | --- |
| `@emptrack/test-utils` | In-memory factories: `buildTenant`, `buildUser`, `buildDevice`, `buildTenantPolicy`, `buildDevicePolicy`, `buildEnrollInput`, `buildActivityEvent(s)`, `buildActivityBatch`, `buildActivityLog`. Token helpers: `userToken`, `deviceToken`, `bearer`. |
| `@emptrack/test-utils/db` | Real-Postgres helpers: `resetDatabase`, `createTenant`, `createUser`, `createPendingDevice`, `seedTenant`. |
| `@emptrack/test-utils/mocks/*` | Fakes for `electron`, `electron-store`, `active-win`. The agent's vitest config aliases them automatically. |

Per-workspace defaults come from `vitest.shared.ts`: `@emptrack/shared`
resolves to its source (no build needed), backend tests get a test
`JWT_SECRET`/`DATABASE_URL`, and `node:test` is mapped to vitest so tests
written for Node's built-in runner run unchanged.
