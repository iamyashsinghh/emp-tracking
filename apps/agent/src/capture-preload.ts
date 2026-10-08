import { contextBridge, ipcRenderer } from "electron";

/**
 * Minimal, locked-down bridge for the hidden capture renderer. It can only
 * receive begin-chunk / end-chunk commands and deliver a finished chunk back to
 * the main process — nothing else.
 */
export interface ChunkRequest {
  session: number;
  seq: number;
  sourceId: string;
  fps: number;
  bitsPerSecond: number;
}

contextBridge.exposeInMainWorld("capture", {
  onBeginChunk: (cb: (req: ChunkRequest) => void) =>
    ipcRenderer.on("recorder:begin-chunk", (_e, req) => cb(req)),
  onEndChunk: (cb: () => void) => ipcRenderer.on("recorder:end-chunk", () => cb()),
  deliverChunk: (session: number, seq: number, buffer: ArrayBuffer, durationSeconds: number) =>
    ipcRenderer.invoke("recorder:chunk", { session, seq, buffer, durationSeconds }),
});
