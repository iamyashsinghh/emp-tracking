import { NextFunction, Request, Response, Router } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { Role } from "@emptrack/shared";
import { prisma } from "../prisma";
import { assignableRoles, hashPassword, outranks, requireRoleAtLeast, requireUser } from "../auth";

export const usersRouter = Router();

// Every query below is scoped by req.auth.tenantId, the active company. For most
// users that is their own; an owner can switch it with X-Tenant-Id (see requireUser).

const ALL_ROLES = [Role.SuperAdmin, Role.Admin, Role.Manager, Role.Employee] as const;

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  role: z.enum(ALL_ROLES).default(Role.Employee),
});

const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    role: z.enum(ALL_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

const resetPasswordSchema = z.object({ password: z.string().min(8).max(128) });

const listQuerySchema = z.object({
  role: z.enum(ALL_ROLES).optional(),
  active: z.enum(["true", "false"]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

function findInTenant(tenantId: string, userId: string) {
  return prisma.user.findFirst({ where: { id: userId, tenantId }, select: userSelect });
}

// List users in the caller's company. Managers can read; only admins and up write.
usersRouter.get(
  "/",
  requireRoleAtLeast(Role.Manager),
  wrap(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { role, active, q, take, skip } = parsed.data;

    const where: Prisma.UserWhereInput = {
      tenantId: req.auth!.tenantId,
      ...(role ? { role } : {}),
      ...(active ? { isActive: active === "true" } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await prisma.$transaction([
      prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.user.count({ where }),
    ]);
    res.setHeader("X-Total-Count", String(total));
    res.json(items);
  })
);

// Any signed-in user can read themselves; managers and up can read anyone in their company.
usersRouter.get(
  "/:userId",
  requireUser(),
  wrap(async (req, res) => {
    const self = req.params.userId === req.auth!.userId;
    if (!self && !outranks(req.auth!.role, Role.Employee)) {
      return res.status(403).json({ error: "Insufficient role" });
    }
    const user = await findInTenant(req.auth!.tenantId, req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  })
);

// Admins create managers and employees; the owner can also create admins.
usersRouter.post(
  "/",
  requireRoleAtLeast(Role.Admin),
  wrap(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (!assignableRoles(req.auth!.role).includes(parsed.data.role)) {
      return res.status(403).json({ error: `You cannot create a user with role ${parsed.data.role}` });
    }

    try {
      const user = await prisma.user.create({
        data: {
          tenantId: req.auth!.tenantId,
          name: parsed.data.name,
          email: parsed.data.email,
          role: parsed.data.role,
          passwordHash: await hashPassword(parsed.data.password),
        },
        select: userSelect,
      });
      res.status(201).json(user);
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: "Email already exists in this company" });
      throw e;
    }
  })
);

// Update a user. Everyone may rename themselves. Changing anything else, or
// anyone else, needs admin and a strictly higher rank than the target, so an
// admin cannot touch another admin or the owner, and nobody can promote
// someone to their own level or demote/deactivate themselves.
usersRouter.patch(
  "/:userId",
  requireUser(),
  wrap(async (req, res) => {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const changes = parsed.data;
    const actor = req.auth!;

    const target = await findInTenant(actor.tenantId, req.params.userId);
    if (!target) return res.status(404).json({ error: "User not found" });

    const self = target.id === actor.userId;
    const onlyName = Object.keys(changes).every((k) => k === "name");
    if (!(self && onlyName)) {
      if (self) return res.status(403).json({ error: "You can only change your own name" });
      if (!outranks(actor.role, Role.Manager) || !outranks(actor.role, target.role)) {
        return res.status(403).json({ error: "Insufficient role" });
      }
      if (changes.role && !assignableRoles(actor.role).includes(changes.role)) {
        return res.status(403).json({ error: `You cannot assign role ${changes.role}` });
      }
    }

    try {
      const user = await prisma.user.update({ where: { id: target.id }, data: changes, select: userSelect });
      res.json(user);
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: "Email already exists in this company" });
      throw e;
    }
  })
);

// Admin-initiated password reset. Rotates the user's refresh-token key, so all
// of their existing sessions end.
usersRouter.post(
  "/:userId/password",
  requireRoleAtLeast(Role.Admin),
  wrap(async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const target = await findInTenant(req.auth!.tenantId, req.params.userId);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.id === req.auth!.userId) {
      return res.status(400).json({ error: "Use /api/auth/change-password for your own password" });
    }
    if (!outranks(req.auth!.role, target.role)) return res.status(403).json({ error: "Insufficient role" });

    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash: await hashPassword(parsed.data.password) },
    });
    res.status(204).end();
  })
);

// Deactivate a user (soft delete). Activity and media stay attached for reporting;
// a deactivated user can no longer sign in and their live tokens stop working.
usersRouter.delete(
  "/:userId",
  requireRoleAtLeast(Role.Admin),
  wrap(async (req, res) => {
    const target = await findInTenant(req.auth!.tenantId, req.params.userId);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.id === req.auth!.userId) return res.status(400).json({ error: "You cannot deactivate yourself" });
    if (!outranks(req.auth!.role, target.role)) return res.status(403).json({ error: "Insufficient role" });

    await prisma.user.update({ where: { id: target.id }, data: { isActive: false } });
    res.status(204).end();
  })
);

// Issue a device enrollment token for an employee. The agent redeems it once.
usersRouter.post(
  "/:userId/devices",
  requireRoleAtLeast(Role.Admin),
  wrap(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId, tenantId: req.auth!.tenantId, isActive: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const device = await prisma.device.create({
      data: {
        tenantId: req.auth!.tenantId,
        userId: user.id,
        enrollmentToken: randomBytes(24).toString("hex"),
      },
    });
    res.status(201).json({ deviceId: device.id, enrollmentToken: device.enrollmentToken });
  })
);
