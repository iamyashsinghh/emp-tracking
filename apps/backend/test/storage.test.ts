import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The local storage driver: signed PUT/GET links served by the backend,
// files under STORAGE_DIR/<tenant>/..., and deletes for retention.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emptrack-storage-"));
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_DIR = dir;

let base = "";
let server: ReturnType<express.Express["listen"]>;
let storage: typeof import("../src/storage");

beforeAll(async () => {
  const app = express();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PUBLIC_API_URL = base;
  storage = await import("../src/storage");
  app.use("/api/storage", storage.storageRouter);
  await storage.ensureStorage();
});

afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const key = "tenant-a/device-1/screenshot/2026-10-09/1-abcd.png";
const bytes = Buffer.from("not really a png but bytes are bytes");

describe("local storage driver", () => {
  it("uploads through the signed URL into the tenant folder and serves it back", async () => {
    const { uploadUrl, requiredHeaders } = await storage.presignUpload(key, "image/png", 60, 1024);
    expect(uploadUrl.startsWith(`${base}/api/storage/`)).toBe(true);

    const put = await fetch(uploadUrl, { method: "PUT", headers: requiredHeaders, body: bytes });
    expect(put.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, key))).toEqual(bytes);
    expect(await storage.statObjectSize(key)).toBe(bytes.length);

    const get = await fetch(await storage.presignDownload(key));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);

    const dl = await fetch(await storage.presignDownload(key, 60, "shot one.png"));
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="shot_one.png"');
  });

  it("rejects tampered, expired and wrong-direction tokens", async () => {
    const { uploadUrl } = await storage.presignUpload(key, "image/png", 60, 1024);
    const tampered = uploadUrl.replace(/\.[^.]+$/, ".AAAA");
    expect((await fetch(tampered, { method: "PUT", body: bytes })).status).toBe(403);
    // An upload grant can't be used to read, and vice versa.
    expect((await fetch(uploadUrl)).status).toBe(403);
    expect((await fetch(await storage.presignDownload(key), { method: "PUT", body: bytes })).status).toBe(403);
    const expired = await storage.presignDownload(key, -1);
    expect((await fetch(expired)).status).toBe(403);
  });

  it("enforces the upload size limit and leaves nothing behind", async () => {
    const big = "tenant-a/device-1/recording/2026-10-09/2-ffff.webm";
    const { uploadUrl } = await storage.presignUpload(big, "video/webm", 60, 10);
    const res = await fetch(uploadUrl, { method: "PUT", body: Buffer.alloc(100) });
    expect(res.status).toBe(413);
    expect(await storage.statObjectSize(big)).toBeNull();

    // Streamed (chunked, no Content-Length) bodies are cut off mid-upload.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    });
    const chunked = await fetch(uploadUrl, { method: "PUT", body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(await storage.statObjectSize(big)).toBeNull();
    expect(fs.readdirSync(path.join(dir, "tenant-a/device-1/recording/2026-10-09"))).toEqual([]);
  });

  it("refuses keys that escape the storage folder", async () => {
    await expect(storage.presignUpload("../etc/passwd", "image/png")).rejects.toThrow(/Invalid storage key/);
    await expect(storage.statObjectSize("tenant-a/../../x")).rejects.toThrow(/Invalid storage key/);
  });

  it("deletes files (retention) and tolerates missing ones", async () => {
    await storage.deleteObjects([key, "tenant-a/missing.png"]);
    expect(await storage.statObjectSize(key)).toBeNull();
    expect((await fetch(await storage.presignDownload(key))).status).toBe(404);
  });
});
