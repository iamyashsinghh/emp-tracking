import { PrismaClient } from "@prisma/client";
import { inject } from "vitest";

/** One Prisma client per spec file, pointed at the e2e database. */
export function e2ePrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: inject("databaseUrl") } } });
}
