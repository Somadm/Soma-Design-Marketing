import type { DbClient } from "../db/pool.js";

/** USD per million tokens at Anthropic list prices (see docs/COSTS.md). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
/** Web search is billed per search: $10 per 1,000. */
export const WEB_SEARCH_USD = 0.01;

export function priceFor(model: string) {
  // Unknown model: assume the most expensive tier so limits stay conservative.
  return PRICES[model] ?? PRICES["claude-fable-5-1"];
}

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export function costOf(model: string, u: UsageLike): number {
  const p = priceFor(model);
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
      1_000_000 +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
  );
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetLimits {
  /** Limit for this unit of work (one refresh, or one question). */
  perJobUsd: number;
  perMonthUsd: number;
}

/**
 * Enforces configurable research spending limits. Every paid call is estimated
 * before it is made (worst case: full max_tokens output) and recorded after.
 */
export class Budget {
  private spent = 0;

  constructor(
    private db: DbClient,
    private runId: number | null,
    private limits: BudgetLimits,
  ) {}

  get spentUsd(): number {
    return this.spent;
  }

  async monthToDateUsd(): Promise<number> {
    const { rows } = await this.db.query<{ total: string | null }>(
      "SELECT sum(usd) AS total FROM spend_ledger WHERE created_at >= date_trunc('month', now())",
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** Throws BudgetExceededError if a call costing up to `estimateUsd` would breach a limit. */
  async assertCanSpend(estimateUsd: number, what: string): Promise<void> {
    if (this.spent + estimateUsd > this.limits.perJobUsd) {
      throw new BudgetExceededError(
        `Spending limit reached: ${what} could cost up to $${estimateUsd.toFixed(2)}, ` +
          `$${this.spent.toFixed(2)} of the $${this.limits.perJobUsd.toFixed(2)} per-job limit already used`,
      );
    }
    const month = await this.monthToDateUsd();
    if (month + estimateUsd > this.limits.perMonthUsd) {
      throw new BudgetExceededError(
        `Monthly spending limit reached: $${month.toFixed(2)} of $${this.limits.perMonthUsd.toFixed(2)} used this month`,
      );
    }
  }

  /** Worst-case estimate for a call: input chars/3 tokens + full output allowance + searches. */
  estimate(model: string, inputChars: number, maxOutputTokens: number, maxSearches = 0): number {
    const p = priceFor(model);
    const inputTokens = Math.ceil(inputChars / 3);
    // Searches pull result pages into context; allow ~8k input tokens per search.
    return (
      ((inputTokens + maxSearches * 8000) * p.input + maxOutputTokens * p.output) / 1_000_000 +
      maxSearches * WEB_SEARCH_USD
    );
  }

  async record(purpose: string, model: string, usage: UsageLike): Promise<number> {
    const usd = costOf(model, usage);
    this.spent += usd;
    await this.db.query(
      `INSERT INTO spend_ledger (run_id, purpose, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, web_searches, usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        this.runId,
        purpose,
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
        usage.server_tool_use?.web_search_requests ?? 0,
        usd,
      ],
    );
    if (this.runId !== null) {
      await this.db.query("UPDATE refresh_runs SET spend_usd = spend_usd + $2 WHERE id = $1", [this.runId, usd]);
    }
    return usd;
  }
}
