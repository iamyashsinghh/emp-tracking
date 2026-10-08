import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("enroll", {
  defaults: (): Promise<{ serverUrl: string }> => ipcRenderer.invoke("enroll:defaults"),
  submit: (token: string, serverUrl: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("enroll:submit", { token, serverUrl }),
});
