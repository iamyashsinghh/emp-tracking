import { Router } from "express";
import { z } from "zod";
import { devicePolicySchema, Role } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireUser } from "../auth";

export const tenantsRouter = Router();

const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
});

// Only the platform owner can spin up a new company.
tenantsRouter.post("/", requireUser(Role.SuperAdmin), async (req, res) => {
  const parsed = createTenantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tenant = await prisma.tenant.create({
    data: {
      name: parsed.data.name,
      slug: parsed.data.slug,
      policy: { create: {} }, // sensible defaults from the schema
    },
    include: { policy: true },
  });
  res.status(201).json(tenant);
});

tenantsRouter.get("/", requireUser(Role.SuperAdmin), async (_req, res) => {
  const tenants = await prisma.tenant.findMany({
    include: { _count: { select: { users: true, devices: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(tenants);
});

// A tenant admin can read and update their own company's monitoring policy.
tenantsRouter.get("/policy", requireUser(Role.SuperAdmin, Role.Admin), async (req, res) => {
  const policy = await prisma.tenantPolicy.findUnique({ where: { tenantId: req.auth!.tenantId } });
  res.json(policy);
});

tenantsRouter.put("/policy", requireUser(Role.SuperAdmin, Role.Admin), async (req, res) => {
  const parsed = devicePolicySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const policy = await prisma.tenantPolicy.upsert({
    where: { tenantId: req.auth!.tenantId },
    update: parsed.data,
    create: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.json(policy);
});
