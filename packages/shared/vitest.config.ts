import { defineProject } from "vitest/config";
import { baseTest, sharedAliases } from "../test-utils/vitest.shared";

export default defineProject({
  resolve: { alias: sharedAliases },
  test: { ...baseTest, name: "shared", environment: "node" },
});
