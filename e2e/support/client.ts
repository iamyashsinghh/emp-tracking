import { inject } from "vitest";

/**
 * Thin HTTP client for e2e specs. It speaks to the backend exactly like the
 * agent (device token) and the dashboard (user token) do, and returns the
 * status alongside the parsed body so specs can assert on both.
 */
export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export function apiUrl(): string {
  return inject("apiUrl");
}

export async function call<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {}
): Promise<ApiResponse<T>> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

/** Logs a dashboard user in and returns their access token. */
export async function login(email: string, password: string): Promise<string> {
  const r = await call<{ token?: string; accessToken?: string }>("POST", "/api/auth/login", {
    body: { email, password },
  });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.accessToken ?? r.body.token)!;
}
