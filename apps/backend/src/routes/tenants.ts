import { NextFunction, Request, Response, Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { devicePolicySchema, Role } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireUser } from "../auth";

export const tenantsRouter = Router();

const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens");

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
  // Optional starting policy; anything omitted falls back to schema defaults.
  policy: devicePolicySchema.partial().optional(),
});

const updateTenantSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: slugSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

// Partial update of the monitoring policy. Working hours accept null so an
// admin can clear them and go back to "always on".
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:mm");
const policyUpdateSchema = devicePolicySchema
  .partial()
  .extend({
    workingHoursStart: hhmm.nullable().optional(),
    workingHoursEnd: hhmm.nullable().optional(),
  })
  .strict();

type Handler = (req: Request, res: Response) => Promise<unknown>;

// Express 4 does not forward rejected promises, so route errors through next().
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const isSuperAdmin = (req: Request) => req.auth!.role === Role.SuperAdmin;

/**
 * Resolve which tenant a request may act on. Admins are pinned to their own
 * company no matter what they ask for; only the platform owner can reach
 * across tenants. Returns null when the caller is not allowed.
 */
function resolveTenantId(req: Request, requested?: string): string | null {
  const own = req.auth!.tenantId;
  if (!requested || requested === own) return own;
  return isSuperAdmin(req) ? requested : null;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

function isNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

const tenantSummary = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { users: true, devices: true } },
} satisfies Prisma.TenantSelect;

// ---------------------------------------------------------------------------
// Monitoring policy. Declared before "/:id" so "policy" is not taken as an id.
// GET/PUT /api/tenants/policy acts on the caller's company; the owner can pass
// ?tenantId=... (or use /:id/policy below) to manage any company.
// ---------------------------------------------------------------------------

async function loadPolicy(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) return null;
  // Tenants created before policies existed get the defaults on first read.
  return prisma.tenantPolicy.upsert({ where: { tenantId }, update: {}, create: { tenantId } });
}

async function savePolicy(req: Request, res: Response, tenantId: string) {
  const parsed = policyUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const current = await loadPolicy(tenantId);
  if (!current) return res.status(404).json({ error: "Company not found" });

  // Working hours only make sense as a pair once the update is applied.
  const start =
    parsed.data.workingHoursStart !== undefined ? parsed.data.workingHoursStart : current.workingHoursStart;
  const end = parsed.data.workingHoursEnd !== undefined ? parsed.data.workingHoursEnd : current.workingHoursEnd;
  if (!start !== !end) {
    return res.status(400).json({ error: "workingHoursStart and workingHoursEnd must be set together" });
  }

  const policy = await prisma.tenantPolicy.update({ where: { tenantId }, data: parsed.data });
  res.json(policy);
}

async function getPolicy(req: Request, res: Response, tenantId: string) {
  const policy = await loadPolicy(tenantId);
  if (!policy) return res.status(404).json({ error: "Company not found" });
  res.json(policy);
}

const queryTenantId = (req: Request) =>
  typeof req.query.tenantId === "string" && req.query.tenantId ? req.query.tenantId : undefined;

tenantsRouter.get(
  "/policy",
  requireUser(Role.SuperAdmin, Role.Admin),
  wrap(async (req, res) => {
    const tenantId = resolveTenantId(req, queryTenantId(req));
    if (!tenantId) return res.status(403).json({ error: "Not allowed for this company" });
    return getPolicy(req, res, tenantId);
  })
);

tenantsRouter.put(
  "/policy",
  requireUser(Role.SuperAdmin, Role.Admin),
  wrap(async (req, res) => {
    const tenantId = resolveTenantId(req, queryTenantId(req));
    if (!tenantId) return res.status(403).json({ error: "Not allowed for this company" });
    return savePolicy(req, res, tenantId);
  })
);

// ---------------------------------------------------------------------------
// Company CRUD
// ---------------------------------------------------------------------------

// Only the platform owner can spin up a new company.
tenantsRouter.post(
  "/",
  requireUser(Role.SuperAdmin),
  wrap(async (req, res) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const tenant = await prisma.tenant.create({
        data: {
          name: parsed.data.name,
          slug: parsed.data.slug,
          policy: { create: parsed.data.policy ?? {} },
        },
        include: { policy: true },
      });
      res.status(201).json(tenant);
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: "Slug already in use" });
      throw e;
    }
  })
);

// The owner sees every company; an admin only sees their own.
tenantsRouter.get(
  "/",
  requireUser(Role.SuperAdmin, Role.Admin),
  wrap(async (req, res) => {
    const tenants = await prisma.tenant.findMany({
      where: isSuperAdmin(req) ? undefined : { id: req.auth!.tenantId },
      select: tenantSummary,
      orderBy: { createdAt: "desc" },
    });
    res.json(tenants);
  })
);

tenantsRouter.get(
  "/:id",
  requireUser(Role.SuperAdmin, Role.Admin),
  wrap(async (req, res) => {
    const tenantId = resolveTenantId(req, req.params.id);
    if (!tenantId) return res.status(404).json({ error: "Company not found" });

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { ...tenantSummary, policy: true },
    });
    if (!tenant) return res.status(404).json({ error: "Company not found" });
    res.json(tenant);
  })
);

// Renaming is allowed for the company's own admin; changing the slug is an
// owner-only operation since it is the company's stable identifier.
tenantsRouter.patch(
  "/:id",
  requireUser(Role.SuperAdmin, Role.Admin),
  wrap(async (req, res) => {
    const tenantId = resolveTenantId(req, req.params.id);
    if (!tenantId) return res.status(404).json({ error: "Company not found" });

    const parsed = updateTenantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (parsed.data.slug !== undefined && !isSuperAdmin(req)) {
      return res.status(403).json({ error: "Only the owner can change a company slug" });
    }

    try {
      const tenant = await prisma.tenant.update({
        where: { id: tenantId },
        data: parsed.data,
        select: tenantSummary,
      });
      res.json(tenant);
    } catch (e) {
      if (isUniqueViolation(e)) return res.status(409).json({ error: "Slug already in use" });
      if (isNotFound(e)) return res.status(404).json({ error: "Company not found" });
      throw e;
    }
  })
);

// Deleting a company cascades to its users, devices, activity and media rows.
// The owner cannot delete the company their own account lives in, which would
// lock them out of the platform.
tenantsRouter.delete(
  "/:id",
  requireUser(Role.SuperAdmin),
  wrap(async (req, res) => {
    if (req.params.id === req.auth!.tenantId) {
      return res.status(409).json({ error: "You cannot delete the company your own account belongs to" });
    }
    try {
      await prisma.tenant.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (e) {
      if (isNotFound(e)) return res.status(404).json({ error: "Company not found" });
      throw e;
    }
  })
);

tenantsRouter.get(
  "/:id/policy",
  requireUser(Role.SuperAdmin, Role.Admin),
  wrap(async (req, res) => {
    const tenantId = resolveTenantId(req, req.params.id);
    if (!tenantId) return res.status(404).json({ error: "Company not found" });
    return getPolicy(req, res, tenantId);
  })
);

tenantsRouter.put(
  "/:id/policy",
  requireUser(Role.SuperAdmin, Role.Admin),
  wrap(async (req, res) => {
    const tenantId = resolveTenantId(req, req.params.id);
    if (!tenantId) return res.status(404).json({ error: "Company not found" });
    return savePolicy(req, res, tenantId);
  })
);
