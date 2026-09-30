import type { Config } from "../config.js";
import { withTransaction, type Db } from "../db/pool.js";
import { runLog } from "../log.js";
import { Budget, BudgetExceededError } from "../research/budget.js";
import { hasVectorColumn, type Embedder } from "../research/embeddings.js";
import type { ResearchModel } from "../research/model.js";
import { PLATFORM_LABEL } from "../research/sources.js";
import { retrieveOnce } from "../refresh/retrieve.js";
import { createLiveCheckRun } from "../refresh/runs.js";
import { stageRetrieved, tag } from "../refresh/stage.js";
import { getSettings } from "../settings.js";
import { getSource, promoteSource, resultOf } from "./store.js";

export interface LiveCheckDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel;
  embedder: Embedder | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface LiveCheckResult {
  runCode: string;
  sourceId: number;
  url: string;
  outcome: "verified" | "changed" | "discontinued" | "failed";
  label: string;
  error?: string;
  storedVerifiedAt: Date | null;
}

/**
 * kb.verify_live(source_id): fetch and hash the page now. If it changed, run the
 * same extract → compare → promote steps for this one source and record an LC-xxx
 * run. A failed fetch is reported as "not verified", never as current.
 */
export async function verifyLive(
  deps: LiveCheckDeps,
  sourceId: number,
  opts: { question?: string | null; requestedBy: string; retrievedNote?: string },
): Promise<LiveCheckResult> {
  const { db, cfg, model } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const settings = await getSettings(db);
  const source = await getSource(db, sourceId);
  if (!source) throw new Error(`source ${sourceId} not found`);
  const run = await createLiveCheckRun(db, Number(settings.budget_live_month_usd), opts.question ?? null, opts.requestedBy);
  const log = runLog(db, run.id);
  const budget = new Budget(db, run.id, { kind: "live_month", capUsd: Number(settings.budget_live_month_usd) });
  const base = { runCode: run.code, sourceId, url: source.url, storedVerifiedAt: source.current_verified_at };
  await db.query("INSERT INTO run_sources (run_id, source_id) VALUES ($1,$2)", [run.id, sourceId]);

  const finish = async (status: "complete" | "incomplete", label: string, note: string, result: string, error: string | null) => {
    await db.query(
      `UPDATE refresh_runs SET status = $2, result_label = $3, note = $4, error = $5, stage = 'done', finished_at = now(),
         sources_verified = $6, sources_failed = $7 WHERE id = $1`,
      [run.id, status, label, note, error, status === "complete" ? 1 : 0, status === "complete" ? 0 : 1],
    );
    await db.query("UPDATE run_sources SET result = $3, failure_reason = $4, checked_at = now() WHERE run_id = $1 AND source_id = $2", [run.id, sourceId, result, error]);
  };

  try {
    if (opts.question) await log.info("live", `Question: "${opts.question}"`);
    if (opts.retrievedNote) await log.info("retrieve", opts.retrievedNote);
    let fetched = null;
    let lastReason = "";
    for (let attempt = 1; attempt <= settings.retries; attempt++) {
      const r = await retrieveOnce({ cfg, model, fetchImpl: deps.fetchImpl }, source, budget);
      if (r.kind !== "failed") {
        fetched = r;
        break;
      }
      lastReason = r.reason;
      await log.warn("fetch", `${tag(source)} → ${r.reason} (attempt ${attempt}/${settings.retries})${attempt < settings.retries ? " · retrying" : ""}`);
      if (attempt < settings.retries) await sleep(1000 * attempt * cfg.BACKOFF_SCALE);
    }
    if (!fetched) {
      const error = `${lastReason} after ${settings.retries} attempts`;
      await log.error("done", `Not verified · stored version dated ${source.current_verified_at?.toISOString().slice(0, 10) ?? "never"} remains in use`);
      await finish("incomplete", "Not verified", `The ${PLATFORM_LABEL[source.platform]} source could not be re-verified: ${error}. The last verified version remains in use.`, "failed", error);
      return { ...base, outcome: "failed", label: "Not verified", error };
    }

    const settingsProfile = settings.campaign_profile;
    const { staged } = await stageRetrieved({ db, model, embedder: deps.embedder, campaignProfile: settingsProfile, log }, source, fetched, budget);
    const result = resultOf(staged);
    await log.info("fetch", `${tag(source)} → ${fetched.kind === "ok" ? fetched.httpStatus : fetched.httpStatus} · ${result === "unchanged" || result === "cosmetic" ? "matches stored version" : "content changed"}`);
    const vectors = await hasVectorColumn(db);
    const promoted = await withTransaction(db, (c) => promoteSource(c, { runId: run.id, runCode: run.code, origin: "live_check", vectors }, source, staged));
    await db.query("UPDATE run_sources SET staged_source_version = $3, fetched_via = $4 WHERE run_id = $1 AND source_id = $2", [
      run.id, sourceId, JSON.stringify(staged), fetched.kind === "ok" ? fetched.via : "direct",
    ]);

    const prefix = opts.question ? `Question in chat triggered a check of ${PLATFORM_LABEL[source.platform]} ${source.title}. ` : `Live check of ${PLATFORM_LABEL[source.platform]} ${source.title}. `;
    if (result === "discontinued") {
      await log.info("done", "Source discontinued · entries archived");
      await finish("complete", "Source discontinued", `${prefix}The page has been discontinued; its entries were archived.`, result, null);
      return { ...base, outcome: "discontinued", label: "Source discontinued" };
    }
    if (promoted.length) {
      const label = `Saved ${promoted.length} change${promoted.length === 1 ? "" : "s"}`;
      await log.info("compare", `Diff confirmed against stored version. ${label}; superseded versions archived.`);
      await log.info("done", `${label} · $${budget.spentUsd.toFixed(2)}`);
      await finish("complete", label, `${prefix}The page had changed since it was last verified. ${label} as new versions; previous versions archived.`, result, null);
      return { ...base, outcome: "changed", label };
    }
    await log.info("done", `Verified current · $${budget.spentUsd.toFixed(2)}`);
    await finish("complete", "Verified current", `${prefix}Saved entries matched the live source. Verification date updated.`, result === "cosmetic" ? "cosmetic" : "unchanged", null);
    return { ...base, outcome: "verified", label: "Verified current" };
  } catch (err) {
    const error = err instanceof BudgetExceededError ? err.message : `Live check failed: ${(err as Error).message}`;
    await log.error("done", error);
    await finish("incomplete", "Not verified", `${error}. The last verified version remains in use.`, "failed", error);
    return { ...base, outcome: "failed", label: "Not verified", error };
  }
}
