import { defineProject } from "vitest/config";
import { baseTest, sharedAliases, testEnv } from "./vitest.shared";

export default defineProject({
  resolve: { alias: sharedAliases },
  test: { ...baseTest, name: "test-utils", environment: "node", env: testEnv },
});
