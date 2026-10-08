import Store from "electron-store";
import { DevicePolicy, devicePolicySchema } from "@emptrack/shared";

/**
 * Local persisted agent state: the server URL, the device token obtained at
 * enrollment, and the last policy we fetched (used until the next poll).
 */
interface AgentState {
  serverUrl: string;
  deviceToken?: string;
  deviceId?: string;
  tenantId?: string;
  policy?: DevicePolicy;
  consentAcceptedAt?: string;
}

const store = new Store<AgentState>({
  name: "emptrack-agent",
  defaults: {
    serverUrl: process.env.EMPTRACK_SERVER_URL || "http://localhost:4000",
  },
});

export const config = {
  get serverUrl() {
    return store.get("serverUrl");
  },
  get deviceToken() {
    return store.get("deviceToken");
  },
  get deviceId() {
    return store.get("deviceId");
  },
  get isEnrolled() {
    return Boolean(store.get("deviceToken"));
  },
  get policy(): DevicePolicy {
    const p = store.get("policy");
    return p ? devicePolicySchema.parse(p) : devicePolicySchema.parse({});
  },
  get consentAcceptedAt() {
    return store.get("consentAcceptedAt");
  },
  setServerUrl(url: string) {
    store.set("serverUrl", url);
  },
  setEnrollment(deviceId: string, tenantId: string, token: string) {
    store.set("deviceId", deviceId);
    store.set("tenantId", tenantId);
    store.set("deviceToken", token);
  },
  setPolicy(policy: DevicePolicy) {
    store.set("policy", policy);
  },
  acceptConsent() {
    store.set("consentAcceptedAt", new Date().toISOString());
  },
};
