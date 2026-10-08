import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("enroll", {
  submit: (token: string, serverUrl: string) => ipcRenderer.invoke("enroll:submit", { token, serverUrl }),
});
