import { Router } from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Role } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireUser } from "../auth";

export const usersRouter = Router();

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum([Role.Admin, Role.Manager, Role.Employee]).default(Role.Employee),
});

// List employees/managers within the caller's tenant only (hard isolation).
usersRouter.get("/", requireUser(Role.SuperAdmin, Role.Admin, Role.Manager), async (req, res) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.auth!.tenantId },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(users);
});

usersRouter.post("/", requireUser(Role.SuperAdmin, Role.Admin), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  try {
    const user = await prisma.user.create({
      data: {
        tenantId: req.auth!.tenantId,
        name: parsed.data.name,
        email: parsed.data.email,
        role: parsed.data.role,
        passwordHash,
      },
      select: { id: true, name: true, email: true, role: true },
    });
    res.status(201).json(user);
  } catch {
    res.status(409).json({ error: "Email already exists in this company" });
  }
});

// Issue a device enrollment token for an employee. The agent redeems it once.
usersRouter.post("/:userId/devices", requireUser(Role.SuperAdmin, Role.Admin), async (req, res) => {
  const user = await prisma.user.findFirst({
    where: { id: req.params.userId, tenantId: req.auth!.tenantId },
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
});
