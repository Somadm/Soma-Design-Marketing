import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const numList = z
  .string()
  .transform((s) => s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0));

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters"),
  ANTHROPIC_API_KEY: z.string().optional(),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),

  /** "all" runs API + scheduler in one process; "web" or "worker" split them. */
  PROCESS_ROLE: z.enum(["all", "web", "worker"]).default("all"),

  /** Run the initial research automatically when no successful refresh exists yet. */
  KB_AUTO_INITIAL: bool.default(true),
  /** Master switch for the automatic schedule. */
  KB_SCHEDULE_ENABLED: bool.default(true),
  REFRESH_INTERVAL_DAYS: z.coerce.number().positive().default(42),
  SCHEDULER_TICK_SECONDS: z.coerce.number().min(10).default(300),
  /** A running refresh whose heartbeat is older than this is treated as crashed. */
  RUN_STALE_MINUTES: z.coerce.number().positive().default(20),
  /** Delays between automatic retries after a failed/incomplete refresh. Length bounds the retry count. */
  REFRESH_RETRY_DELAYS_HOURS: numList.default([1, 6, 24]),

  /** Per-page fetch retries for temporary failures (timeouts, 429, 5xx). */
  FETCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  FETCH_TIMEOUT_MS: z.coerce.number().default(30000),
  FETCH_BACKOFF_BASE_MS: z.coerce.number().default(2000),
  /** Consecutive "not found" results before a source is treated as discontinued. */
  DISCONTINUE_AFTER_MISSES: z.coerce.number().int().min(1).default(2),
  /** Pages larger than this are flagged as failed rather than silently truncated. */
  MAX_PAGE_CHARS: z.coerce.number().default(150000),
  MIN_PAGE_CHARS: z.coerce.number().default(400),
  /** Use Claude's web_fetch tool when a direct fetch is blocked (bot walls, JS-only pages). */
  USE_CLAUDE_WEB_FETCH_FALLBACK: bool.default(true),

  RESEARCH_MODEL: z.string().default("claude-opus-5-5"),
  RESEARCH_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  BRIEFING_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),

  /** Spending limits (USD, at Anthropic list prices). */
  MAX_USD_PER_REFRESH: z.coerce.number().nonnegative().default(20),
  MAX_USD_PER_MONTH: z.coerce.number().nonnegative().default(50),
  MAX_USD_PER_QUESTION: z.coerce.number().nonnegative().default(1),
  MAX_SOURCES_PER_REFRESH: z.coerce.number().int().positive().default(150),
  MAX_DISCOVERY_SEARCHES_PER_PLATFORM: z.coerce.number().int().nonnegative().default(8),
  MAX_NEW_SOURCES_PER_REFRESH: z.coerce.number().int().nonnegative().default(40),

  /** Between refreshes: re-verify a cited source live if it was last verified longer ago than this. */
  LIVE_CHECK_FRESH_HOURS: z.coerce.number().nonnegative().default(24),
  LIVE_CHECK_MAX_SOURCES: z.coerce.number().int().nonnegative().default(3),

  USER_AGENT: z
    .string()
    .default("BilanKnowledgeBot/0.1 (+advertising policy monitor for Creative Academy)"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}

/** Config for tests / scripts that want defaults with a few overrides. */
export function testConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return loadConfig({
    DATABASE_URL: "postgres://unused",
    ADMIN_TOKEN: "test-admin-token-0123456789",
    ...overrides,
  } as NodeJS.ProcessEnv);
}
