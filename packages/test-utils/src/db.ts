import bcrypt from "bcryptjs";
import type { Device, PrismaClient, Tenant, TenantPolicy, User } from "@prisma/client";
import { Role } from "@emptrack/shared";
import { DEFAULT_PASSWORD, buildDevice, buildTenant, buildUser } from "./factories";

/**
 * Helpers for tests that run against a real Postgres (integration and e2e).
 * Pass in the PrismaClient the test owns so connection lifetime stays with
 * the test, not this module.
 */

/** Empties every table in the current schema, keeping the schema itself. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function createTenant(
  prisma: PrismaClient,
  overrides: Partial<Pick<Tenant, "name" | "slug">> = {}
): Promise<Tenant & { policy: TenantPolicy | null }> {
  const t = buildTenant(overrides);
  return prisma.tenant.create({
    data: { name: t.name, slug: t.slug, policy: { create: {} } },
    include: { policy: true },
  });
}

export async function createUser(
  prisma: PrismaClient,
  tenantId: string,
  overrides: Partial<Pick<User, "email" | "name" | "role" | "isActive">> & { password?: string } = {}
): Promise<User & { password: string }> {
  const { password = DEFAULT_PASSWORD, ...rest } = overrides;
  const u = buildUser(rest);
  const user = await prisma.user.create({
    data: {
      tenantId,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  return { ...user, password };
}

/** A device row awaiting enrollment, as POST /api/users/:id/devices creates. */
export async function createPendingDevice(
  prisma: PrismaClient,
  tenantId: string,
  userId: string | null
): Promise<Device> {
  const d = buildDevice();
  return prisma.device.create({
    data: { tenantId, userId, enrollmentToken: d.enrollmentToken },
  });
}

export interface SeededTenant {
  tenant: Tenant & { policy: TenantPolicy | null };
  admin: User & { password: string };
  manager: User & { password: string };
  employee: User & { password: string };
}

/** One company with an admin, a manager and an employee — the common starting point. */
export async function seedTenant(
  prisma: PrismaClient,
  overrides: Partial<Pick<Tenant, "name" | "slug">> = {}
): Promise<SeededTenant> {
  const tenant = await createTenant(prisma, overrides);
  const admin = await createUser(prisma, tenant.id, { role: Role.Admin });
  const manager = await createUser(prisma, tenant.id, { role: Role.Manager });
  const employee = await createUser(prisma, tenant.id, { role: Role.Employee });
  return { tenant, admin, manager, employee };
}
