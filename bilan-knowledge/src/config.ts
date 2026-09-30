import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

/**
 * Infrastructure and secrets come from the environment. Operational settings that
 * Sabah can change (run window, retries, budgets, alert email, campaign profile)
 * live in the `settings` table and are edited in the Settings tab.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters"),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  /** "all" runs API + worker in one process; or run "web" and "worker" separately. */
  PROCESS_ROLE: z.enum(["all", "web", "worker"]).default("all"),
  /** Set to "production" on the deployed backend. Only a production worker can mark the schedule as verified. */
  DEPLOYMENT_ENV: z.string().default("development"),

  // Research service (Claude API: extraction, comparison, discovery, briefing).
  ANTHROPIC_API_KEY: z.string().optional(),
  RESEARCH_MODEL: z.string().default("claude-sonnet-5-5"),
  RESEARCH_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  BRIEFING_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  MAX_DISCOVERY_SEARCHES_PER_PLATFORM: z.coerce.number().int().nonnegative().default(15),
  MAX_NEW_SOURCES_PER_REFRESH: z.coerce.number().int().nonnegative().default(20),
  /** Use Claude's web_fetch tool as a last resort when direct and rendered fetches fail. */
  USE_CLAUDE_WEB_FETCH_FALLBACK: bool.default(true),

  // Optional services.
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("voyage-4-lite"),
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_API_URL: z.string().default("https://api.firecrawl.dev/v2/scrape"),
  RESEND_API_KEY: z.string().optional(),
  ALERT_FROM_EMAIL: z.string().default("Bilan <alerts@example.com>"),
  APP_URL: z.string().default(""),

  // Worker.
  WORKER_POLL_SECONDS: z.coerce.number().min(1).default(20),
  TICK_MINUTES: z.coerce.number().min(1).default(15),
  FETCH_TIMEOUT_MS: z.coerce.number().default(30000),
  MIN_PAGE_CHARS: z.coerce.number().default(300),
  MAX_PAGE_CHARS: z.coerce.number().default(200000),
  /** Multiplier for retry backoff (settings.backoff_minutes). Tests use a tiny value. */
  BACKOFF_SCALE: z.coerce.number().positive().default(1),
  /** Per-question cap for /api/ask answer generation (live checks use the monthly live-check budget). */
  MAX_USD_PER_ANSWER: z.coerce.number().nonnegative().default(0.5),
  USER_AGENT: z.string().default("BilanKnowledgeBot/1.0 (+official advertising guidance monitor for Creative Academy)"),
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

export function testConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return loadConfig({
    DATABASE_URL: "postgres://unused",
    ADMIN_TOKEN: "test-admin-token-0123456789",
    ...overrides,
  } as NodeJS.ProcessEnv);
}
