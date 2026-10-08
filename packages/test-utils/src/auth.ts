import jwt from "jsonwebtoken";

/**
 * Token helpers that mint the same JWT shapes the backend signs in
 * apps/backend/src/auth.ts, so route tests can call guarded endpoints
 * without going through /login or /enroll first.
 */

export const TEST_JWT_SECRET = "test-jwt-secret";

export interface TestUserClaims {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

export function userToken(claims: TestUserClaims, secret = process.env.JWT_SECRET ?? TEST_JWT_SECRET): string {
  return jwt.sign(claims, secret, { expiresIn: "1h" });
}

export function deviceToken(
  claims: { deviceId: string; tenantId: string },
  secret = process.env.JWT_SECRET ?? TEST_JWT_SECRET
): string {
  return jwt.sign({ ...claims, kind: "device" }, secret, { expiresIn: "1h" });
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
