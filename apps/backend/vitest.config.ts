import { defineProject } from "vitest/config";
import { baseTest, sharedAliases, testEnv } from "../../packages/test-utils/vitest.shared";

// Unit tests run without Postgres: mock ../prisma (vi.mock) and use the
// factories from @emptrack/test-utils. Tests that need a real database belong
// in the repo-level e2e/ suite.
export default defineProject({
  resolve: { alias: sharedAliases },
  test: { ...baseTest, name: "backend", environment: "node", env: testEnv },
});
