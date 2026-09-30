import type pg from "pg";
import type { Config } from "../config.js";
import { withTransaction, type Db } from "../db/pool.js";
import {
  activeSources,
  addSource,
  currentEntries,
  getSource,
  promoteSource,
  PromotionConflict,
  resultOf,
  type PromotedChange,
  type SourceRow,
  type Staged,
} from "../kb/store.js";
import { runLog, type RunLog } from "../log.js";
import { Budget, BudgetExceededError } from "../research/budget.js";
import { hasVectorColumn, type Embedder } from "../research/embeddings.js";
import type { BriefingChangeInput, BriefingOutput, ResearchModel } from "../research/model.js";
import { DISCOVERY_TOPICS, PLATFORM_LABEL, PLATFORMS, type Platform } from "../research/sources.js";
import { getSettings, type Settings } from "../settings.js";
import { retrieveOnce } from "./retrieve.js";
import { setStage, type RunRow, type RunStatus } from "./runs.js";
import { stageRetrieved, tag } from "./stage.js";

export interface RunnerDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel;
  embedder: Embedder | null;
  /** True on the deployed (production) worker. Only then are activation checks recorded. */
  deployed: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
}

interface RunSourceRow {
  source_id: number;
  result: string;
  attempts: number;
  next_attempt_at: Date | null;
  failure_reason: string | null;
  note: string | null;
  staged_source_version: Staged | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const VERIFIED = ["unchanged", "cosmetic", "changed", "new", "discontinued"];

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export async function executeRun(deps: RunnerDeps, run: RunRow): Promise<RunStatus> {
  const { db, cfg, model } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = runLog(db, run.id);
  const started = Date.now();
  const alive = setInterval(() => db.query("UPDATE refresh_runs SET last_activity_at = now() WHERE id = $1", [run.id]).catch(() => {}), 60_000);

  try {
    const settings = await getSettings(db);
    const firstIndex = !(await db.query("SELECT 1 FROM refresh_runs WHERE status = 'complete' AND trigger <> 'live_check' LIMIT 1")).rowCount;
    const budget = new Budget(db, run.id, { kind: "run", capUsd: Number(run.budget_usd), onLimit: settings.on_limit });
    const problems: string[] = [];
    let incompleteReason: string | null = null;
    let budgetStopped = false;

    await log.info("lock", `Acquired refresh lock for job ${run.code}. No other refresh running.`);
    await log.info("budget", `Research budget ${money(Number(run.budget_usd))}. Spent $0.00.`);

    // 1. Discover new, moved or removed pages on official domains.
    await setStage(db, run.id, "discover");
    const tracked = await activeSources(db);
    await log.info("discover", `Checking official indexes for new and removed pages. ${tracked.length} tracked sources.`);
    let added = 0;
    for (const platform of PLATFORMS) {
      if (cfg.MAX_DISCOVERY_SEARCHES_PER_PLATFORM <= 0) break;
      try {
        const known = (await db.query<{ url: string }>("SELECT url FROM sources WHERE platform = $1", [platform])).rows.map((r) => r.url);
        const pages = await model.discover(platform, DISCOVERY_TOPICS[platform], known, cfg.MAX_DISCOVERY_SEARCHES_PER_PLATFORM, budget);
        let n = 0;
        for (const p of pages) {
          if (added >= cfg.MAX_NEW_SOURCES_PER_REFRESH) break;
          if (await addSource(db, p.url, { title: p.title, sourceType: p.source_type, origin: "discovered", platform })) {
            n++;
            added++;
          }
        }
        await log.info("discover", `[${platform === "meta" ? "META" : "TIKTOK"}] ${pages.length} candidate pages on official domains; ${n} new sources added`);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetStopped = true;
          await log.error("discover", err.message);
          break;
        }
        problems.push(`Discovery (${PLATFORM_LABEL[platform]}) failed: ${(err as Error).message}`);
        incompleteReason ??= "discovery_failed";
        await log.error("discover", `Discovery for ${PLATFORM_LABEL[platform]} failed: ${(err as Error).message}`);
      }
    }

    // 2–3. Fetch and compare every active source, with retries and backoff.
    await db.query(
      `INSERT INTO run_sources (run_id, source_id) SELECT $1, id FROM sources WHERE status = 'active' ON CONFLICT DO NOTHING`,
      [run.id],
    );
    await setStage(db, run.id, "fetch");
    await updateCounts(db, run.id);
    const backoffMs = (attempt: number) =>
      (settings.backoff_minutes[Math.min(attempt - 1, settings.backoff_minutes.length - 1)] ?? 30) * 60_000 * cfg.BACKOFF_SCALE;
    const campaignProfile = settings.campaign_profile;

    const processOne = async (rs: RunSourceRow) => {
      const source = await getSource(db, rs.source_id);
      if (!source) return;
      const attempt = rs.attempts + 1;
      budget.setInSource(true);
      try {
        const fetched = await retrieveOnce({ cfg, model, fetchImpl: deps.fetchImpl }, source, budget);
        if (fetched.kind === "failed") {
          await attemptFailed(rs, source, attempt, fetched.reason, fetched.httpStatus);
          return;
        }
        const { staged, followLinks } = await stageRetrieved({ db, model, embedder: deps.embedder, campaignProfile, log }, source, fetched, budget);
        const result = resultOf(staged);
        const note = attempt > 1 ? `Succeeded on retry ${attempt}` : result === "cosmetic" ? "Wording changes only" : null;
        const httpStatus = fetched.kind === "ok" ? fetched.httpStatus : fetched.httpStatus;
        await db.query(
          `UPDATE run_sources SET result = $3, attempts = $4, staged_source_version = $5, fetched_via = $6, http_status = $7,
             note = $8, failure_reason = NULL, next_attempt_at = NULL, checked_at = now() WHERE run_id = $1 AND source_id = $2`,
          [run.id, source.id, result, attempt, JSON.stringify(staged), fetched.kind === "ok" ? fetched.via : "direct", httpStatus, note],
        );
        const what = { unchanged: "no change", cosmetic: "wording changes only", changed: "content changed", new: "new page indexed", discontinued: `page discontinued (${fetched.kind === "discontinued" ? fetched.reason : ""})` }[result];
        const retryNote = attempt > 1 ? ` (attempt ${attempt}/${settings.retries})` : "";
        await log.info("fetch", `${tag(source)} → ${httpStatus} · ${what}${retryNote}`, { src: 1 });
        // New sources found on hub pages or via redirects are checked in this run too.
        const extra = [...followLinks];
        if (staged.kind === "discontinued" && staged.replacementSourceId) {
          await db.query("INSERT INTO run_sources (run_id, source_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [run.id, staged.replacementSourceId]);
        }
        for (const link of extra) {
          if (added >= cfg.MAX_NEW_SOURCES_PER_REFRESH) break;
          const id = await addSource(db, link, { origin: "discovered", platform: source.platform });
          if (id) {
            added++;
            await db.query("INSERT INTO run_sources (run_id, source_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [run.id, id]);
          }
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetStopped = true;
          await db.query(
            `UPDATE run_sources SET result = 'skipped', attempts = $3, failure_reason = 'Budget limit reached', checked_at = now()
             WHERE run_id = $1 AND source_id = $2`,
            [run.id, source.id, attempt],
          );
          await log.error("budget", `${err.message}. Stopping: remaining sources are not verified.`);
          return;
        }
        await attemptFailed(rs, source, attempt, `Processing error: ${(err as Error).message}`, null);
      } finally {
        budget.setInSource(false);
        if (budget.limitReached) budgetStopped = true;
        await updateCounts(db, run.id);
      }
    };

    const attemptFailed = async (rs: RunSourceRow, source: SourceRow, attempt: number, reason: string, httpStatus: number | null) => {
      if (attempt < settings.retries) {
        const wait = backoffMs(attempt);
        await db.query(
          `UPDATE run_sources SET attempts = $3, next_attempt_at = now() + make_interval(secs => $4), failure_reason = $5, http_status = $6
           WHERE run_id = $1 AND source_id = $2`,
          [run.id, source.id, attempt, wait / 1000, reason, httpStatus],
        );
        await log.warn("fetch", `${tag(source)} → ${reason} (attempt ${attempt}/${settings.retries}) · retrying in ${Math.max(1, Math.round(wait / 60000))} min`);
      } else {
        await db.query(
          `UPDATE run_sources SET result = 'failed', attempts = $3, failure_reason = $4, http_status = $5, next_attempt_at = NULL, checked_at = now()
           WHERE run_id = $1 AND source_id = $2`,
          [run.id, source.id, attempt, `${reason} after ${attempt} attempts`, httpStatus],
        );
        await log.error("fetch", `${tag(source)} → ${reason} (attempt ${attempt}/${settings.retries}) · not verified, keeping last verified version`, { src: 1 });
      }
      void rs;
    };

    for (;;) {
      if (budgetStopped) {
        await db.query(
          `UPDATE run_sources SET result = 'skipped', failure_reason = COALESCE(failure_reason || '; ', '') || 'Budget limit reached', checked_at = now()
           WHERE run_id = $1 AND result = 'pending'`,
          [run.id],
        );
        incompleteReason = "budget_limit";
        break;
      }
      const { rows: pending } = await db.query<RunSourceRow>(
        `SELECT source_id, result, attempts, next_attempt_at, failure_reason, note, staged_source_version
         FROM run_sources WHERE run_id = $1 AND result = 'pending' ORDER BY next_attempt_at NULLS FIRST, source_id`,
        [run.id],
      );
      if (!pending.length) break;
      const now = Date.now();
      const ready = pending.filter((p) => !p.next_attempt_at || p.next_attempt_at.getTime() <= now);
      if (!ready.length) {
        const wait = Math.min(...pending.map((p) => p.next_attempt_at!.getTime() - now));
        await sleep(Math.max(5, Math.min(wait, 60_000)));
        continue;
      }
      let i = 0;
      const workers = Array.from({ length: deps.concurrency ?? 3 }, async () => {
        while (i < ready.length && !budgetStopped) await processOne(ready[i++]);
      });
      await Promise.all(workers);
    }

    const { rows: rsAll } = await db.query<RunSourceRow & { platform: Platform; title: string; url: string }>(
      `SELECT rs.source_id, rs.result, rs.attempts, rs.next_attempt_at, rs.failure_reason, rs.note, rs.staged_source_version,
              s.platform, s.title, s.url
       FROM run_sources rs JOIN sources s ON s.id = rs.source_id WHERE rs.run_id = $1 ORDER BY s.platform, s.id`,
      [run.id],
    );
    const failed = rsAll.filter((r) => !VERIFIED.includes(r.result));
    const verifiedCount = rsAll.length - failed.length;
    await setStage(db, run.id, "compare");
    const changedCount = rsAll.filter((r) => ["changed", "new", "discontinued"].includes(r.result)).length;
    await log.info("compare", changedCount ? `Compared ${changedCount} changed pages with stored versions` : "No content changes in verified sources");

    if (failed.length) {
      problems.unshift(...failed.map((f) => `${f.title} (${PLATFORM_LABEL[f.platform]}): ${f.failure_reason ?? f.result}`));
      incompleteReason ??= "sources_failed";
    }

    if (problems.length || budgetStopped) {
      return await finalizeIncomplete(deps, run, log, rsAll, failed, verifiedCount, incompleteReason ?? "sources_failed", problems, budget, started);
    }
    return await finalizeComplete(deps, run, log, rsAll, verifiedCount, firstIndex, settings, budget, started);
  } catch (err) {
    await log.error("done", `Refresh failed: ${(err as Error).message}`);
    await db.query(
      `UPDATE refresh_runs SET status = 'failed', stage = 'done', finished_at = now(), error = $2 WHERE id = $1`,
      [run.id, `${(err as Error).message}. Nothing was promoted; last verified versions remain in use.`],
    );
    return "failed";
  } finally {
    clearInterval(alive);
  }
}

async function updateCounts(db: Db, runId: number) {
  await db.query(
    `UPDATE refresh_runs r SET
       sources_total = (SELECT count(*) FROM run_sources WHERE run_id = r.id),
       sources_verified = (SELECT count(*) FROM run_sources WHERE run_id = r.id AND result IN ('unchanged','cosmetic','changed','new','discontinued')),
       sources_failed = (SELECT count(*) FROM run_sources WHERE run_id = r.id AND result IN ('failed','skipped')),
       last_activity_at = now()
     WHERE id = $1`,
    [runId],
  );
}

type RsRow = RunSourceRow & { platform: Platform; title: string; url: string };

/** Change list for the briefing, derived from staged results (before promotion). */
async function stagedChanges(db: Db, rows: RsRow[]): Promise<BriefingChangeInput[]> {
  const out: BriefingChangeInput[] = [];
  for (const r of rows) {
    const s = r.staged_source_version;
    if (!s || s.kind === "unchanged") continue;
    const stored = await currentEntries(db, r.source_id);
    if (s.kind === "discontinued") {
      for (const e of stored) {
        out.push({ ref: `${r.platform}:${e.slug}`, platform: r.platform, kind: "Archived", title: e.title, what_changed: s.reason, summary: e.summary, relevance: e.relevance, limitations: e.limitations, source_url: r.url });
      }
      continue;
    }
    const storedSlugs = new Set(stored.map((e) => e.slug));
    for (const e of s.extraction.entries) {
      const isNew = !storedSlugs.has(e.slug);
      if (!isNew && e.classification !== "changed") continue;
      out.push({ ref: `${r.platform}:${e.slug}`, platform: r.platform, kind: isNew ? "New" : "Changed", title: e.title, what_changed: e.what_changed, summary: e.summary, relevance: e.relevance, limitations: e.limitations, source_url: r.url });
    }
    for (const rm of s.extraction.removed) {
      const e = stored.find((x) => x.slug === rm.slug);
      if (e) out.push({ ref: `${r.platform}:${e.slug}`, platform: r.platform, kind: "Archived", title: e.title, what_changed: rm.reason, summary: e.summary, relevance: e.relevance, limitations: e.limitations, source_url: r.url });
    }
  }
  return out;
}

async function finalizeComplete(
  deps: RunnerDeps,
  run: RunRow,
  log: RunLog,
  rows: RsRow[],
  verifiedCount: number,
  firstIndex: boolean,
  settings: Settings,
  budget: Budget,
  started: number,
): Promise<RunStatus> {
  const { db, model } = deps;
  const changes = await stagedChanges(db, rows);
  const newVersions = rows.reduce((n, r) => {
    const s = r.staged_source_version;
    return n + (s?.kind === "content" ? s.extraction.entries.filter((e) => e.classification === "new" || e.classification === "changed").length : 0);
  }, 0);
  const embedded = rows.reduce((n, r) => n + (r.staged_source_version?.kind === "content" ? Object.keys(r.staged_source_version.embeddings ?? {}).length : 0), 0);

  await setStage(db, run.id, "index");
  await log.info("index", firstIndex ? `Prepared ${newVersions} entries · embedded ${embedded}` : newVersions ? `Prepared ${newVersions} new entry versions · embedded ${embedded}` : `Verification dates will update for ${verifiedCount} sources`);
  await setStage(db, run.id, "archive");
  const archivedCount = changes.filter((c) => c.kind === "Archived").length + changes.filter((c) => c.kind === "Changed").length;
  await log.info("archive", archivedCount ? `${archivedCount} superseded or removed entries will be archived. Kept in version history, excluded from current advice.` : "Nothing to archive");

  // Briefing is generated before anything is promoted, so a failure here leaves current guidance untouched.
  await setStage(db, run.id, "brief");
  let briefing: BriefingOutput;
  const platformsCount = (p: Platform) => rows.filter((r) => r.platform === p && VERIFIED.includes(r.result)).length;
  if (firstIndex) {
    const entryCount = (p: Platform) =>
      rows.filter((r) => r.platform === p).reduce((n, r) => n + (r.staged_source_version?.kind === "content" ? r.staged_source_version.extraction.entries.length : 0), 0);
    briefing = {
      summary: `Initial index of ${verifiedCount} official sources: ${platformsCount("meta")} Meta and ${platformsCount("tiktok")} TikTok, stored as ${entryCount("meta") + entryCount("tiktok")} entries (Meta ${entryCount("meta")}, TikTok ${entryCount("tiktok")}). Meta and TikTok guidance are kept in separate collections.`,
      sections: [],
      recommendations: [],
    };
  } else if (!changes.length) {
    briefing = { summary: `No changes found. All ${verifiedCount} official sources verified.`, sections: [], recommendations: [] };
  } else {
    try {
      briefing = await model.brief({ runCode: run.code, sourcesVerified: verifiedCount, changes, campaignProfile: settings.campaign_profile }, budget);
    } catch (err) {
      await log.error("brief", `Briefing could not be generated: ${(err as Error).message}`);
      return finalizeIncomplete(deps, run, log, rows, [], verifiedCount, err instanceof BudgetExceededError ? "budget_limit" : "briefing_failed", [`Briefing could not be generated: ${(err as Error).message}`], budget, started);
    }
  }

  await setStage(db, run.id, "verify");
  const vectors = await hasVectorColumn(db);
  const retried = rows.filter((r) => r.note?.startsWith("Succeeded on retry"));
  const note =
    `All ${verifiedCount} sources verified.` +
    (retried.length ? ` ${retried.map((r) => `${r.title} succeeded on retry ${r.attempts}`).join("; ")}.` : "") +
    (firstIndex ? " Initial index stored." : " Briefing saved.");

  let promoted: PromotedChange[] = [];
  try {
    await withTransaction(db, async (c: pg.PoolClient) => {
      for (const r of rows) {
        const staged = r.staged_source_version;
        if (!staged) continue;
        const source = await getSource(c, r.source_id);
        if (!source) continue;
        const changed = await promoteSource(c, { runId: run.id, runCode: run.code, origin: "refresh", vectors }, source, staged);
        promoted.push(...changed);
      }
      if (firstIndex) {
        // The first index is the baseline, not a list of changes.
        await c.query("DELETE FROM changes WHERE run_id = $1", [run.id]);
        promoted = [];
      }
      const refToEntry = new Map(promoted.map((p) => [p.ref, p.entryId]));
      const body = {
        sections: briefing.sections.map((s) => ({
          platform: s.platform,
          items: s.items.map((it) => ({ ...it, entry_id: refToEntry.get(it.ref) ?? null })),
        })),
        unverified: [],
      };
      const { rows: b } = await c.query<{ id: number }>(
        "INSERT INTO briefings (run_id, partial, summary, body) VALUES ($1, false, $2, $3) RETURNING id",
        [run.id, briefing.summary, JSON.stringify(body)],
      );
      for (const rec of briefing.recommendations) {
        await c.query("INSERT INTO recommendations (briefing_id, text) VALUES ($1, $2)", [b[0].id, rec]);
      }
      await c.query(
        `UPDATE refresh_runs SET status = 'complete', stage = 'done', finished_at = now(), note = $2, error = NULL WHERE id = $1`,
        [run.id, note],
      );
      await c.query("UPDATE system_status SET last_success_run = $1, last_success_at = now() WHERE id = 1", [run.id]);
      if (run.trigger === "scheduled" && deps.deployed) {
        await c.query("UPDATE system_status SET schedule_verified_at = COALESCE(schedule_verified_at, now()) WHERE id = 1");
      }
    });
  } catch (err) {
    if (err instanceof PromotionConflict) {
      return finalizeIncomplete(deps, run, log, rows, [], verifiedCount, "conflict", [err.message], budget, started);
    }
    throw err;
  }

  // Storage check: re-read what was committed.
  const expected = rows.filter((r) => r.staged_source_version?.kind === "content");
  const { rows: check } = await db.query<{ ok: number }>(
    `SELECT count(*)::int AS ok FROM sources s JOIN source_versions v ON v.id = s.current_version_id
     WHERE s.id = ANY($1::bigint[]) AND v.content_hash = ANY($2::text[])`,
    [expected.map((r) => r.source_id), expected.map((r) => (r.staged_source_version as Extract<Staged, { kind: "content" }>).hash)],
  );
  const { rowCount: hasBriefing } = await db.query("SELECT 1 FROM briefings WHERE run_id = $1", [run.id]);
  if (check[0].ok !== expected.length || !hasBriefing) {
    const msg = `Storage check failed: ${check[0].ok}/${expected.length} new versions found, briefing ${hasBriefing ? "present" : "missing"}`;
    await log.error("verify", msg);
    await db.query("UPDATE refresh_runs SET status = 'failed', error = $2 WHERE id = $1", [run.id, msg]);
    await db.query("UPDATE system_status SET last_success_run = NULL, last_success_at = (SELECT max(finished_at) FROM refresh_runs WHERE status = 'complete' AND trigger <> 'live_check') WHERE id = 1");
    return "failed";
  }
  await log.info("verify", `Storage check: ${verifiedCount} sources, versions and briefing committed`);
  await log.info("done", `Refresh complete · ${verifiedCount}/${rows.length} verified · ${money(budget.spentUsd)} · ${duration(Date.now() - started)}`);
  return "complete";
}

async function finalizeIncomplete(
  deps: RunnerDeps,
  run: RunRow,
  log: RunLog,
  rows: RsRow[],
  failed: RsRow[],
  verifiedCount: number,
  reason: string,
  problems: string[],
  budget: Budget,
  started: number,
): Promise<RunStatus> {
  const { db } = deps;
  const pending = await stagedChanges(db, rows.filter((r) => VERIFIED.includes(r.result)));
  const names = failed.map((f) => `${PLATFORM_LABEL[f.platform]} ${f.title}`);
  const note =
    `${verifiedCount} of ${rows.length} sources verified.` +
    (names.length ? ` ${names.slice(0, 3).join(" and ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} could not be verified.` : "") +
    (reason === "budget_limit" ? " The research budget was reached." : "") +
    (reason === "discovery_failed" ? " Discovery of new pages did not complete." : "") +
    (reason === "briefing_failed" ? " The briefing could not be generated." : "") +
    (reason === "conflict" ? " A source changed during the run." : "") +
    " The run was not marked successful and no current guidance was replaced.";
  const summary = pending.length
    ? `Incomplete run. ${pending.length} change${pending.length === 1 ? " was" : "s were"} found in verified sources but not applied, because the run did not complete. Sources that failed keep their last verified versions.`
    : `Incomplete run. No changes found in the ${verifiedCount} sources that were verified. Sources that failed are listed below and keep their last verified versions.`;
  const body = {
    sections: [],
    pending: pending.map((c) => ({ platform: c.platform, kind: c.kind, title: c.title, what: c.what_changed })),
    unverified: failed.map((f) => ({ platform: f.platform, title: f.title, url: f.url, reason: f.failure_reason ?? f.result })),
  };

  await withTransaction(db, async (c) => {
    await c.query(
      "INSERT INTO briefings (run_id, partial, summary, body) VALUES ($1, true, $2, $3) ON CONFLICT (run_id) DO NOTHING",
      [run.id, summary, JSON.stringify(body)],
    );
    await c.query(
      `UPDATE refresh_runs SET status = 'incomplete', stage = 'done', finished_at = now(), incomplete_reason = $2, note = $3, error = $4 WHERE id = $1`,
      [run.id, reason, note, problems.slice(0, 10).join("\n")],
    );
    // Escalate sources that fail in consecutive runs so they can be fixed or paused.
    for (const f of failed) {
      await c.query(
        `UPDATE sources SET consecutive_failures = consecutive_failures + 1,
           escalated_at = CASE WHEN consecutive_failures + 1 >= 3 THEN COALESCE(escalated_at, now()) ELSE escalated_at END
         WHERE id = $1`,
        [f.source_id],
      );
    }
    const reached = rows.filter((r) => VERIFIED.includes(r.result)).map((r) => r.source_id);
    if (reached.length) await c.query("UPDATE sources SET consecutive_failures = 0, escalated_at = NULL WHERE id = ANY($1::bigint[])", [reached]);
    if (deps.deployed) await c.query("UPDATE system_status SET failure_path_verified_at = COALESCE(failure_path_verified_at, now()) WHERE id = 1");
  });
  await log.info("brief", "Partial briefing saved and marked incomplete");
  await log.error(
    "done",
    `Refresh incomplete${reason === "budget_limit" ? " (budget_limit)" : ""} · ${verifiedCount}/${rows.length} verified · ${money(budget.spentUsd)} · not marked successful · ${duration(Date.now() - started)}`,
  );
  return "incomplete";
}
