import { Router } from "express";
import bcrypt from "bcryptjs";
import { loginSchema } from "@emptrack/shared";
import { prisma } from "../prisma";
import { requireUser, signUserToken } from "../auth";

export const authRouter = Router();

// Dashboard login. Email is unique per tenant, so we look up across tenants
// and (for a real multi-company login) you would scope by tenant slug/subdomain.
authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findFirst({
    where: { email: parsed.data.email, isActive: true },
  });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = signUserToken({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    email: user.email,
  });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId },
  });
});

authRouter.get("/me", requireUser(), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId });
});
