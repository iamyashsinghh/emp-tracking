import { vi } from "vitest";

/**
 * Stand-in for `active-win` (native module). Defaults to a VS Code window;
 * override per test: vi.mocked(activeWin).mockResolvedValue(undefined)
 */
export const defaultWindow = {
  title: "index.ts — emp-tracking",
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  owner: { name: "Code", processId: 1234, path: "/usr/bin/code" },
  memoryUsage: 0,
  platform: "linux" as const,
};

const activeWin = vi.fn(async () => defaultWindow as typeof defaultWindow | undefined);

export default activeWin;
