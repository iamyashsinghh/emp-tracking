/**
 * Lets test files written against Node's built-in runner (`node:test`) run
 * unchanged under vitest: every workspace config aliases `node:test` here.
 * `node:assert` needs no shim; its errors fail vitest tests normally.
 * New tests should import from "vitest" directly.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, test, vi } from "vitest";

export { afterEach, beforeEach, describe, it, test };
export const before = beforeAll;
export const after = afterAll;
export const suite = describe;
export const mock = {
  fn: vi.fn,
  method: vi.spyOn,
  restoreAll: vi.restoreAllMocks,
  reset: vi.resetAllMocks,
};

export default test;
