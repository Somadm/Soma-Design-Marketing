import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { masterKey, type Config } from "../config.js";

/**
 * Private media storage. Nothing is public: files are read through short-lived signed
 * links. Two areas are kept apart: `media` (references, renders, brand assets, voice
 * notes) and `voiceovers` (Sabah's own recorded voiceovers, production assets only).
 */
export interface Storage {
  put(key: string, body: Readable | Buffer, contentType: string): Promise<{ size: number }>;
  /** A link that works for `seconds`, then stops. */
  signedUrl(key: string, filename: string, seconds?: number): Promise<string>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export function safeKey(key: string): string {
  // Reject anything that could step outside its folder: only plain characters, and no
  // path segment that is empty, "." or "..".
  const segments = key.split("/");
  if (!/^[a-z0-9-]+\/[A-Za-z0-9._\/-]+$/.test(key) || segments.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
  return key;
}

export function storageFilename(original: string): string {
  const base = path
    .basename(original)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".") // "Logo...@3x.png" → "Logo.-3x.png"
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(-80);
  return base || "file";
}

/** Disk storage for development. Links are signed with HMAC and served by /media/*. */
export class LocalStorage implements Storage {
  constructor(
    private root: string,
    private signingKey: Buffer,
  ) {}

  private file(key: string) {
    return path.join(this.root, safeKey(key));
  }

  async put(key: string, body: Readable | Buffer, _contentType: string) {
    const target = this.file(key);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(Buffer.isBuffer(body) ? Readable.from(body) : body, createWriteStream(target));
    return { size: (await stat(target)).size };
  }

  sign(key: string, exp: number, filename: string): string {
    return createHmac("sha256", this.signingKey).update(`${key}\n${exp}\n${filename}`).digest("base64url");
  }

  verify(key: string, exp: number, filename: string, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const a = Buffer.from(this.sign(key, exp, filename)), b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async signedUrl(key: string, filename: string, seconds = 900) {
    const exp = Math.floor(Date.now() / 1000) + seconds;
    const q = new URLSearchParams({ exp: String(exp), name: filename, sig: this.sign(safeKey(key), exp, filename) });
    return `/media/${key}?${q}`;
  }

  async read(key: string) {
    return createReadStream(this.file(key));
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

/** Any S3-compatible service: Supabase Storage, Cloudflare R2, AWS S3. Buckets stay private. */
export class S3Storage implements Storage {
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}

  async put(key: string, body: Readable | Buffer, contentType: string) {
    let size = Buffer.isBuffer(body) ? body.length : 0;
    const counted = Buffer.isBuffer(body)
      ? body
      : body.pipe(new Transform({ transform: (chunk: Buffer, _enc, cb) => ((size += chunk.length), cb(null, chunk)) }));
    await new Upload({ client: this.client, params: { Bucket: this.bucket, Key: safeKey(key), Body: counted, ContentType: contentType } }).done();
    return { size };
  }

  async signedUrl(key: string, filename: string, seconds = 900) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key), ResponseContentDisposition: `inline; filename="${filename.replace(/"/g, "")}"` }),
      { expiresIn: seconds },
    );
  }

  async read(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    return out.Body as Readable;
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }
}

export interface Storages {
  media: Storage;
  voiceovers: Storage;
  local?: LocalStorage;
}

export function createStorages(cfg: Config): Storages {
  if (cfg.STORAGE_DRIVER === "local") {
    const local = new LocalStorage(path.resolve(cfg.LOCAL_MEDIA_DIR), masterKey(`media:${cfg.SECRETS_MASTER_KEY}`));
    return { media: local, voiceovers: local, local };
  }
  const client = new S3Client({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
    // Newer SDKs add CRC checksums by default; some S3-compatible stores (Supabase, R2) reject them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID!, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY! },
  });
  const media = new S3Storage(client, cfg.S3_BUCKET!);
  const voiceovers = cfg.S3_VOICEOVER_BUCKET ? new S3Storage(client, cfg.S3_VOICEOVER_BUCKET) : media;
  return { media, voiceovers };
}
