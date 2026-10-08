"use client";

/**
 * Shared dashboard API client.
 *
 * Owns three things every dashboard page needs:
 *  1. Session storage (JWT + signed-in user), persisted in localStorage.
 *  2. Active tenant (company) context, so the owner can switch between
 *     companies without signing out. Sent to the backend as `X-Tenant-Id`.
 *  3. Typed fetch helpers + typed endpoint wrappers (`authApi`, `tenantsApi`, …).
 *
 * Pages should import from here rather than calling `fetch` directly.
 */

import { useSyncExternalStore } from "react";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/** Header the backend reads to scope a SUPER_ADMIN request to one tenant. */
export const TENANT_HEADER = "X-Tenant-Id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
// Response DTOs live here until they are promoted to @emptrack/shared.

export type Role = "SUPER_ADMIN" | "ADMIN" | "MANAGER" | "EMPLOYEE";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The tenant the user belongs to (their "home" company). */
  tenantId: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  createdAt?: string;
  _count?: { users: number; devices: number };
}

export interface Session {
  token: string;
  user: SessionUser;
  /** Company currently being viewed. Defaults to the user's home tenant. */
  activeTenantId: string;
  /** Companies this user may switch between (cached from the API). */
  tenants: TenantSummary[];
}

export interface LoginResponse {
  token: string;
  user: SessionUser;
}

export interface TenantPolicy {
  id: string;
  tenantId: string;
  monitoringEnabled: boolean;
  activityTrackingEnabled: boolean;
  activitySampleSeconds: number;
  idleThresholdSeconds: number;
  screenshotsEnabled: boolean;
  screenshotIntervalSeconds: number;
  screenshotBlur: boolean;
  screenRecordingEnabled: boolean;
  recordingChunkSeconds: number;
  recordingFps: number;
  showTrayIcon: boolean;
  notifyEmployeeOnStart: boolean;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;
  updatedAt: string;
}

export interface DashboardUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
}

export interface DeviceRow {
  id: string;
  hostname: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  user: { name: string; email: string } | null;
}

export interface AppSummary {
  appName: string;
  activeSeconds: number;
}

export interface MediaItem {
  id: string;
  kind: "SCREENSHOT" | "RECORDING";
  capturedAt: string;
  url: string;
  durationSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown = null
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return err;
    // zod `flatten()` output: { formErrors: string[], fieldErrors: Record<string, string[]> }
    if (err && typeof err === "object") {
      const { formErrors, fieldErrors } = err as {
        formErrors?: string[];
        fieldErrors?: Record<string, string[] | undefined>;
      };
      const parts = [
        ...(formErrors ?? []),
        ...Object.entries(fieldErrors ?? {}).map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`),
      ];
      if (parts.length) return parts.join("; ");
    }
  }
  if (status === 0) return "Could not reach the server";
  return `Request failed (${status})`;
}

// ---------------------------------------------------------------------------
// Session store (localStorage + in-memory subscribers)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "emptrack_session";
const LEGACY_TOKEN_KEY = "emptrack_token";

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: Session | null | undefined; // undefined = not read yet

function isBrowser() {
  return typeof window !== "undefined";
}

function readStorage(): Session | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed?.token || !parsed.user?.id) return null;
    if (isExpired(parsed.token)) return null;
    return { ...parsed, tenants: parsed.tenants ?? [] };
  } catch {
    return null;
  }
}

function writeStorage(s: Session | null) {
  if (!isBrowser()) return;
  try {
    if (s) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      window.localStorage.setItem(LEGACY_TOKEN_KEY, s.token);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode); the in-memory copy still works.
  }
}

function emit() {
  listeners.forEach((l) => l());
}

export function getSession(): Session | null {
  if (cached === undefined) cached = readStorage();
  return cached;
}

export function setSession(s: Session | null) {
  cached = s;
  writeStorage(s);
  emit();
}

export function updateSession(patch: Partial<Session>) {
  const cur = getSession();
  if (!cur) return;
  setSession({ ...cur, ...patch });
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Keep tabs in sync: signing out or switching company in one tab applies to all.
if (isBrowser()) {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cached = readStorage();
    emit();
  });
}

/** Decode the JWT `exp` claim without verifying (the server does that). */
function isExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

// Back-compat helpers used by existing pages.
export function getToken(): string | null {
  return getSession()?.token ?? null;
}
export function clearToken() {
  setSession(null);
}
export const clearSession = clearToken;

export function getActiveTenantId(): string | null {
  return getSession()?.activeTenantId ?? null;
}

export function getActiveTenant(): TenantSummary | null {
  const s = getSession();
  if (!s) return null;
  return s.tenants.find((t) => t.id === s.activeTenantId) ?? null;
}

/** True when the user may switch between companies. */
export function canSwitchTenant(s: Session | null = getSession()): boolean {
  return !!s && s.user.role === "SUPER_ADMIN" && s.tenants.length > 1;
}

/** Switch the company every subsequent request is scoped to. */
export function setActiveTenant(tenantId: string) {
  const s = getSession();
  if (!s || s.activeTenantId === tenantId) return;
  if (s.tenants.length && !s.tenants.some((t) => t.id === tenantId)) {
    throw new Error("Unknown company");
  }
  updateSession({ activeTenantId: tenantId });
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

const getServerSnapshot = () => null;

/** Current session; re-renders on login, logout and company switch. */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSession, getServerSnapshot);
}

/** Active company; re-renders on switch. */
export function useActiveTenant(): TenantSummary | null {
  const s = useSession();
  if (!s) return null;
  return s.tenants.find((t) => t.id === s.activeTenantId) ?? null;
}

// ---------------------------------------------------------------------------
// Fetch core
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** JSON-serialised as the body. */
  json?: unknown;
  /** Appended as a query string; null/undefined values are dropped. */
  query?: Query;
  /** Override the active tenant for this one request. */
  tenantId?: string | null;
  /** Skip the Authorization header (e.g. login). */
  anonymous?: boolean;
}

/** Called once when any request comes back 401; pages redirect to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

function buildUrl(path: string, query?: Query) {
  const url = new URL(path.startsWith("http") ? path : `${API_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { json, query, tenantId, anonymous, headers, ...init } = opts;
  const session = anonymous ? null : getSession();

  const h = new Headers(headers);
  if (json !== undefined && !h.has("Content-Type")) h.set("Content-Type", "application/json");
  h.set("Accept", "application/json");
  if (session) {
    h.set("Authorization", `Bearer ${session.token}`);
    const tid = tenantId === undefined ? session.activeTenantId : tenantId;
    if (tid) h.set(TENANT_HEADER, tid);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      ...init,
      headers: h,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, errorMessage(0, null), e);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && session) {
      setSession(null);
      onUnauthorized?.();
    }
    throw new ApiError(res.status, errorMessage(res.status, body), body);
  }
  return body as T;
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, json?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "POST", json }),
  put: <T>(path: string, json?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PUT", json }),
  patch: <T>(path: string, json?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PATCH", json }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>(path, { ...opts, method: "DELETE" }),
};

/**
 * Legacy helper kept for existing pages: `api<T>(path, init)` with a
 * pre-serialised body. New code should use `http` or the typed wrappers.
 */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const { body, ...rest } = init;
  const opts: RequestOptions = { ...rest };
  if (typeof body === "string") opts.json = JSON.parse(body);
  return request<T>(path, opts);
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export const authApi = {
  login: (email: string, password: string) =>
    http.post<LoginResponse>("/api/auth/login", { email, password }, { anonymous: true }),
  me: () => http.get<SessionUser>("/api/auth/me"),
};

export const tenantsApi = {
  /** SUPER_ADMIN only. */
  list: () => http.get<TenantSummary[]>("/api/tenants"),
  /** SUPER_ADMIN only. */
  create: (input: { name: string; slug: string }) => http.post<TenantSummary>("/api/tenants", input),
  getPolicy: () => http.get<TenantPolicy | null>("/api/tenants/policy"),
  updatePolicy: (patch: Partial<Omit<TenantPolicy, "id" | "tenantId" | "updatedAt">>) =>
    http.put<TenantPolicy>("/api/tenants/policy", patch),
};

export const usersApi = {
  list: () => http.get<DashboardUser[]>("/api/users"),
  create: (input: { email: string; name: string; password: string; role?: Exclude<Role, "SUPER_ADMIN"> }) =>
    http.post<Pick<DashboardUser, "id" | "name" | "email" | "role">>("/api/users", input),
  createDevice: (userId: string) =>
    http.post<{ deviceId: string; enrollmentToken: string }>(`/api/users/${encodeURIComponent(userId)}/devices`),
};

export const reportsApi = {
  devices: () => http.get<DeviceRow[]>("/api/reports/devices"),
  activitySummary: (query?: Query) => http.get<AppSummary[]>("/api/reports/activity/summary", { query }),
  activity: (query?: Query) => http.get<unknown[]>("/api/reports/activity", { query }),
  media: (query?: Query) => http.get<MediaItem[]>("/api/reports/media", { query }),
};

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Fetch the companies this user can see. Non-super-admins only see their own. */
async function loadTenants(user: SessionUser): Promise<TenantSummary[]> {
  if (user.role === "SUPER_ADMIN") {
    try {
      return await tenantsApi.list();
    } catch {
      // fall through to the home tenant only
    }
  }
  return [{ id: user.tenantId, name: "My company", slug: "" }];
}

/** Pick the company to show after sign-in: last used (if still allowed), else home. */
function pickTenant(user: SessionUser, tenants: TenantSummary[], preferred?: string | null) {
  if (preferred && tenants.some((t) => t.id === preferred)) return preferred;
  if (tenants.some((t) => t.id === user.tenantId)) return user.tenantId;
  return tenants[0]?.id ?? user.tenantId;
}

const LAST_TENANT_KEY = "emptrack_last_tenant";

function rememberTenant(userId: string, tenantId: string) {
  try {
    window.localStorage.setItem(`${LAST_TENANT_KEY}:${userId}`, tenantId);
  } catch {
    /* ignore */
  }
}
function lastTenant(userId: string): string | null {
  try {
    return window.localStorage.getItem(`${LAST_TENANT_KEY}:${userId}`);
  } catch {
    return null;
  }
}

// Remember the active company per user so the next sign-in reopens it.
subscribeSession(() => {
  const s = cached;
  if (s) rememberTenant(s.user.id, s.activeTenantId);
});

/** Sign in, then load the company list and restore the last active company. */
export async function login(email: string, password: string): Promise<Session> {
  const { token, user } = await authApi.login(email, password);
  // Seed a session so the tenants call is authenticated.
  setSession({ token, user, activeTenantId: user.tenantId, tenants: [] });
  const tenants = await loadTenants(user);
  const session: Session = {
    token,
    user,
    tenants,
    activeTenantId: pickTenant(user, tenants, lastTenant(user.id)),
  };
  setSession(session);
  return session;
}

/** Re-validate the stored token and refresh the company list. */
export async function refreshSession(): Promise<Session | null> {
  const s = getSession();
  if (!s) return null;
  const user = await authApi.me();
  const tenants = await loadTenants(user);
  const next: Session = {
    ...s,
    user,
    tenants,
    activeTenantId: pickTenant(user, tenants, s.activeTenantId),
  };
  setSession(next);
  return next;
}

export function logout() {
  setSession(null);
}
