import { contextBridge, ipcRenderer } from "electron";

/**
 * Minimal, locked-down bridge for the hidden capture renderer. It can only
 * receive begin/stop commands and send finished chunks (and a "stopped" signal)
 * back to the main process — nothing else.
 */
export interface CaptureBeginOptions {
  session: number;
  sourceId: string;
  chunkSeconds: number;
  fps: number;
  maxWidth: number;
  maxHeight: number;
  videoBitsPerSecond: number;
}

contextBridge.exposeInMainWorld("capture", {
  onBegin: (cb: (opts: CaptureBeginOptions) => void) =>
    ipcRenderer.on("recorder:begin", (_e, opts) => cb(opts)),
  onStop: (cb: () => void) => ipcRenderer.on("recorder:stop", () => cb()),
  sendChunk: (session: number, buffer: ArrayBuffer, startedAt: string, durationSeconds: number) =>
    ipcRenderer.invoke("recorder:chunk", { session, buffer, startedAt, durationSeconds }),
  reportStopped: (session: number) => ipcRenderer.invoke("recorder:stopped", { session }),
});
