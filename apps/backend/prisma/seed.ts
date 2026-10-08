import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";
import { Role } from "@emptrack/shared";

const prisma = new PrismaClient();

/**
 * Seeds a platform owner plus one demo company with an admin and an employee,
 * so you can log in and see the dashboard immediately after `docker compose up`.
 */
async function main() {
  const ownerPass = await bcrypt.hash("owner12345", 10);
  const adminPass = await bcrypt.hash("admin12345", 10);
  const empPass = await bcrypt.hash("employee12345", 10);

  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-co" },
    update: {},
    create: {
      name: "Demo Company",
      slug: "demo-co",
      policy: { create: { screenRecordingEnabled: true, screenshotIntervalSeconds: 120 } },
    },
  });

  // Platform owner lives in the demo tenant for convenience but is SUPER_ADMIN.
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "owner@demo.co" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Platform Owner",
      email: "owner@demo.co",
      role: Role.SuperAdmin,
      passwordHash: ownerPass,
    },
  });

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo.co" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Demo Admin",
      email: "admin@demo.co",
      role: Role.Admin,
      passwordHash: adminPass,
    },
  });

  const employee = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "employee@demo.co" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Demo Employee",
      email: "employee@demo.co",
      role: Role.Employee,
      passwordHash: empPass,
    },
  });

  const existingDevice = await prisma.device.findFirst({ where: { userId: employee.id } });
  const device =
    existingDevice ??
    (await prisma.device.create({
      data: {
        tenantId: tenant.id,
        userId: employee.id,
        enrollmentToken: randomBytes(24).toString("hex"),
      },
    }));

  console.log("Seed complete.");
  console.log("  Owner login:    owner@demo.co / owner12345");
  console.log("  Admin login:    admin@demo.co / admin12345");
  console.log("  Employee login: employee@demo.co / employee12345");
  console.log(`  Agent enrollment token: ${device.enrollmentToken}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
