import { Client as MinioClient } from "minio";
import { env } from "./env";

// S3-compatible object storage for screenshots and recordings.
// Defaults to the MinIO service in docker-compose; swap the env vars for
// real AWS S3 / Cloudflare R2 / Wasabi in production.

function parseEndpoint(url: string): { endPoint: string; port: number; useSSL: boolean } {
  const u = new URL(url);
  return {
    endPoint: u.hostname,
    port: u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80,
    useSSL: u.protocol === "https:",
  };
}

const ep = parseEndpoint(env.s3.endpoint);

export const s3 = new MinioClient({
  endPoint: ep.endPoint,
  port: ep.port,
  useSSL: ep.useSSL,
  accessKey: env.s3.accessKey,
  secretKey: env.s3.secretKey,
  region: env.s3.region,
});

export async function ensureBucket(): Promise<void> {
  const exists = await s3.bucketExists(env.s3.bucket).catch(() => false);
  if (!exists) {
    await s3.makeBucket(env.s3.bucket, env.s3.region);
  }
}

/** Presigned PUT the agent uses to upload media bytes directly to storage. */
export async function presignUpload(
  key: string,
  contentType: string,
  expirySeconds = 60 * 10
): Promise<{ uploadUrl: string; requiredHeaders: Record<string, string> }> {
  const uploadUrl = await s3.presignedPutObject(env.s3.bucket, key, expirySeconds);
  return { uploadUrl, requiredHeaders: { "Content-Type": contentType } };
}

/** Presigned GET the dashboard uses to display a screenshot / play a clip. */
export async function presignDownload(key: string, expirySeconds = 60 * 10): Promise<string> {
  return s3.presignedGetObject(env.s3.bucket, key, expirySeconds);
}
