/**
 * Deterministic counters so factories produce stable, unique values within a
 * test run (emails, slugs, hostnames) without pulling in a faker library.
 */
let counter = 0;

export function nextSeq(): number {
  counter += 1;
  return counter;
}

export function resetSequence(): void {
  counter = 0;
}

/** A unique, readable id for in-memory rows: `prefix_<n>`. */
export function fakeId(prefix: string): string {
  return `${prefix}_${nextSeq().toString().padStart(4, "0")}`;
}
