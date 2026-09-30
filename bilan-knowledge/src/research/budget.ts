import type { DbClient } from "../db/pool.js";

/** USD per million tokens at Anthropic list prices (checked 30 Sep 2026; see docs/COSTS.md). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
export const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches
export const VOYAGE_USD_PER_MTOK = 0.02; // voyage-4-lite list price (first 200M tokens free; recorded at list price)
export const FIRECRAWL_USD_PER_CREDIT = 19 / 5000; // Hobby plan

export function priceFor(model: string) {
  // Unknown models are priced at the most expensive tier so limits stay conservative.
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

export type BudgetScope =
  /** One refresh: cap is refresh_runs.budget_usd. */
  | { kind: "run"; capUsd: number; onLimit: "stop" | "finish" }
  /** Live checks share a monthly cap (settings.budget_live_month_usd). */
  | { kind: "live_month"; capUsd: number }
  /** Answer generation for /api/ask. */
  | { kind: "answer"; capUsd: number };

/**
 * Every paid call is estimated (worst case) before it runs and written to the
 * ledger after. With on_limit="finish", the source being processed may finish
 * past the cap; the run then stops. With "stop", the call is refused.
 */
export class Budget {
  private spent = 0;
  /** Sources currently being processed (the runner works on several concurrently). */
  private inFlight = 0;
  /** Set when the cap was reached; the runner stops and marks the run incomplete (budget_limit). */
  limitReached = false;

  constructor(
    private db: DbClient,
    private runId: number | null,
    readonly scope: BudgetScope,
  ) {}

  get spentUsd(): number {
    return this.spent;
  }

  /** Marks the start/end of work on one source (for on_limit="finish"). */
  setInSource(v: boolean) {
    this.inFlight = Math.max(0, this.inFlight + (v ? 1 : -1));
  }

  async liveMonthSpent(): Promise<number> {
    const { rows } = await this.db.query<{ total: number | null }>(
      `SELECT sum(l.usd) AS total FROM budget_ledger l JOIN refresh_runs r ON r.id = l.run_id
       WHERE r.trigger = 'live_check' AND l.at >= date_trunc('month', now())`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  async assertCanSpend(estimateUsd: number, what: string): Promise<void> {
    const { scope } = this;
    if (scope.kind === "live_month") {
      const month = await this.liveMonthSpent();
      if (month + estimateUsd > scope.capUsd) {
        this.limitReached = true;
        throw new BudgetExceededError(
          `Live-check budget reached: $${month.toFixed(2)} of $${scope.capUsd.toFixed(2)} used this month`,
        );
      }
      return;
    }
    if (this.spent + estimateUsd <= scope.capUsd) return;
    this.limitReached = true;
    // on_limit="finish": sources already in progress may finish; no new source starts.
    if (scope.kind === "run" && scope.onLimit === "finish" && this.inFlight > 0) return;
    throw new BudgetExceededError(
      `Budget limit: ${what} could cost up to $${estimateUsd.toFixed(2)}; ` +
        `$${this.spent.toFixed(2)} of $${scope.capUsd.toFixed(2)} already used`,
    );
  }

  /** Worst-case estimate: input chars/3 tokens + full output allowance + searches (~8k tokens each). */
  estimate(model: string, inputChars: number, maxOutputTokens: number, maxSearches = 0): number {
    const p = priceFor(model);
    const inputTokens = Math.ceil(inputChars / 3) + maxSearches * 8000;
    return (inputTokens * p.input + maxOutputTokens * p.output) / 1_000_000 + maxSearches * WEB_SEARCH_USD;
  }

  async recordAnthropic(purpose: string, model: string, usage: UsageLike): Promise<number> {
    const usd = costOf(model, usage);
    await this.write("anthropic", purpose, model, usage.input_tokens + usage.output_tokens, usage.server_tool_use?.web_search_requests ?? 0, usd);
    return usd;
  }

  async recordOther(provider: "voyage" | "firecrawl", purpose: string, units: number, usd: number): Promise<void> {
    await this.write(provider, purpose, null, units, 0, usd);
  }

  private async write(provider: string, purpose: string, model: string | null, units: number, searches: number, usd: number) {
    this.spent += usd;
    await this.db.query(
      `INSERT INTO budget_ledger (run_id, provider, purpose, model, units, web_searches, usd) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [this.runId, provider, purpose, model, units, searches, usd],
    );
    if (this.runId !== null) {
      await this.db.query("UPDATE refresh_runs SET spend_usd = spend_usd + $2 WHERE id = $1", [this.runId, usd]);
    }
  }
}
