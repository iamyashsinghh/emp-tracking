/**
 * In-memory replacement for `electron-store` (which needs a real Electron
 * app to locate userData). Same get/set/delete/clear surface the agent uses.
 * Every instance with the same `name` shares state, like the real file would;
 * call `ElectronStoreMock.resetAll()` in a beforeEach for isolation.
 */
type Options<T> = { name?: string; defaults?: Partial<T> };

const stores = new Map<string, Record<string, unknown>>();

export default class ElectronStoreMock<T extends Record<string, any> = Record<string, unknown>> {
  private readonly key: string;
  private readonly defaults: Partial<T>;

  constructor(opts: Options<T> = {}) {
    this.key = opts.name ?? "config";
    this.defaults = opts.defaults ?? {};
    if (!stores.has(this.key)) stores.set(this.key, { ...this.defaults });
  }

  static resetAll(): void {
    stores.clear();
  }

  private get data(): Record<string, unknown> {
    if (!stores.has(this.key)) stores.set(this.key, { ...this.defaults });
    return stores.get(this.key)!;
  }

  get store(): T {
    return { ...this.data } as T;
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.data[key as string] as T[K];
  }

  set<K extends keyof T>(key: K | Partial<T>, value?: T[K]): void {
    if (typeof key === "object") Object.assign(this.data, key);
    else this.data[key as string] = value;
  }

  has(key: keyof T): boolean {
    return key in this.data;
  }

  delete(key: keyof T): void {
    delete this.data[key as string];
  }

  clear(): void {
    stores.set(this.key, { ...this.defaults });
  }
}
