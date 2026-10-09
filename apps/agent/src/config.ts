import { safeStorage } from "electron";
import Store from "electron-store";
import { DevicePolicy, devicePolicySchema } from "@emptrack/shared";

/**
 * Local persisted agent state: the server URL, the device token obtained at
 * enrollment, and the last policy we fetched (used until the next poll).
 *
 * The device token is a long-lived credential, so it is never written in
 * plain text when the OS offers a keychain: it is sealed with Electron's
 * safeStorage (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
 * Linux) and only the ciphertext lands in the store file.
 */
interface AgentState {
  serverUrl: string;
  /** safeStorage-encrypted device token, base64. */
  deviceTokenEnc?: string;
  /** Plain-text fallback, only used when no OS keychain is available. */
  deviceToken?: string;
  deviceId?: string;
  tenantId?: string;
  enrolledAt?: string;
  policy?: DevicePolicy;
  consentAcceptedAt?: string;
  /** The capture features the employee was told about when they acknowledged. */
  consentScope?: ConsentScope;
  autostart: boolean;
}

/** What the employee has been notified about. A wider policy re-prompts. */
export interface ConsentScope {
  activity: boolean;
  screenshots: boolean;
  recording: boolean;
}

/** Server URL baked in at build time by scripts/copy-assets.js, if any. */
function builtInServerUrl(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("./build-config.json") as { serverUrl?: string }).serverUrl || undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_SERVER_URL =
  process.env.EMPTRACK_SERVER_URL || builtInServerUrl() || "http://localhost:4002";

const store = new Store<AgentState>({
  name: "emptrack-agent",
  defaults: {
    serverUrl: DEFAULT_SERVER_URL,
    autostart: true,
  },
});

/** Normalises and validates a server URL (http/https only, no trailing slash). */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Server URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Server URL must start with http:// or https://");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    // safeStorage throws before app "ready"; treat as unavailable.
    return false;
  }
}

function readToken(): string | undefined {
  const enc = store.get("deviceTokenEnc");
  if (enc && canEncrypt()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      // Keychain entry changed (e.g. OS profile reset): the token is unusable.
      return undefined;
    }
  }
  const plain = store.get("deviceToken");
  // Upgrade a legacy/fallback plain-text token once a keychain is available.
  if (plain && canEncrypt()) writeToken(plain);
  return plain;
}

function writeToken(token: string) {
  if (canEncrypt()) {
    store.set("deviceTokenEnc", safeStorage.encryptString(token).toString("base64"));
    store.delete("deviceToken");
  } else {
    console.warn("[config] OS keychain unavailable; storing device token unencrypted");
    store.set("deviceToken", token);
    store.delete("deviceTokenEnc");
  }
}

export const config = {
  get serverUrl() {
    return store.get("serverUrl");
  },
  get deviceToken() {
    return readToken();
  },
  get deviceId() {
    return store.get("deviceId");
  },
  get tenantId() {
    return store.get("tenantId");
  },
  get isEnrolled() {
    return Boolean(store.get("deviceId") && (store.get("deviceTokenEnc") || store.get("deviceToken")));
  },
  /** True when the token is sealed by the OS keychain rather than stored in clear. */
  get tokenEncrypted() {
    return Boolean(store.get("deviceTokenEnc"));
  },
  get policy(): DevicePolicy {
    const p = store.get("policy");
    const parsed = p ? devicePolicySchema.safeParse(p) : null;
    return parsed?.success ? parsed.data : devicePolicySchema.parse({});
  },
  get consentAcceptedAt() {
    return store.get("consentAcceptedAt");
  },
  get consentScope(): ConsentScope | undefined {
    return store.get("consentScope");
  },
  get autostart() {
    return store.get("autostart");
  },
  setServerUrl(url: string) {
    store.set("serverUrl", normalizeServerUrl(url));
  },
  setEnrollment(deviceId: string, tenantId: string, token: string) {
    writeToken(token);
    store.set("deviceId", deviceId);
    store.set("tenantId", tenantId);
    store.set("enrolledAt", new Date().toISOString());
  },
  /** Forget the device credentials, e.g. when the server revoked the device. */
  clearEnrollment() {
    for (const key of ["deviceTokenEnc", "deviceToken", "deviceId", "tenantId", "enrolledAt", "policy"] as const) {
      store.delete(key);
    }
  },
  setPolicy(policy: DevicePolicy) {
    store.set("policy", policy);
  },
  acceptConsent(scope: ConsentScope) {
    store.set("consentAcceptedAt", new Date().toISOString());
    store.set("consentScope", scope);
  },
  setAutostart(enabled: boolean) {
    store.set("autostart", enabled);
  },
};
