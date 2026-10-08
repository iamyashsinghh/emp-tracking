import path from "path";

/**
 * Settings every workspace's vitest config builds on, so the runners behave
 * the same everywhere. Import this from a workspace config with a relative
 * path (configs load before workspace packages are resolvable).
 */
export const repoRoot = path.resolve(__dirname, "../..");

/**
 * Point @emptrack/shared at its TypeScript source so unit tests never need a
 * prior `npm run build:shared`, and always see the latest contracts. Also maps
 * `node:test` to a vitest shim so tests written for Node's runner still run.
 */
export const sharedAliases: Record<string, string> = {
  "@emptrack/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
  "node:test": path.join(repoRoot, "packages/test-utils/src/node-test-shim.ts"),
};

/** Aliases that swap native/Electron-only modules for in-memory fakes. */
export const electronAliases: Record<string, string> = {
  electron: path.join(repoRoot, "packages/test-utils/src/mocks/electron.ts"),
  "electron-store": path.join(repoRoot, "packages/test-utils/src/mocks/electron-store.ts"),
  "active-win": path.join(repoRoot, "packages/test-utils/src/mocks/active-win.ts"),
};

/** Env every backend-touching test gets unless it overrides it. */
export const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  JWT_SECRET: "test-jwt-secret",
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgresql://emptrack:emptrack@localhost:5432/emptrack_test?schema=public",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "emptrack-test",
};

export const baseTest = {
  globals: false,
  passWithNoTests: true,
  clearMocks: true,
  include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
};
