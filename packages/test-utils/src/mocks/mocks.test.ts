import { describe, expect, it } from "vitest";
import Store from "./electron-store";
import activeWin from "./active-win";
import { BrowserWindow, powerMonitor } from "./electron";

describe("agent mocks", () => {
  it("electron-store keeps state per name and honours defaults", () => {
    Store.resetAll();
    const a = new Store<{ serverUrl: string; token?: string }>({ name: "x", defaults: { serverUrl: "http://s" } });
    a.set("token", "t");
    const b = new Store<{ serverUrl: string; token?: string }>({ name: "x" });
    expect(b.get("serverUrl")).toBe("http://s");
    expect(b.get("token")).toBe("t");
    b.delete("token");
    expect(a.has("token")).toBe(false);
  });

  it("electron fakes are overridable", async () => {
    powerMonitor.getSystemIdleTime.mockReturnValueOnce(900);
    expect(powerMonitor.getSystemIdleTime()).toBe(900);
    const win = new BrowserWindow({ show: false });
    expect(BrowserWindow.instances).toContain(win);
    expect((await activeWin())?.owner.name).toBe("Code");
  });
});
