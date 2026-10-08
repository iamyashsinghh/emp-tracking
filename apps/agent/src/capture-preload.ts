import { contextBridge, ipcRenderer } from "electron";

// Minimal, locked-down bridge for the hidden capture renderer. It can only
// receive begin/stop commands and send finished chunks back — nothing else.
contextBridge.exposeInMainWorld("capture", {
  onBegin: (cb: (opts: { sourceId: string; chunkSeconds: number; fps: number }) => void) =>
    ipcRenderer.on("recorder:begin", (_e, opts) => cb(opts)),
  onStop: (cb: () => void) => ipcRenderer.on("recorder:stop", () => cb()),
  sendChunk: (buffer: ArrayBuffer, durationSeconds: number) =>
    ipcRenderer.invoke("recorder:chunk", { buffer, durationSeconds }),
});
