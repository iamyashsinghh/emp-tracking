import { EventEmitter } from "events";
import { vi } from "vitest";

/**
 * Minimal in-memory stand-in for the `electron` module so agent code can be
 * unit tested under plain Node. Agent vitest config aliases `electron` here.
 * Every API is a vi.fn, so tests can assert on calls or override behaviour:
 *   vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(600)
 */

export const app = Object.assign(new EventEmitter(), {
  getVersion: vi.fn(() => "0.0.0-test"),
  getPath: vi.fn((name: string) => `/tmp/emptrack-test/${name}`),
  whenReady: vi.fn(() => Promise.resolve()),
  quit: vi.fn(),
  isPackaged: false,
  dock: { hide: vi.fn(), show: vi.fn() },
  requestSingleInstanceLock: vi.fn(() => true),
  setLoginItemSettings: vi.fn(),
});

export const powerMonitor = Object.assign(new EventEmitter(), {
  getSystemIdleTime: vi.fn(() => 0),
  getSystemIdleState: vi.fn(() => "active"),
});

export const screen = {
  getPrimaryDisplay: vi.fn(() => ({
    id: 1,
    size: { width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1080 },
    scaleFactor: 1,
  })),
  getAllDisplays: vi.fn(() => [screen.getPrimaryDisplay()]),
};

export const desktopCapturer = {
  getSources: vi.fn(async () => [] as unknown[]),
};

export const ipcMain = Object.assign(new EventEmitter(), {
  handle: vi.fn(),
  removeHandler: vi.fn(),
});

export const ipcRenderer = Object.assign(new EventEmitter(), {
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
});

export const contextBridge = { exposeInMainWorld: vi.fn() };

export const dialog = {
  showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  showErrorBox: vi.fn(),
};

export const nativeImage = {
  createEmpty: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
  createFromPath: vi.fn(() => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) })),
  createFromBuffer: vi.fn(() => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) })),
};

export const Menu = {
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn(),
};

export class Tray extends EventEmitter {
  setToolTip = vi.fn();
  setContextMenu = vi.fn();
  setImage = vi.fn();
  destroy = vi.fn();
  constructor(public image?: unknown) {
    super();
  }
}

export class BrowserWindow extends EventEmitter {
  static instances: BrowserWindow[] = [];
  webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
  loadFile = vi.fn(async () => undefined);
  loadURL = vi.fn(async () => undefined);
  show = vi.fn();
  hide = vi.fn();
  close = vi.fn(() => this.emit("closed"));
  destroy = vi.fn();
  isDestroyed = vi.fn(() => false);
  constructor(public options: Record<string, unknown> = {}) {
    super();
    BrowserWindow.instances.push(this);
  }
}

export default {
  app,
  powerMonitor,
  screen,
  desktopCapturer,
  ipcMain,
  ipcRenderer,
  contextBridge,
  dialog,
  nativeImage,
  Menu,
  Tray,
  BrowserWindow,
};
