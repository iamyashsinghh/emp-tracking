import {
  ActivityEvent,
  DeviceConfigResponse,
  EnrollDeviceInput,
  MediaUploadRequest,
  MediaUploadResponse,
} from "@emptrack/shared";
import { config } from "./config";

async function request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as any) };
  if (init.auth && config.deviceToken) headers.Authorization = `Bearer ${config.deviceToken}`;
  const res = await fetch(`${config.serverUrl}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const apiClient = {
  async enroll(input: EnrollDeviceInput) {
    return request<{ deviceId: string; tenantId: string; token: string }>("/api/agent/enroll", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async fetchConfig() {
    return request<DeviceConfigResponse>("/api/agent/config", { method: "GET", auth: true });
  },

  async sendActivity(events: ActivityEvent[]) {
    return request<{ accepted: number }>("/api/agent/activity", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ events }),
    });
  },

  async requestMediaUpload(req: MediaUploadRequest) {
    return request<MediaUploadResponse>("/api/agent/media/upload-url", {
      method: "POST",
      auth: true,
      body: JSON.stringify(req),
    });
  },

  async confirmMedia(mediaId: string, sizeBytes: number) {
    return request<{ ok: boolean }>(`/api/agent/media/${mediaId}/confirm`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ sizeBytes }),
    });
  },

  /** Direct PUT of media bytes to the presigned storage URL. */
  async putBytes(url: string, headers: Record<string, string>, body: Buffer | Blob) {
    const res = await fetch(url, { method: "PUT", headers, body: body as any });
    if (!res.ok) throw new Error(`media PUT failed: ${res.status}`);
  },
};
