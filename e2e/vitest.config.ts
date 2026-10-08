import path from "path";
import { defineConfig } from "vitest/config";
import { sharedAliases, testEnv } from "../packages/test-utils/vitest.shared";

// End-to-end suite: real Postgres + the built backend process, driven over
// HTTP the way the agent and dashboard drive it. Run from the repo root:
//   DATABASE_URL=postgresql://... npm run test:e2e
export default defineConfig({
  root: path.resolve(__dirname, ".."),
  resolve: { alias: sharedAliases },
  test: {
    name: "e2e",
    include: ["e2e/**/*.e2e.test.ts"],
    environment: "node",
    globalSetup: ["e2e/setup/global-setup.ts"],
    env: testEnv,
    // One backend, one database: files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
