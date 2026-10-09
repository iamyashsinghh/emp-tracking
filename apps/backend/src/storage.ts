import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import { Router } from "express";
import type { Client as MinioClient } from "minio";
import { env } from "./env";

// Media storage for screenshots and recordings.
//
// STORAGE_DRIVER=local (default): bytes live on disk under STORAGE_DIR, one
// subfolder per tenant (the key prefix). Uploads and downloads go through the
// backend itself at /api/storage/<token>, where the token is an HMAC-signed,
// short-lived grant for one key — the same shape as an S3 presigned URL, so
// the agent and dashboard don't care which driver is active.
//
// STORAGE_DRIVER=s3: S3-compatible object storage (MinIO, AWS S3, R2, Wasabi)
// with real presigned URLs, configured through the S3_* env vars.

/** Hard ceiling for one upload when the caller doesn't pass a tighter one. */
const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  webm: "video/webm",
  mp4: "video/mp4",
};

interface StorageDriver {
  init(): Promise<void>;
  presignUpload(key: string, contentType: string, expirySeconds: number, maxBytes: number): Promise<string>;
  presignDownload(key: string, expirySeconds: number, downloadName?: string): Promise<string>;
  statObjectSize(key: string): Promise<number | null>;
  deleteObjects(keys: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local folder driver
// ---------------------------------------------------------------------------

const storageRoot = path.resolve(env.storage.dir);

/** Resolve a storage key to a path inside STORAGE_DIR, rejecting traversal. */
function localPath(key: string): string {
  if (!key || key.includes("\0") || key.includes("\\") || key.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  const p = path.resolve(storageRoot, key);
  if (!p.startsWith(storageRoot + path.sep)) throw new Error(`Invalid storage key: ${key}`);
  return p;
}

interface Grant {
  op: "put" | "get";
  key: string;
  exp: number; // unix seconds
  max?: number; // put: byte limit
  dl?: string; // get: force download with this filename
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function sign(payload: string): string {
  return crypto.createHmac("sha256", env.jwtSecret).update(`storage:${payload}`).digest("base64url");
}

function makeToken(grant: Grant): string {
  const payload = b64url(JSON.stringify(grant));
  return `${payload}.${sign(payload)}`;
}

function readToken(token: string): Grant | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Grant;
    if (typeof grant.exp !== "number" || grant.exp < Date.now() / 1000) return null;
    return grant;
  } catch {
    return null;
  }
}

function storageUrl(grant: Grant): string {
  return `${env.publicApiUrl.replace(/\/+$/, "")}/api/storage/${makeToken(grant)}`;
}

const localDriver: StorageDriver = {
  async init() {
    await fsp.mkdir(storageRoot, { recursive: true });
  },
  async presignUpload(key, _contentType, expirySeconds, maxBytes) {
    localPath(key);
    return storageUrl({ op: "put", key, exp: Math.floor(Date.now() / 1000) + expirySeconds, max: maxBytes });
  },
  async presignDownload(key, expirySeconds, downloadName) {
    localPath(key);
    return storageUrl({
      op: "get",
      key,
      exp: Math.floor(Date.now() / 1000) + expirySeconds,
      ...(downloadName ? { dl: downloadName.replace(/[^\w.-]/g, "_") } : {}),
    });
  },
  async statObjectSize(key) {
    try {
      const st = await fsp.stat(localPath(key));
      return st.isFile() ? st.size : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  async deleteObjects(keys) {
    for (const key of keys) await fsp.rm(localPath(key), { force: true });
  },
};

/**
 * Serves signed upload (PUT) and download (GET) grants for the local driver.
 * Mounted at /api/storage. The token is the only credential, exactly like a
 * presigned S3 URL, so it works for <img src> and for the agent's raw PUT.
 */
export const storageRouter = Router();

storageRouter.put("/:token", async (req, res) => {
  const grant = readToken(req.params.token);
  if (!grant || grant.op !== "put") return res.status(403).json({ error: "Invalid or expired upload URL" });

  const max = grant.max ?? DEFAULT_MAX_UPLOAD_BYTES;
  const declared = parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > max) {
    return res.status(413).json({ error: `File too large (${declared} bytes)` });
  }

  let target: string;
  try {
    target = localPath(grant.key);
  } catch {
    return res.status(400).json({ error: "Invalid key" });
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });

  // Write to a temp file and rename, so a half-finished upload is never
  // visible to confirm/stat and a retried PUT simply replaces it.
  const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.part`;
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > max) cb(Object.assign(new Error("too large"), { code: "E_TOO_LARGE" }));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(tmp));
    await fsp.rename(tmp, target);
    res.status(200).json({ ok: true, size: seen });
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    if ((e as { code?: string }).code === "E_TOO_LARGE") {
      return res.status(413).json({ error: `File too large (> ${max} bytes)` });
    }
    if (!res.headersSent) res.status(500).json({ error: "Upload failed" });
  }
});

storageRouter.get("/:token", (req, res) => {
  const grant = readToken(req.params.token);
  if (!grant || grant.op !== "get") return res.status(403).json({ error: "Invalid or expired URL" });

  let file: string;
  try {
    file = localPath(grant.key);
  } catch {
    return res.status(400).json({ error: "Invalid key" });
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (grant.dl) res.setHeader("Content-Disposition", `attachment; filename="${grant.dl}"`);
  // sendFile streams the file and handles Range requests (video seeking).
  res.sendFile(file, { dotfiles: "deny" }, (err) => {
    if (err && !res.headersSent) {
      const status = (err as { status?: number }).status ?? 500;
      res.status(status === 404 ? 404 : status).json({ error: status === 404 ? "Not found" : "Read failed" });
    }
  });
});

// ---------------------------------------------------------------------------
// S3 / MinIO driver (STORAGE_DRIVER=s3)
// ---------------------------------------------------------------------------

function parseEndpoint(url: string): { endPoint: string; port: number; useSSL: boolean } {
  const u = new URL(url);
  return {
    endPoint: u.hostname,
    port: u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80,
    useSSL: u.protocol === "https:",
  };
}

function createS3Driver(): StorageDriver {
  // Loaded lazily so the local driver never touches the MinIO client.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("minio") as typeof import("minio");
  const client = (url: string): MinioClient => {
    const ep = parseEndpoint(url);
    return new Client({
      endPoint: ep.endPoint,
      port: ep.port,
      useSSL: ep.useSSL,
      accessKey: env.s3.accessKey,
      secretKey: env.s3.secretKey,
      region: env.s3.region,
    });
  };
  const s3 = client(env.s3.endpoint);
  // Presigned URLs embed the host in the signature, so they must be signed for
  // the host the agent / browser actually reaches (S3_PUBLIC_URL), not the
  // internal endpoint (e.g. `minio:9000` inside Docker). Presigning is computed
  // locally — with the region set, this client never makes a network call.
  const s3Public = client(env.s3.publicUrl || env.s3.endpoint);

  return {
    async init() {
      const exists = await s3.bucketExists(env.s3.bucket).catch(() => false);
      if (!exists) await s3.makeBucket(env.s3.bucket, env.s3.region);
    },
    async presignUpload(key, _contentType, expirySeconds) {
      return s3Public.presignedPutObject(env.s3.bucket, key, expirySeconds);
    },
    async presignDownload(key, expirySeconds, downloadName) {
      if (!downloadName) return s3Public.presignedGetObject(env.s3.bucket, key, expirySeconds);
      const safe = downloadName.replace(/[^\w.-]/g, "_");
      return s3Public.presignedGetObject(env.s3.bucket, key, expirySeconds, {
        "response-content-disposition": `attachment; filename="${safe}"`,
      });
    },
    async statObjectSize(key) {
      try {
        return (await s3.statObject(env.s3.bucket, key)).size;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "NotFound" || code === "NoSuchKey") return null;
        throw e;
      }
    },
    async deleteObjects(keys) {
      // Batches of 1000, the S3 DeleteObjects limit. Missing keys are not an error.
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        if (batch.length) await s3.removeObjects(env.s3.bucket, batch);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Public API (driver-agnostic)
// ---------------------------------------------------------------------------

let driver: StorageDriver | null = null;
function active(): StorageDriver {
  if (!driver) driver = env.storage.driver === "s3" ? createS3Driver() : localDriver;
  return driver;
}

export const storageDriverName = env.storage.driver;

/** Create the storage folder (local) or bucket (s3) if missing. */
export async function ensureStorage(): Promise<void> {
  await active().init();
}

/** Short-lived URL the agent PUTs media bytes to. */
export async function presignUpload(
  key: string,
  contentType: string,
  expirySeconds = 60 * 10,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES
): Promise<{ uploadUrl: string; requiredHeaders: Record<string, string> }> {
  const uploadUrl = await active().presignUpload(key, contentType, expirySeconds, maxBytes);
  return { uploadUrl, requiredHeaders: { "Content-Type": contentType } };
}

/**
 * Short-lived URL the dashboard uses to display a screenshot / play a clip.
 * Pass `downloadName` to force a browser download instead of inline display.
 */
export async function presignDownload(key: string, expirySeconds = 60 * 10, downloadName?: string): Promise<string> {
  return active().presignDownload(key, expirySeconds, downloadName);
}

/** Size of a stored object, or null if it does not exist (yet). */
export async function statObjectSize(key: string): Promise<number | null> {
  return active().statObjectSize(key);
}

/** Delete stored objects. Missing keys are not an error, so this is safe to retry. */
export async function deleteObjects(keys: string[]): Promise<void> {
  return active().deleteObjects(keys);
}
