#!/usr/bin/env node
// End-to-end media smoke test against a running, seeded stack:
// admin login -> enroll a device -> agent uploads a screenshot through the
// signed upload URL -> confirm -> dashboard lists it -> bytes download intact
// -> admin deletes it.
//
//   API_URL=http://localhost:4002 node scripts/smoke-media.mjs

const API = (process.env.API_URL || "http://localhost:4002").replace(/\/+$/, "");

async function call(path, { token, ...init } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: {
      ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

const json = async (path, init) => (await call(path, init)).json();
const step = (msg) => console.log(`[smoke] ${msg}`);

// 1x1 transparent PNG
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const login = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: "admin@demo.co", password: "admin12345" }),
});
const admin = login.accessToken ?? login.token;
step("admin logged in");

const users = await json("/api/users", { token: admin });
const employee = users.find((u) => u.role === "EMPLOYEE") ?? users[0];
const { enrollmentToken } = await json(`/api/users/${employee.id}/devices`, { method: "POST", token: admin });
const enrolled = await json("/api/agent/enroll", {
  method: "POST",
  body: JSON.stringify({ enrollmentToken, hostname: "smoke-test", platform: "linux" }),
});
step(`device enrolled (${enrolled.deviceId})`);

const up = await json("/api/agent/media/upload-url", {
  method: "POST",
  token: enrolled.token,
  body: JSON.stringify({ kind: "SCREENSHOT", contentType: "image/png", capturedAt: new Date().toISOString() }),
});
step(`upload url: ${up.uploadUrl.slice(0, 60)}...`);

await call(up.uploadUrl, { method: "PUT", headers: up.requiredHeaders, body: png });
await json(`/api/agent/media/${up.mediaId}/confirm`, {
  method: "POST",
  token: enrolled.token,
  body: JSON.stringify({ sizeBytes: png.length }),
});
step("uploaded and confirmed");

const list = await json(`/api/media?deviceId=${enrolled.deviceId}`, { token: admin });
const item = list.items.find((i) => i.id === up.mediaId);
if (!item) throw new Error("uploaded screenshot missing from /api/media");
const got = Buffer.from(await (await call(item.url)).arrayBuffer());
if (!got.equals(png)) throw new Error(`downloaded ${got.length} bytes, expected ${png.length} identical bytes`);
step(`dashboard lists it and the download matches (${got.length} bytes)`);

await call(`/api/media/${up.mediaId}`, { method: "DELETE", token: admin });
const gone = await fetch(item.url);
if (gone.status !== 404) throw new Error(`deleted file still served (${gone.status})`);
step("deleted from storage");
console.log("[smoke] OK");
