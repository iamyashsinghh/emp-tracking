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

// Presigned URLs embed the host in the signature, so they must be signed for
// the host the agent / browser actually reaches (S3_PUBLIC_URL), not the
// internal endpoint (e.g. `minio:9000` inside Docker). Presigning is computed
// locally — with the region set, this client never makes a network call.
const publicEp = parseEndpoint(env.s3.publicUrl || env.s3.endpoint);

const s3Public = new MinioClient({
  endPoint: publicEp.endPoint,
  port: publicEp.port,
  useSSL: publicEp.useSSL,
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
  const uploadUrl = await s3Public.presignedPutObject(env.s3.bucket, key, expirySeconds);
  return { uploadUrl, requiredHeaders: { "Content-Type": contentType } };
}

/**
 * Presigned GET the dashboard uses to display a screenshot / play a clip.
 * Pass `downloadName` to force a browser download instead of inline display.
 */
export async function presignDownload(
  key: string,
  expirySeconds = 60 * 10,
  downloadName?: string
): Promise<string> {
  if (!downloadName) return s3Public.presignedGetObject(env.s3.bucket, key, expirySeconds);
  const safe = downloadName.replace(/[^\w.-]/g, "_");
  return s3Public.presignedGetObject(env.s3.bucket, key, expirySeconds, {
    "response-content-disposition": `attachment; filename="${safe}"`,
  });
}

/** Size of a stored object, or null if it does not exist (yet). */
export async function statObjectSize(key: string): Promise<number | null> {
  try {
    const stat = await s3.statObject(env.s3.bucket, key);
    return stat.size;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "NotFound" || code === "NoSuchKey") return null;
    throw e;
  }
}

/**
 * Delete objects in batches of 1000 (the S3 DeleteObjects limit). Missing
 * keys are not an error, so this is safe to retry.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length) await s3.removeObjects(env.s3.bucket, batch);
  }
}
