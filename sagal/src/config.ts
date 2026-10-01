import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Infrastructure comes from the environment. API keys for services Sabah connects
 * later (Claude, HeyGen, Captions, Meta, LinkedIn, YouTube, TikTok, email) are pasted
 * into Connected accounts and kept encrypted in the database instead; an environment
 * variable, when set, is used as a fallback.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** 32 random bytes, base64. Encrypts the secret store. Generate with `npm run gen-key`. */
  SECRETS_MASTER_KEY: z.string().min(32, "SECRETS_MASTER_KEY must be a long random value (generate one with npm run gen-key)"),
  /** The only email address that can create the owner account. Required in production. */
  OWNER_EMAIL: z.string().email().optional(),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  DEPLOYMENT_ENV: z.string().default("development"),
  /** Public URL of the app, e.g. https://sagal.onrender.com. Used for OAuth callbacks and emails. */
  APP_URL: z.string().default("http://localhost:8080"),

  // Claude (Sagal's reasoning). The key can also be pasted in Connected accounts.
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Everyday thinking (fast, lower cost) and deep thinking (planning, strategy, long creative work). */
  SAGAL_MODEL_EVERYDAY: z.string().default("claude-sonnet-5-5"),
  SAGAL_MODEL_DEEP: z.string().default("claude-opus-5-5"),
  SAGAL_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  // Sign-in codes are emailed with Resend. Without a key, codes are written to the server log.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Sagal <onboarding@resend.dev>"),

  // Private media storage: "local" (a folder on disk, for development) or "s3"
  // (any S3-compatible store: Supabase Storage, Cloudflare R2, AWS S3).
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_MEDIA_DIR: z.string().default(".media"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  /** Optional separate bucket for Sabah's voiceovers. Defaults to S3_BUCKET under voiceovers/. */
  S3_VOICEOVER_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(500),

  WORKER_POLL_SECONDS: z.coerce.number().min(1).default(30),
});

export type Config = z.infer<typeof EnvSchema>;

/** 32-byte key from SECRETS_MASTER_KEY: used as-is when it's 32 bytes of base64, otherwise hashed. */
export function masterKey(value: string): Buffer {
  const raw = Buffer.from(value, "base64");
  return raw.length === 32 && raw.toString("base64") === value ? raw : createHash("sha256").update(value).digest();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.DEPLOYMENT_ENV === "production") {
    if (!cfg.OWNER_EMAIL) throw new Error("Invalid configuration: OWNER_EMAIL is required in production");
    if (cfg.STORAGE_DRIVER !== "s3") throw new Error("Invalid configuration: STORAGE_DRIVER must be s3 in production (disk storage is wiped on redeploy)");
  }
  if (cfg.STORAGE_DRIVER === "s3") {
    for (const k of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!cfg[k]) throw new Error(`Invalid configuration: ${k} is required when STORAGE_DRIVER=s3`);
    }
  }
  return cfg;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: "postgres://unused",
    SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  } as NodeJS.ProcessEnv);
}
