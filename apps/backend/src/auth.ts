import { NextFunction, Request, Response } from "express";
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Role } from "@emptrack/shared";
import { env } from "./env";
import { prisma } from "./prisma";

export interface AuthUser {
  userId: string;
  /** Company this request acts on. Every tenant-scoped query must filter by this. */
  tenantId: string;
  /** Company the user's own account lives in. Differs from tenantId only when an owner switches company. */
  homeTenantId: string;
  role: string;
  email: string;
}

/** Header the dashboard's company switcher sends to pick the active company. */
export const TENANT_HEADER = "x-tenant-id";

export interface AuthedDevice {
  deviceId: string;
  tenantId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthUser;
      device?: AuthedDevice;
    }
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Higher rank = more power. SUPER_ADMIN is the owner role. Every check that
 * compares two users goes through this table so the hierarchy lives in one place.
 */
const ROLE_RANK: Record<string, number> = {
  [Role.Employee]: 1,
  [Role.Manager]: 2,
  [Role.Admin]: 3,
  [Role.SuperAdmin]: 4,
};

export function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 0;
}

/** True when `actor` strictly outranks `target`. */
export function outranks(actor: string, target: string): boolean {
  return roleRank(actor) > roleRank(target);
}

/** Roles an actor may hand out: anything strictly below their own rank. */
export function assignableRoles(actor: string): string[] {
  return Object.keys(ROLE_RANK).filter((r) => outranks(actor, r));
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Compared against when no user matches, so a missing account costs the same
// time as a wrong password and login timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser-not-a-real-password", BCRYPT_ROUNDS);

export async function burnPasswordCheck(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_EXPIRES_IN ?? "15m";
export const REFRESH_TOKEN_TTL = process.env.JWT_REFRESH_EXPIRES_IN ?? env.jwtExpiresIn;

type AccessClaims = Omit<AuthUser, "homeTenantId"> & { kind: "access" };

/** Parses "15m" / "7d" / "3600" (seconds) style durations into milliseconds. */
export function durationMs(v: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(v.trim());
  if (!m) throw new Error(`Bad duration: ${v}`);
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
  return parseInt(m[1], 10) * unit * 1000;
}

export function signUserToken(u: Omit<AuthUser, "homeTenantId">): string {
  const claims: AccessClaims = {
    userId: u.userId,
    tenantId: u.tenantId,
    role: u.role,
    email: u.email,
    kind: "access",
  };
  return jwt.sign(claims, env.jwtSecret, { expiresIn: ACCESS_TOKEN_TTL } as jwt.SignOptions);
}

// ---------------------------------------------------------------------------
// Refresh tokens (RefreshToken table)
// ---------------------------------------------------------------------------
//
// Opaque random strings; only their SHA-256 is stored, so a database leak does
// not hand out live sessions. Each one is single-use: refreshing marks it
// revoked (revokedAt) and issues a new one. Logout, password changes and
// deactivation delete rows instead, so a row with revokedAt set can only mean
// a rotated token was presented again, i.e. it was copied. That signs the user
// out everywhere (refresh-token reuse detection) without punishing a client
// that simply holds a token from before a logout or password change.

// Parsed once at startup so a malformed JWT_REFRESH_EXPIRES_IN fails fast.
const REFRESH_TOKEN_TTL_MS = durationMs(REFRESH_TOKEN_TTL);

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

async function createRefreshToken(user: { id: string; tenantId: string }): Promise<string> {
  // Housekeeping: drop this user's expired rows so the table doesn't grow forever.
  await prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });
  const token = randomBytes(32).toString("base64url");
  await prisma.refreshToken.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return token;
}

/**
 * Redeems a refresh token: revokes it and returns its owner, or null if it is
 * unknown, expired, revoked, or the user is gone/deactivated. The revoke is a
 * conditional update, so two concurrent refreshes with the same token cannot
 * both succeed.
 */
export async function consumeRefreshToken(token: string) {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return null;
  if (row.revokedAt) {
    await revokeAllRefreshTokens(row.userId);
    return null;
  }
  if (row.expiresAt <= new Date()) return null;

  const { count } = await prisma.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count !== 1) return null;

  const user = await prisma.user.findFirst({ where: { id: row.userId, tenantId: row.tenantId } });
  return user && user.isActive ? user : null;
}

/** Revokes one refresh token (logout). Unknown tokens are a no-op. */
export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Signs a user out everywhere: password change/reset, deactivation, token reuse. */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

/** Access + refresh pair returned by login and refresh. `token` is kept for older clients. */
export async function issueSession(user: { id: string; tenantId: string; role: string; email: string }) {
  const accessToken = signUserToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  return {
    token: accessToken,
    accessToken,
    refreshToken: await createRefreshToken(user),
    tokenType: "Bearer" as const,
    expiresIn: ACCESS_TOKEN_TTL,
  };
}

export function signDeviceToken(d: AuthedDevice): string {
  // Device tokens are long-lived; rotation is handled by re-enrollment.
  return jwt.sign({ ...d, kind: "device" }, env.jwtSecret, { expiresIn: "365d" });
}

function bearer(req: Request): string | null {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Guard for dashboard / admin endpoints. With no roles any signed-in user passes.
 *
 * The user is re-read on every request, so a deactivated user is locked out and
 * a role change takes effect immediately rather than when the token expires.
 * `req.auth` always reflects the database, never stale token claims.
 *
 * Company switching: an owner (SUPER_ADMIN) runs every company, so they may send
 * `X-Tenant-Id` to act on any existing company; `req.auth.tenantId` becomes that
 * company and every route scoped by it follows. Anyone else may only send their
 * own company's id (or nothing); any other value is refused, never ignored.
 */
export function requireUser(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "Missing token" });

    let payload: AccessClaims;
    try {
      payload = jwt.verify(token, env.jwtSecret) as AccessClaims;
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
    if ((payload.kind as string) === "device") return res.status(403).json({ error: "Device token not allowed here" });
    if (payload.kind !== "access") return res.status(401).json({ error: "Invalid token" });

    try {
      const user = await prisma.user.findFirst({
        where: { id: payload.userId, tenantId: payload.tenantId },
        select: { id: true, tenantId: true, role: true, email: true, isActive: true },
      });
      if (!user || !user.isActive) return res.status(401).json({ error: "Account disabled or removed" });
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ error: "Insufficient role" });
      }

      let tenantId = user.tenantId;
      const requested = req.header(TENANT_HEADER)?.trim();
      if (requested && requested !== user.tenantId) {
        if (user.role !== Role.SuperAdmin) return res.status(403).json({ error: "No access to that company" });
        const tenant = await prisma.tenant.findUnique({ where: { id: requested }, select: { id: true } });
        if (!tenant) return res.status(404).json({ error: "Company not found" });
        tenantId = tenant.id;
      }
      req.auth = { userId: user.id, tenantId, homeTenantId: user.tenantId, role: user.role, email: user.email };
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Guard that admits the given role and everything ranked above it. */
export function requireRoleAtLeast(minRole: string) {
  return requireUser(...Object.keys(ROLE_RANK).filter((r) => roleRank(r) >= roleRank(minRole)));
}

/** Guard for agent endpoints — authenticated by device token. */
export async function requireDevice(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "Missing device token" });
  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthedDevice & { kind?: string };
    if (payload.kind !== "device") return res.status(403).json({ error: "Not a device token" });
    const device = await prisma.device.findFirst({
      where: { id: payload.deviceId, tenantId: payload.tenantId },
    });
    if (!device) return res.status(401).json({ error: "Unknown device" });
    req.device = { deviceId: device.id, tenantId: device.tenantId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid device token" });
  }
}
