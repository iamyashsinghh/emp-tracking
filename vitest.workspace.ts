// `npm test` at the repo root runs every workspace's unit tests in one go.
// The e2e suite is separate (needs Postgres): `npm run test:e2e`.
export default ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"];
