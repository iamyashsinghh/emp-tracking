import { defineProject } from "vitest/config";
import {
  baseTest,
  electronAliases,
  sharedAliases,
} from "../../packages/test-utils/vitest.shared";

// electron, electron-store and active-win are swapped for in-memory fakes
// from @emptrack/test-utils/mocks so agent logic runs under plain Node.
export default defineProject({
  resolve: { alias: { ...sharedAliases, ...electronAliases } },
  test: {
    ...baseTest,
    name: "agent",
    environment: "node",
    env: { EMPTRACK_SERVER_URL: "http://agent-test.local" },
  },
});
