import { NextFunction, Request, Response } from "express";
import { createHash, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Role } from "@emptrack/shared";
import { env } from "./env";
import { prisma } from "./prisma";

export interface AuthUser {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

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

type AccessClaims = AuthUser & { kind: "access" };
type RefreshClaims = { kind: "refresh"; userId: string; tenantId: string; jti: string; exp: number };

/**
 * Refresh tokens are signed with a key derived from the user's current password
 * hash, so changing or resetting a password revokes every outstanding session.
 */
function refreshKey(passwordHash: string): string {
  return createHash("sha256").update(env.jwtSecret).update(":refresh:").update(passwordHash).digest("hex");
}

export function signUserToken(u: AuthUser): string {
  const claims: AccessClaims = {
    userId: u.userId,
    tenantId: u.tenantId,
    role: u.role,
    email: u.email,
    kind: "access",
  };
  return jwt.sign(claims, env.jwtSecret, { expiresIn: ACCESS_TOKEN_TTL } as jwt.SignOptions);
}

export function signRefreshToken(u: { id: string; tenantId: string; passwordHash: string }): string {
  return jwt.sign({ kind: "refresh", userId: u.id, tenantId: u.tenantId }, refreshKey(u.passwordHash), {
    expiresIn: REFRESH_TOKEN_TTL,
    jwtid: randomUUID(),
  } as jwt.SignOptions);
}

/** Reads userId out of a refresh token without trusting it, to find whose key to verify with. */
export function peekRefreshToken(token: string): { userId: string; tenantId: string } | null {
  const decoded = jwt.decode(token) as Partial<RefreshClaims> | null;
  if (!decoded || decoded.kind !== "refresh" || !decoded.userId || !decoded.tenantId) return null;
  return { userId: decoded.userId, tenantId: decoded.tenantId };
}

export function verifyRefreshToken(token: string, passwordHash: string): RefreshClaims | null {
  try {
    const payload = jwt.verify(token, refreshKey(passwordHash)) as RefreshClaims;
    if (payload.kind !== "refresh" || !payload.jti || revokedRefreshTokens.has(payload.jti)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Revoked refresh-token ids, kept until the token would have expired anyway.
 * In-process only: it does not survive a restart or span several instances.
 * Swap for a DB table once the schema has one.
 */
const revokedRefreshTokens = new Map<string, number>();

export function revokeRefreshToken(claims: { jti: string; exp: number }): void {
  revokedRefreshTokens.set(claims.jti, claims.exp * 1000);
  const now = Date.now();
  for (const [jti, expiresAt] of revokedRefreshTokens) {
    if (expiresAt <= now) revokedRefreshTokens.delete(jti);
  }
}

/** Access + refresh pair returned by login and refresh. `token` is kept for older clients. */
export function issueSession(user: { id: string; tenantId: string; role: string; email: string; passwordHash: string }) {
  const accessToken = signUserToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  return {
    token: accessToken,
    accessToken,
    refreshToken: signRefreshToken(user),
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
      req.auth = { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email };
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
