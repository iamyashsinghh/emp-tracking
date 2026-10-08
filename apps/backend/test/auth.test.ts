/**
 * Auth + user-management tests. Runs against an in-memory stand-in for Prisma,
 * so no database is needed:
 *   cd apps/backend && DATABASE_URL=postgres://unused TS_NODE_TRANSPILE_ONLY=1 \
 *     node --test --require ../../node_modules/ts-node-dev/node_modules/ts-node/register test/auth.test.ts
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import express from "express";
import bcrypt from "bcryptjs";
import { Role } from "@emptrack/shared";
import { prisma } from "../src/prisma";
import { authRouter } from "../src/routes/auth";
import { usersRouter } from "../src/routes/users";
import { assignableRoles, outranks, signDeviceToken } from "../src/auth";

// ---------------------------------------------------------------------------
// In-memory Prisma stand-in (only what the auth/users routes use)
// ---------------------------------------------------------------------------

type U = {
  id: string; tenantId: string; email: string; name: string; passwordHash: string;
  role: string; isActive: boolean; createdAt: Date; updatedAt: Date;
};
const tenants = [
  { id: "t1", name: "Acme", slug: "acme" },
  { id: "t2", name: "Globex", slug: "globex" },
];
let users: U[] = [];
let seq = 0;

function matches(u: U, where: any = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === "tenant") { if (tenants.find((t) => t.id === u.tenantId)?.slug !== (v as any).slug) return false; continue; }
    if (k === "OR") { if (!(v as any[]).some((w) => matches(u, w))) return false; continue; }
    const field = (u as any)[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as any;
      if (o.equals !== undefined && String(field).toLowerCase() !== String(o.equals).toLowerCase()) return false;
      if (o.contains !== undefined && !String(field).toLowerCase().includes(String(o.contains).toLowerCase())) return false;
      continue;
    }
    if (field !== v) return false;
  }
  return true;
}
function project(u: U, args: any = {}) {
  const out: any = args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, (u as any)[k]])) : { ...u };
  if (args.include?.tenant) out.tenant = tenants.find((t) => t.id === u.tenantId);
  return out;
}
function uniqueClash(u: U) {
  if (users.some((o) => o.id !== u.id && o.tenantId === u.tenantId && o.email === u.email)) {
    const { Prisma } = require("@prisma/client");
    throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
  }
}
const fakeUser = {
  findFirst: async (a: any) => { const u = users.find((x) => matches(x, a?.where)); return u ? project(u, a) : null; },
  findMany: async (a: any) => users.filter((x) => matches(x, a?.where)).slice(a?.skip ?? 0, (a?.skip ?? 0) + (a?.take ?? 1e9)).map((u) => project(u, a)),
  count: async (a: any) => users.filter((x) => matches(x, a?.where)).length,
  create: async (a: any) => {
    const u: U = { id: `u${++seq}`, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...a.data };
    uniqueClash(u); users.push(u); return project(u, a);
  },
  update: async (a: any) => {
    const u = users.find((x) => x.id === a.where.id)!;
    const next = { ...u, ...a.data, updatedAt: new Date() }; uniqueClash(next);
    Object.assign(u, next); return project(u, a);
  },
};
Object.defineProperty(prisma, "user", { value: fakeUser, configurable: true });
Object.defineProperty(prisma, "$transaction", { value: (ps: Promise<unknown>[]) => Promise.all(ps), configurable: true });
Object.defineProperty(prisma, "tenant", {
  value: {
    findUnique: async (a: any) => tenants.find((t) => t.id === a.where.id) ?? null,
    findMany: async (a: any) => tenants.filter((t) => !a?.where?.id || t.id === a.where.id),
  },
  configurable: true,
});
Object.defineProperty(prisma, "device", {
  value: { create: async (a: any) => ({ id: "d1", ...a.data }), findFirst: async () => null }, configurable: true,
});

const hash = bcrypt.hashSync("password123", 4);
function seed() {
  const now = new Date();
  const mk = (id: string, tenantId: string, email: string, role: string): U =>
    ({ id, tenantId, email, name: id, passwordHash: hash, role, isActive: true, createdAt: now, updatedAt: now });
  users = [
    mk("owner", "t1", "owner@acme.co", Role.SuperAdmin),
    mk("admin", "t1", "admin@acme.co", Role.Admin),
    mk("admin2", "t1", "admin2@acme.co", Role.Admin),
    mk("mgr", "t1", "mgr@acme.co", Role.Manager),
    mk("emp", "t1", "emp@acme.co", Role.Employee),
    mk("g-admin", "t2", "admin@globex.co", Role.Admin),
    mk("g-emp", "t2", "emp@globex.co", Role.Employee),
    // Same email in both companies, same password.
    mk("dup1", "t1", "shared@x.co", Role.Employee),
    mk("dup2", "t2", "shared@x.co", Role.Employee),
  ];
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(seed);

async function call(method: string, path: string, body?: unknown, token?: string, tenant?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { "x-tenant-id": tenant } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
async function login(email: string, extra: object = {}) {
  const r = await call("POST", "/api/auth/login", { email, password: "password123", ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { accessToken: string; refreshToken: string; token: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("role hierarchy", () => {
  it("ranks owner > admin > manager > employee", () => {
    assert.ok(outranks(Role.SuperAdmin, Role.Admin));
    assert.ok(outranks(Role.Admin, Role.Manager));
    assert.ok(outranks(Role.Manager, Role.Employee));
    assert.ok(!outranks(Role.Admin, Role.Admin));
    assert.deepEqual(assignableRoles(Role.Admin).sort(), [Role.Employee, Role.Manager].sort());
    assert.deepEqual(assignableRoles(Role.Employee), []);
  });
});

describe("login", () => {
  it("returns access + refresh tokens and keeps `token` for older clients", async () => {
    const s = await login("admin@acme.co");
    assert.ok(s.accessToken && s.refreshToken);
    assert.equal(s.token, s.accessToken);
  });
  it("is case-insensitive on email", async () => {
    await login("ADMIN@Acme.co");
  });
  it("rejects a wrong password and an unknown email the same way", async () => {
    const a = await call("POST", "/api/auth/login", { email: "admin@acme.co", password: "wrongpass1" });
    const b = await call("POST", "/api/auth/login", { email: "nobody@acme.co", password: "wrongpass1" });
    assert.equal(a.status, 401);
    assert.deepEqual(a.body, b.body);
  });
  it("rejects deactivated users", async () => {
    users.find((u) => u.id === "emp")!.isActive = false;
    const r = await call("POST", "/api/auth/login", { email: "emp@acme.co", password: "password123" });
    assert.equal(r.status, 401);
  });
  it("asks for tenantSlug when the email+password matches several companies", async () => {
    const r = await call("POST", "/api/auth/login", { email: "shared@x.co", password: "password123" });
    assert.equal(r.status, 409);
    const s = await login("shared@x.co", { tenantSlug: "globex" });
    const me = await call("GET", "/api/auth/me", undefined, s.accessToken);
    assert.equal(me.body.tenantId, "t2");
    assert.equal(me.body.tenant.slug, "globex");
  });
});

describe("tokens", () => {
  it("rejects a refresh token used as an access token, and a device token", async () => {
    const s = await login("admin@acme.co");
    assert.equal((await call("GET", "/api/auth/me", undefined, s.refreshToken)).status, 401);
    const dev = signDeviceToken({ deviceId: "d1", tenantId: "t1" });
    assert.equal((await call("GET", "/api/auth/me", undefined, dev)).status, 403);
  });
  it("rotates refresh tokens: each one works once", async () => {
    const s = await login("admin@acme.co");
    const r1 = await call("POST", "/api/auth/refresh", { refreshToken: s.refreshToken });
    assert.equal(r1.status, 200);
    assert.ok(r1.body.accessToken);
    const r2 = await call("POST", "/api/auth/refresh", { refreshToken: s.refreshToken });
    assert.equal(r2.status, 401);
    const r3 = await call("POST", "/api/auth/refresh", { refreshToken: r1.body.refreshToken });
    assert.equal(r3.status, 200);
  });
  it("logout revokes the refresh token", async () => {
    const s = await login("admin@acme.co");
    assert.equal((await call("POST", "/api/auth/logout", { refreshToken: s.refreshToken })).status, 204);
    assert.equal((await call("POST", "/api/auth/refresh", { refreshToken: s.refreshToken })).status, 401);
    // Idempotent / garbage-tolerant.
    assert.equal((await call("POST", "/api/auth/logout", { refreshToken: "junk" })).status, 204);
  });
  it("changing the password ends other sessions but keeps this one", async () => {
    const other = await login("mgr@acme.co");
    const here = await login("mgr@acme.co");
    const r = await call("POST", "/api/auth/change-password",
      { currentPassword: "password123", newPassword: "newpassword1" }, here.accessToken);
    assert.equal(r.status, 200);
    assert.equal((await call("POST", "/api/auth/refresh", { refreshToken: other.refreshToken })).status, 401);
    assert.equal((await call("POST", "/api/auth/refresh", { refreshToken: r.body.refreshToken })).status, 200);
  });
  it("a live access token stops working once the user is deactivated", async () => {
    const s = await login("emp@acme.co");
    users.find((u) => u.id === "emp")!.isActive = false;
    assert.equal((await call("GET", "/api/auth/me", undefined, s.accessToken)).status, 401);
  });
  it("role checks use the current role, not the one in the token", async () => {
    const s = await login("mgr@acme.co");
    assert.equal((await call("GET", "/api/users", undefined, s.accessToken)).status, 200);
    users.find((u) => u.id === "mgr")!.role = Role.Employee;
    assert.equal((await call("GET", "/api/users", undefined, s.accessToken)).status, 403);
  });
});

describe("users: tenant isolation", () => {
  it("lists only the caller's company", async () => {
    const s = await login("admin@globex.co");
    const r = await call("GET", "/api/users", undefined, s.accessToken);
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 0);
    assert.ok(r.body.every((u: any) => ["g-admin", "g-emp", "dup2"].includes(u.id)));
    assert.equal(r.headers.get("x-total-count"), "3");
  });
  it("cannot read, edit, deactivate or enroll a device for another company's user", async () => {
    const s = await login("owner@acme.co");
    assert.equal((await call("GET", "/api/users/g-emp", undefined, s.accessToken)).status, 404);
    assert.equal((await call("PATCH", "/api/users/g-emp", { name: "x" }, s.accessToken)).status, 404);
    assert.equal((await call("DELETE", "/api/users/g-emp", undefined, s.accessToken)).status, 404);
    assert.equal((await call("POST", "/api/users/g-emp/devices", undefined, s.accessToken)).status, 404);
    assert.equal(users.find((u) => u.id === "g-emp")!.isActive, true);
  });
  it("creates users in the caller's company, ignoring any tenantId in the body", async () => {
    const s = await login("admin@acme.co");
    const r = await call("POST", "/api/users",
      { name: "New", email: "New@Acme.co", password: "password123", role: Role.Employee, tenantId: "t2" }, s.accessToken);
    assert.equal(r.status, 201);
    const created = users.find((u) => u.id === r.body.id)!;
    assert.equal(created.tenantId, "t1");
    assert.equal(created.email, "new@acme.co");
    assert.equal(r.body.passwordHash, undefined);
  });
  it("the same email can exist in two companies but not twice in one", async () => {
    const s = await login("admin@acme.co");
    const body = { name: "X", email: "emp@globex.co", password: "password123" };
    assert.equal((await call("POST", "/api/users", body, s.accessToken)).status, 201);
    assert.equal((await call("POST", "/api/users", body, s.accessToken)).status, 409);
  });
});

describe("users: role enforcement", () => {
  it("employees cannot list users but can read themselves", async () => {
    const s = await login("emp@acme.co");
    assert.equal((await call("GET", "/api/users", undefined, s.accessToken)).status, 403);
    assert.equal((await call("GET", "/api/users/emp", undefined, s.accessToken)).status, 200);
    assert.equal((await call("GET", "/api/users/mgr", undefined, s.accessToken)).status, 403);
  });
  it("managers can read but not create", async () => {
    const s = await login("mgr@acme.co");
    assert.equal((await call("GET", "/api/users/emp", undefined, s.accessToken)).status, 200);
    const r = await call("POST", "/api/users", { name: "X", email: "x@acme.co", password: "password123" }, s.accessToken);
    assert.equal(r.status, 403);
  });
  it("admins create managers/employees but not admins; the owner can create admins", async () => {
    const admin = await login("admin@acme.co");
    const owner = await login("owner@acme.co");
    const mk = (email: string, role: string) => ({ name: "X", email, password: "password123", role });
    assert.equal((await call("POST", "/api/users", mk("m@acme.co", Role.Manager), admin.accessToken)).status, 201);
    assert.equal((await call("POST", "/api/users", mk("a@acme.co", Role.Admin), admin.accessToken)).status, 403);
    assert.equal((await call("POST", "/api/users", mk("a@acme.co", Role.Admin), owner.accessToken)).status, 201);
    assert.equal((await call("POST", "/api/users", mk("o@acme.co", Role.SuperAdmin), owner.accessToken)).status, 403);
  });
  it("an admin cannot edit, reset or deactivate a peer admin or the owner", async () => {
    const s = await login("admin@acme.co");
    for (const id of ["admin2", "owner"]) {
      assert.equal((await call("PATCH", `/api/users/${id}`, { name: "x" }, s.accessToken)).status, 403);
      assert.equal((await call("POST", `/api/users/${id}/password`, { password: "password999" }, s.accessToken)).status, 403);
      assert.equal((await call("DELETE", `/api/users/${id}`, undefined, s.accessToken)).status, 403);
    }
  });
  it("an admin can promote an employee to manager but not to admin", async () => {
    const s = await login("admin@acme.co");
    assert.equal((await call("PATCH", "/api/users/emp", { role: Role.Manager }, s.accessToken)).status, 200);
    assert.equal((await call("PATCH", "/api/users/emp", { role: Role.Admin }, s.accessToken)).status, 403);
  });
  it("users can rename themselves but not change their own role or status", async () => {
    const s = await login("admin@acme.co");
    assert.equal((await call("PATCH", "/api/users/admin", { name: "Renamed" }, s.accessToken)).status, 200);
    assert.equal((await call("PATCH", "/api/users/admin", { role: Role.SuperAdmin }, s.accessToken)).status, 403);
    assert.equal((await call("PATCH", "/api/users/admin", { isActive: false }, s.accessToken)).status, 403);
    assert.equal((await call("DELETE", "/api/users/admin", undefined, s.accessToken)).status, 400);
  });
  it("deactivating a user soft-deletes and blocks their login", async () => {
    const s = await login("admin@acme.co");
    assert.equal((await call("DELETE", "/api/users/emp", undefined, s.accessToken)).status, 204);
    assert.equal(users.find((u) => u.id === "emp")!.isActive, false);
    const r = await call("POST", "/api/auth/login", { email: "emp@acme.co", password: "password123" });
    assert.equal(r.status, 401);
  });
  it("an admin password reset ends the target's sessions", async () => {
    const emp = await login("emp@acme.co");
    const admin = await login("admin@acme.co");
    assert.equal((await call("POST", "/api/users/emp/password", { password: "brandnew123" }, admin.accessToken)).status, 204);
    assert.equal((await call("POST", "/api/auth/refresh", { refreshToken: emp.refreshToken })).status, 401);
  });
});

describe("company switching (X-Tenant-Id)", () => {
  it("lets the owner act on another company", async () => {
    const s = await login("owner@acme.co");
    const list = await call("GET", "/api/users", undefined, s.accessToken, "t2");
    assert.equal(list.status, 200);
    assert.ok(list.body.every((u: any) => ["g-admin", "g-emp", "dup2"].includes(u.id)));
    const created = await call("POST", "/api/users",
      { name: "X", email: "x@globex.co", password: "password123", role: Role.Admin }, s.accessToken, "t2");
    assert.equal(created.status, 201);
    assert.equal(users.find((u) => u.id === created.body.id)!.tenantId, "t2");
    const me = await call("GET", "/api/auth/me", undefined, s.accessToken, "t2");
    assert.equal(me.body.tenant.id, "t1");
    assert.equal(me.body.activeTenant.id, "t2");
  });
  it("refuses the header for anyone but the owner, unless it names their own company", async () => {
    const s = await login("admin@acme.co");
    assert.equal((await call("GET", "/api/users", undefined, s.accessToken, "t2")).status, 403);
    assert.equal((await call("GET", "/api/users", undefined, s.accessToken, "t1")).status, 200);
  });
  it("404s an unknown company", async () => {
    const s = await login("owner@acme.co");
    assert.equal((await call("GET", "/api/users", undefined, s.accessToken, "nope")).status, 404);
  });
  it("lists switchable companies", async () => {
    const owner = await login("owner@acme.co");
    const admin = await login("admin@acme.co");
    assert.equal((await call("GET", "/api/auth/tenants", undefined, owner.accessToken)).body.length, 2);
    const mine = (await call("GET", "/api/auth/tenants", undefined, admin.accessToken)).body;
    assert.deepEqual(mine.map((t: any) => [t.id, t.home]), [["t1", true]]);
  });
});
