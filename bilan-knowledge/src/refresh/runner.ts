import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import {
  addSource,
  getCampaignProfile,
  getSource,
  listMonitoredSources,
  recordCheck,
  type SourceRow,
} from "../knowledge/store.js";
import { runLogger, type Logger } from "../log.js";
import { Budget, BudgetExceededError } from "../research/budget.js";
import type { BriefingChange, ResearchModel } from "../research/model.js";
import { DISCOVERY_TOPICS, PLATFORMS, type Platform } from "../research/sources.js";
import { checkSource, type CheckResult } from "./checkSource.js";
import { heartbeat, type RunRow, type RunStatus } from "./runs.js";

export interface RunnerDeps {
  db: Db;
  cfg: Config;
  model: ResearchModel;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
}

interface Tally {
  checked: number;
  unchanged: number;
  changed: number;
  new: number;
  discontinued: number;
  failed: number;
  itemsAdded: number;
  itemsArchived: number;
}

/**
 * Executes a claimed full refresh:
 *   discover → check every monitored source → store → briefing → final status.
 * The run is only marked "succeeded" if every step completed and was stored.
 */
export async function executeRun(deps: RunnerDeps, run: RunRow): Promise<RunStatus> {
  const { db, cfg, model } = deps;
  const log = runLogger(db, run.id);
  const budget = new Budget(db, run.id, { perJobUsd: cfg.MAX_USD_PER_REFRESH, perMonthUsd: cfg.MAX_USD_PER_MONTH });
  const problems: string[] = [];
  const tally: Tally = { checked: 0, unchanged: 0, changed: 0, new: 0, discontinued: 0, failed: 0, itemsAdded: 0, itemsArchived: 0 };
  const hb = setInterval(() => heartbeat(db, run.id).catch(() => {}), 30_000);

  try {
    await log.info(`Refresh #${run.id} started (${run.trigger})`);
    const campaignProfile = await getCampaignProfile(db);

    // 1. Discovery: look for new official guidance pages on each platform.
    let budgetStop = false;
    let newSources = 0;
    for (const platform of PLATFORMS) {
      if (cfg.MAX_DISCOVERY_SEARCHES_PER_PLATFORM <= 0) break;
      try {
        const known = (await db.query<{ url: string }>("SELECT url FROM sources WHERE platform = $1", [platform])).rows.map((r) => r.url);
        const pages = await model.discoverSources(platform, DISCOVERY_TOPICS[platform], known, cfg.MAX_DISCOVERY_SEARCHES_PER_PLATFORM, budget);
        let added = 0;
        for (const p of pages) {
          if (newSources >= cfg.MAX_NEW_SOURCES_PER_REFRESH) break;
          if (await addSource(db, p.url, { title: p.title, category: p.category, origin: "discovered", platform })) {
            added++;
            newSources++;
          }
        }
        await log.info(`Discovery (${platform}): ${pages.length} candidate page(s), ${added} new source(s) added`);
      } catch (err) {
        const msg = `Discovery for ${platform} failed: ${(err as Error).message}`;
        problems.push(msg);
        await log.error(msg);
        if (err instanceof BudgetExceededError) {
          budgetStop = true;
          break;
        }
      }
    }

    // 2–5. Check every monitored source, storing new versions and archiving superseded guidance.
    const queue: SourceRow[] = await listMonitoredSources(db);
    if (queue.length > cfg.MAX_SOURCES_PER_REFRESH) {
      problems.push(`${queue.length} sources monitored but MAX_SOURCES_PER_REFRESH=${cfg.MAX_SOURCES_PER_REFRESH}; the rest were not checked`);
    }
    const toCheck = queue.slice(0, cfg.MAX_SOURCES_PER_REFRESH);
    const skipped = queue.slice(cfg.MAX_SOURCES_PER_REFRESH);
    await db.query("UPDATE refresh_runs SET sources_total = $2 WHERE id = $1", [run.id, queue.length]);

    const checkDeps = { db, cfg, model, budget, log, fetchImpl: deps.fetchImpl, sleep: deps.sleep };
    const seen = new Set(toCheck.map((s) => s.id));
    let cursor = 0;
    const worker = async () => {
      while (cursor < toCheck.length) {
        const source = toCheck[cursor++];
        if (budgetStop) {
          skipped.push(source);
          continue;
        }
        const res: CheckResult = await checkSource(checkDeps, run.id, source, { recordChanges: run.trigger !== "initial", campaignProfile });
        tallyResult(tally, res);
        if (res.outcome === "failed") problems.push(`${source.url}: ${res.error}`);
        if (res.outcome === "missing") problems.push(`${source.url}: ${res.error}`);
        if (res.budgetExhausted) budgetStop = true;
        // Follow specific guidance pages linked from hub pages (bounded).
        for (const link of res.followLinks) {
          if (newSources >= cfg.MAX_NEW_SOURCES_PER_REFRESH || toCheck.length >= cfg.MAX_SOURCES_PER_REFRESH) break;
          const id = await addSource(db, link, { origin: "discovered", platform: source.platform });
          if (id && !seen.has(id)) {
            const row = await getSource(db, id);
            if (row) {
              seen.add(id);
              toCheck.push(row);
              newSources++;
            }
          }
        }
        await db.query(
          `UPDATE refresh_runs SET sources_total = GREATEST(sources_total, $2), sources_checked = $3, sources_unchanged = $4,
             sources_changed = $5, sources_new = $6, sources_discontinued = $7, sources_failed = $8,
             items_added = $9, items_archived = $10, heartbeat_at = now() WHERE id = $1`,
          [run.id, toCheck.length + skipped.length, tally.checked, tally.unchanged, tally.changed, tally.new,
           tally.discontinued, tally.failed, tally.itemsAdded, tally.itemsArchived],
        );
      }
    };
    await Promise.all(Array.from({ length: deps.concurrency ?? 3 }, worker));

    for (const s of skipped) {
      await recordCheck(db, { runId: run.id, sourceId: s.id, outcome: "skipped", error: budgetStop ? "spending limit reached" : "source limit reached" });
    }
    if (skipped.length) {
      problems.push(`${skipped.length} source(s) not checked (${budgetStop ? "spending limit reached" : "source limit reached"})`);
    }
    if (budgetStop) problems.push("Research stopped early because a spending limit was reached");

    // 6–7. Relevance + briefing.
    const complete = problems.length === 0;
    const briefing = await buildBriefing(deps, run, log, budget, complete, campaignProfile, tally);
    if (!briefing.ok) problems.push(briefing.error);

    const status: RunStatus =
      problems.length === 0 ? "succeeded" : tally.checked - tally.failed > 0 ? "incomplete" : "failed";
    await db.query(
      `UPDATE refresh_runs SET status = $2, finished_at = now(), error = $3, briefing_id = $4 WHERE id = $1`,
      [run.id, status, problems.length ? summarizeProblems(problems) : null, briefing.id],
    );
    await log.info(`Refresh #${run.id} finished: ${status}`, { ...tally, spendUsd: Number(budget.spentUsd.toFixed(4)), problems: problems.length });
    return status;
  } catch (err) {
    await log.error(`Refresh #${run.id} failed: ${(err as Error).message}`, { stack: (err as Error).stack });
    await db.query(
      "UPDATE refresh_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1",
      [run.id, `${(err as Error).message}; last verified knowledge retained`],
    );
    return "failed";
  } finally {
    clearInterval(hb);
  }
}

function tallyResult(t: Tally, r: CheckResult) {
  t.checked++;
  if (r.outcome === "unchanged") t.unchanged++;
  else if (r.outcome === "changed") t.changed++;
  else if (r.outcome === "new") t.new++;
  else if (r.outcome === "discontinued") t.discontinued++;
  else t.failed++; // failed or missing (unconfirmed): not verified this run
  t.itemsAdded += r.itemsAdded;
  t.itemsArchived += r.itemsArchived;
}

function summarizeProblems(problems: string[]): string {
  const head = problems.slice(0, 8).join("\n");
  return problems.length > 8 ? `${head}\n…and ${problems.length - 8} more (see source checks)` : head;
}

async function buildBriefing(
  deps: RunnerDeps,
  run: RunRow,
  log: Logger,
  budget: Budget,
  complete: boolean,
  campaignProfile: string,
  tally: Tally,
): Promise<{ ok: true; id: number } | { ok: false; id: number; error: string }> {
  const { db, model } = deps;
  const { rows: changeRows } = await db.query<BriefingChange & { platform: Platform }>(
    `SELECT c.platform, c.kind, c.title, c.summary, c.relevance, c.relevance_note, s.url AS "sourceUrl"
     FROM knowledge_changes c LEFT JOIN sources s ON s.id = c.source_id WHERE c.run_id = $1
     ORDER BY c.platform, array_position(ARRAY['high','medium','low','none'], c.relevance), c.id`,
    [run.id],
  );
  const { rows: failed } = await db.query<{ platform: Platform; url: string; error: string }>(
    `SELECT s.platform, s.url, coalesce(sc.error, sc.outcome) AS error FROM source_checks sc JOIN sources s ON s.id = sc.source_id
     WHERE sc.run_id = $1 AND sc.outcome IN ('failed','missing','skipped') ORDER BY s.platform, s.url`,
    [run.id],
  );
  const date = new Date().toISOString().slice(0, 10);
  const save = async (body: string) => {
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO briefings (run_id, complete, body_markdown) VALUES ($1,$2,$3) RETURNING id::int",
      [run.id, complete, body],
    );
    return rows[0].id;
  };
  const incompleteBanner = complete
    ? ""
    : `> **Incomplete refresh** – ${failed.length} source(s) could not be verified. Their last verified guidance is still in use.\n\n`;
  const failedList = failed.length
    ? `\n\n### Sources not verified this time\n${failed.map((f) => `- [${f.platform}] ${f.url} – ${f.error}`).join("\n")}`
    : "";

  if (run.trigger === "initial") {
    const { rows } = await db.query<{ platform: Platform; n: string }>(
      "SELECT platform, count(*) AS n FROM knowledge_items WHERE status = 'current' GROUP BY platform",
    );
    const counts = Object.fromEntries(rows.map((r) => [r.platform, Number(r.n)]));
    const body =
      `# What changed and what it means for us – ${date}\n\n${incompleteBanner}` +
      `Initial research complete. Indexed ${tally.new} official source(s): ` +
      `${counts.meta ?? 0} Meta and ${counts.tiktok ?? 0} TikTok guidance item(s) are now searchable. ` +
      `Future refreshes will report changes against this baseline.${failedList}`;
    return { ok: true, id: await save(body) };
  }

  if (changeRows.length === 0) {
    const body =
      `# What changed and what it means for us – ${date}\n\n${incompleteBanner}` +
      `No substantive changes found in ${tally.checked - tally.failed} verified official source(s). ` +
      `No action needed for Creative Academy's campaigns.${failedList}`;
    return { ok: true, id: await save(body) };
  }

  try {
    const body = await model.writeBriefing(
      { complete, changes: changeRows, failedSources: failed, campaignProfile, runDate: date },
      budget,
    );
    return { ok: true, id: await save(`${incompleteBanner}${body}`) };
  } catch (err) {
    // Save the raw change list so nothing is lost, but flag the run as incomplete.
    const fallback =
      `# What changed – ${date}\n\n> Briefing could not be generated (${(err as Error).message}). Raw change list below.\n\n` +
      changeRows
        .map((c) => `- **[${c.platform}] ${c.kind}: ${c.title}** (${c.relevance} relevance) – ${c.summary}${c.relevance_note ? ` ${c.relevance_note}` : ""}${c.sourceUrl ? ` (${c.sourceUrl})` : ""}`)
        .join("\n") +
      failedList;
    const id = await save(fallback);
    await log.error(`Briefing generation failed: ${(err as Error).message}`);
    return { ok: false, id, error: `Briefing generation failed: ${(err as Error).message}` };
  }
}
