import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
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

export function signUserToken(u: AuthUser): string {
  return jwt.sign(u, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
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

/** Guard for dashboard / admin endpoints. */
export function requireUser(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "Missing token" });
    try {
      const payload = jwt.verify(token, env.jwtSecret) as AuthUser & { kind?: string };
      if (payload.kind === "device") return res.status(403).json({ error: "Device token not allowed here" });
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ error: "Insufficient role" });
      }
      req.auth = {
        userId: payload.userId,
        tenantId: payload.tenantId,
        role: payload.role,
        email: payload.email,
      };
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
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
