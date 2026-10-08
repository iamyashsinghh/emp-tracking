import path from "path";
import { defineProject } from "vitest/config";
import { baseTest, sharedAliases } from "../../packages/test-utils/vitest.shared";

export default defineProject({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { ...sharedAliases, "@": path.resolve(__dirname) } },
  test: {
    ...baseTest,
    name: "dashboard",
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    exclude: [...baseTest.exclude, "e2e/**"],
    setupFiles: ["./vitest.setup.ts"],
    env: { NEXT_PUBLIC_API_URL: "http://api.test.local" },
  },
});
