import { Router } from "express";
import { z } from "zod";
import { loginSchema, Role } from "@emptrack/shared";
import { prisma } from "../prisma";
import {
  burnPasswordCheck,
  hashPassword,
  consumeRefreshToken,
  issueSession,
  requireUser,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  verifyPassword,
} from "../auth";

export const authRouter = Router();

// Email is unique per tenant, not globally, so a login may name the company.
const loginBodySchema = loginSchema.extend({ tenantSlug: z.string().min(1).optional() });
const refreshBodySchema = z.object({ refreshToken: z.string().min(1) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

const publicUser = (u: { id: string; name: string; email: string; role: string; tenantId: string }) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  tenantId: u.tenantId,
});

// Dashboard login. With tenantSlug the lookup is scoped to that company. Without
// it, every active account with that email is tried; if the password matches more
// than one company the caller has to say which, rather than us picking one.
authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { email, password, tenantSlug } = parsed.data;

    const candidates = await prisma.user.findMany({
      where: {
        email: { equals: email, mode: "insensitive" },
        isActive: true,
        ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
      },
    });
    if (!candidates.length) {
      await burnPasswordCheck(password);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const matches = [];
    for (const u of candidates) {
      if (await verifyPassword(password, u.passwordHash)) matches.push(u);
    }
    if (!matches.length) return res.status(401).json({ error: "Invalid credentials" });
    if (matches.length > 1) {
      return res.status(409).json({ error: "This email belongs to more than one company; pass tenantSlug" });
    }

    const user = matches[0];
    res.json({ ...(await issueSession(user)), user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

// Trade a refresh token for a new access + refresh pair. The old refresh token
// is revoked (rotation), so each one works exactly once.
authRouter.post("/refresh", async (req, res, next) => {
  try {
    const parsed = refreshBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const user = await consumeRefreshToken(parsed.data.refreshToken);
    if (!user) return res.status(401).json({ error: "Invalid refresh token" });
    res.json({ ...(await issueSession(user)), user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

// Revokes the given refresh token. Idempotent: an unknown or already-revoked
// token still returns 204 so clients can always clear local state.
authRouter.post("/logout", async (req, res, next) => {
  try {
    const parsed = refreshBodySchema.safeParse(req.body);
    if (parsed.success) await revokeRefreshToken(parsed.data.refreshToken);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

authRouter.get("/me", requireUser(), async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.auth!.userId, tenantId: req.auth!.homeTenantId },
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });
    if (!user) return res.status(404).json({ error: "Not found" });
    const activeTenant =
      req.auth!.tenantId === user.tenantId
        ? user.tenant
        : await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { id: true, name: true, slug: true } });
    // `tenant` is the account's home company; `activeTenant` is what X-Tenant-Id selected.
    res.json({ ...publicUser(user), tenant: user.tenant, activeTenant });
  } catch (e) {
    next(e);
  }
});

// Companies the caller can switch to with X-Tenant-Id: every company for the
// owner, otherwise just their own. Feeds the dashboard's company switcher.
authRouter.get("/tenants", requireUser(), async (req, res, next) => {
  try {
    const select = { id: true, name: true, slug: true } as const;
    const tenants =
      req.auth!.role === Role.SuperAdmin
        ? await prisma.tenant.findMany({ select, orderBy: { name: "asc" } })
        : await prisma.tenant.findMany({ where: { id: req.auth!.homeTenantId }, select });
    res.json(tenants.map((t) => ({ ...t, home: t.id === req.auth!.homeTenantId })));
  } catch (e) {
    next(e);
  }
});

// Changing the password signs out every session, then hands the caller a fresh
// pair so they stay signed in here.
authRouter.post("/change-password", requireUser(), async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const user = await prisma.user.findFirst({ where: { id: req.auth!.userId, tenantId: req.auth!.homeTenantId } });
    if (!user) return res.status(404).json({ error: "Not found" });
    if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    });
    await revokeAllRefreshTokens(user.id);
    res.json({ ...(await issueSession(updated)), user: publicUser(updated) });
  } catch (e) {
    next(e);
  }
});
