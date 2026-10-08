import { ChildProcess, execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import type { GlobalSetupContext } from "vitest/node";
import { testEnv } from "../../packages/test-utils/vitest.shared";

/**
 * Boots the stack once for the whole e2e run:
 *   1. pushes the Prisma schema into a fresh database (DATABASE_URL),
 *   2. starts the built backend (apps/backend/dist) on E2E_PORT,
 *   3. waits for /health, and hands the base URL to tests via inject("apiUrl").
 *
 * Needs `npm run build:shared && npm run build -w apps/backend` first, plus a
 * reachable Postgres. MinIO is optional: the backend logs and carries on
 * without it, and the e2e flow does not upload media yet.
 */

const root = path.resolve(__dirname, "../..");
const backendDir = path.join(root, "apps/backend");
let server: ChildProcess | undefined;

declare module "vitest" {
  export interface ProvidedContext {
    apiUrl: string;
    databaseUrl: string;
  }
}

async function waitForHealth(url: string, timeoutMs: number, logs: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode != null) throw new Error(`backend exited early (${server.exitCode}):\n${logs()}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend did not become healthy at ${url} within ${timeoutMs}ms:\n${logs()}`);
}

export default async function setup({ provide }: GlobalSetupContext) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("e2e needs DATABASE_URL pointing at a throwaway Postgres database (it is reset).");
  }
  const entry = path.join(backendDir, "dist/index.js");
  if (!fs.existsSync(entry)) {
    throw new Error("Backend is not built. Run: npm run build:shared && npm run build -w apps/backend");
  }

  const env = { ...process.env, ...testEnv, DATABASE_URL: databaseUrl };

  // Fresh schema every run. --force-reset drops all data, hence the throwaway DB.
  execFileSync("npx", ["prisma", "db", "push", "--force-reset", "--skip-generate", "--accept-data-loss"], {
    cwd: backendDir,
    env,
    stdio: "inherit",
  });

  const port = process.env.E2E_PORT ?? "4100";
  const apiUrl = `http://127.0.0.1:${port}`;
  let output = "";
  server = spawn(process.execPath, [entry], {
    cwd: backendDir,
    env: { ...env, BACKEND_PORT: port, CORS_ORIGINS: "http://localhost:3000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => (output += d));
  server.stderr?.on("data", (d) => (output += d));

  await waitForHealth(apiUrl, 60_000, () => output);
  provide("apiUrl", apiUrl);
  provide("databaseUrl", databaseUrl);

  return async () => {
    if (!server || server.exitCode != null) return;
    server.kill("SIGTERM");
    await new Promise((r) => server!.once("exit", r));
    if (process.env.E2E_DEBUG) console.log(output);
  };
}
