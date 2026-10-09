import dotenv from "dotenv";
import path from "path";

// Load the repo-root .env when running from source.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const port = parseInt(process.env.BACKEND_PORT ?? "4002", 10);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  databaseUrl: req("DATABASE_URL"),
  jwtSecret: req("JWT_SECRET", "change-me-in-production-please"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Base URL agents and browsers use to reach this API. Local-storage upload
  // and download links are built on it, so it must be externally reachable.
  publicApiUrl: process.env.PUBLIC_API_URL || `http://localhost:${port}`,
  storage: {
    // "local" (default): files on disk under STORAGE_DIR. "s3": S3/MinIO below.
    driver: (process.env.STORAGE_DRIVER ?? "local").toLowerCase() === "s3" ? ("s3" as const) : ("local" as const),
    dir: process.env.STORAGE_DIR || "./storage",
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    bucket: process.env.S3_BUCKET ?? "emptrack-media",
    publicUrl: process.env.S3_PUBLIC_URL ?? "http://localhost:9000",
  },
};
