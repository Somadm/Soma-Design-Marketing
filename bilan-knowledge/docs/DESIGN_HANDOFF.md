# Handoff: Bilan · Knowledge Updates

## Overview
Knowledge Updates is one section of Bilan, the advertising agent that helps Sabah grow Creative Academy's paid Skool membership through Meta and TikTok ads. It keeps a persistent, versioned knowledge base of official Meta and TikTok advertising guidance, refreshes it on a durable backend schedule every 42 days (measured from the last **successful** refresh), and shows the refresh state honestly.

This document covers both the **UI** (recreate from the prototype) and the **backend** (build from this spec). The prototype does not run a real scheduler. Nothing here is live until the acceptance tests in §9 pass on the deployed backend.

## About the design files
`Knowledge Updates.dc.html` is a **design reference built in HTML**: a working prototype with simulated data and a simulated refresh. Do not ship it. Recreate it in Bilan's app framework (none exists yet; recommended: Next.js + TypeScript + the Supabase client). All sources, dates, versions and policy text in the prototype are **sample data**, not real guidance.

Prototype tweaks (Tweaks panel):
- `layout`: `Tabs` (status strip + horizontal tabs) or `Status rail` (sticky left status panel + vertical nav). Pick one.
- `scenario`: `Healthy`, `Incomplete refresh`, `Not yet deployed`.
- `simOutcome`: result of the simulated **Update now** run.

## Fidelity
High fidelity for layout, copy, states and behaviour. Styled to the SOMA Design ● Marketing brand (primary #94ABF9, neutrals #FFFFFF / #F5F6F8 / #1F2328, Seismic Latin VF).

---

## 1. Recommended stack

| Concern | Choice | Why |
|---|---|---|
| Database + vector search | Supabase Postgres + `pgvector` | One store for sources, versions, entries, embeddings, runs and logs |
| Durable scheduler | `pg_cron` inside Postgres | Runs with the app closed; survives deploys; schedule lives with the data |
| Job queue | Supabase Queues (`pgmq`) | One message per source, visibility-timeout retries, no lost jobs |
| Workers | Supabase Edge Functions | One source per invocation keeps each call well inside the 150 s request limit |
| Page retrieval | Direct HTTPS fetch; Firecrawl fallback for JS-rendered or bot-protected pages | Official help centres are often client-rendered |
| Extraction, diff classification, briefing | Claude API (Sonnet class) | Structured extraction with scope/limitation fields |
| Discovery of new pages | Claude web search tool, restricted to official domains | Finds new/moved pages between refreshes |
| Embeddings | Voyage `voyage-4-lite` | Low cost; large free allowance |
| Alerts | Email via Resend/Postmark | Failure and incomplete-run notices |

Supabase's **free tier is not suitable**: free projects pause after 7 days without activity, which would silently stop a 42-day schedule. Use Pro.

If Firecrawl can't render some Meta pages, move the fetch worker to a small always-on container (Railway/Fly, ~$5/mo) running Playwright. Queue and schema stay the same.

## 2. Data model (Postgres)

```sql
create type platform as enum ('meta','tiktok');
create type run_status as enum ('queued','running','complete','incomplete','failed','cancelled');
create type run_trigger as enum ('initial','scheduled','manual','retry');

create table sources (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  title text not null,
  url text not null unique,
  source_type text not null,          -- policy | help_centre | api_docs | announcements
  status text not null default 'active', -- active | discontinued | paused
  fetch_mode text not null default 'direct', -- direct | rendered
  created_at timestamptz default now()
);

create table source_versions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources not null,
  version int not null,
  content_hash text not null,         -- sha256 of normalised text
  normalised_text text not null,
  raw_snapshot_path text,             -- Supabase Storage: original HTML
  fetched_at timestamptz not null,
  verified_at timestamptz not null,   -- last time live content matched this version
  run_id uuid,
  status text not null default 'current', -- current | superseded | discontinued
  superseded_at timestamptz,
  unique (source_id, version)
);

create table entries (                 -- one piece of guidance, e.g. "Financial and income claims"
  id uuid primary key default gen_random_uuid(),
  platform platform not null,          -- Meta and TikTok never share an entry
  source_id uuid references sources not null,
  slug text not null,
  title text not null,
  category text not null,
  unique (platform, slug)
);

create table entry_versions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid references entries not null,
  version int not null,
  source_version_id uuid references source_versions not null,
  summary text not null,
  body text not null,
  relevance text,                      -- "For Creative Academy"
  limitations jsonb not null default '[]', -- [{kind:'region'|'account'|'rollout'|'placement', text}]
  status text not null default 'current', -- current | archived
  origin text not null,                -- refresh | live_check
  run_id uuid,
  verified_at timestamptz not null,
  archived_at timestamptz,
  archived_reason text,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('english', title_cache || ' ' || summary || ' ' || body)) stored,
  title_cache text not null,
  unique (entry_id, version)
);
create unique index one_current_per_entry on entry_versions(entry_id) where status = 'current';

create table refresh_runs (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,           -- R-015, LC-031
  trigger run_trigger not null,
  status run_status not null default 'queued',
  started_at timestamptz, finished_at timestamptz,
  sources_total int, sources_verified int default 0, sources_failed int default 0,
  budget_usd numeric(8,2) not null, spend_usd numeric(8,4) default 0,
  error text
);
-- Duplicate prevention: at most one active refresh, enforced by the database.
create unique index one_active_refresh on refresh_runs ((true)) where status in ('queued','running');

create table run_sources (
  run_id uuid references refresh_runs, source_id uuid references sources,
  result text not null,                -- unchanged | changed | new | discontinued | failed
  attempts int not null default 0,
  http_status int, failure_reason text,
  staged_source_version jsonb,         -- held until finalize
  primary key (run_id, source_id)
);

create table run_logs (id bigserial primary key, run_id uuid references refresh_runs, at timestamptz default now(), level text, stage text, message text, data jsonb);
create table briefings (id uuid primary key default gen_random_uuid(), run_id uuid references refresh_runs unique, partial boolean not null, summary text, body jsonb, created_at timestamptz default now());
create table recommendations (id uuid primary key default gen_random_uuid(), briefing_id uuid references briefings, text text, status text default 'proposed', decided_at timestamptz); -- proposed | added_to_plan | dismissed
create table budget_ledger (id bigserial primary key, run_id uuid references refresh_runs, provider text, units numeric, usd numeric(10,5), at timestamptz default now());
create table settings (id int primary key default 1, run_window_utc time default '03:00', retries int default 3,
  budget_refresh_usd numeric default 5, budget_initial_usd numeric default 15, budget_live_month_usd numeric default 5,
  on_limit text default 'stop', alert_email text);
create table system_status (id int primary key default 1,
  last_success_run uuid, last_success_at timestamptz,
  schedule_verified_at timestamptz,    -- set ONLY when a trigger='scheduled' run completes on the deployed backend
  failure_path_verified_at timestamptz);
```

## 3. Scheduling and duplicate prevention

- `pg_cron` runs `select kb_tick();` every 15 minutes.
- `kb_tick()`:
  1. If `now() >= last_success_at + interval '42 days'` and the current UTC time is inside the run window, insert a `refresh_runs` row with `trigger='scheduled'`. The partial unique index `one_active_refresh` makes a second insert fail, so overlapping ticks and a simultaneous **Update now** can't create two runs.
  2. If the latest refresh is `incomplete` and fewer than 3 retry days have passed, insert `trigger='retry'` once per day.
  3. Recover stuck runs: `running` with no log activity for 2 hours → `failed`, lock released, alert sent.
- **Update now** calls the same `kb_enqueue(trigger)` RPC. If a run is active it returns that run's code and the UI says the request was ignored.
- The 42-day clock only moves when a run finalises as `complete`.

## 4. Refresh pipeline

For each run, the enqueue step writes one `pgmq` message per active source, plus one `discover` message.

1. **Discover**: Claude web search restricted to allowed official domains (see Settings) to find new, moved or removed pages. Candidates are added as `sources` (status `active`, flagged `new`). Third-party pages can suggest leads but are never stored as guidance.
2. **Fetch** (per source): direct HTTPS GET, falling back to rendered fetch if `fetch_mode='rendered'` or the direct body looks empty. Normalise (strip nav, footers, dates, tracking) and hash.
   - **An inaccessible page is a failure, not "unchanged".** Failure = network error, timeout, HTTP ≥ 400, redirect to a login/checkpoint page, bot-challenge markers, or normalised text shorter than 40% of the stored version. 301/410 to a different article → `discontinued` (follow redirect, add the target as a new source).
   - Retries: up to `settings.retries` attempts, backoff 2 min → 10 min → 30 min using the queue's visibility timeout. Log every attempt.
3. **Compare**: hash equal → `unchanged` (the verification date updates on finalize). Hash different → Claude extracts structured entries `{slug, title, category, summary, body, limitations[]}` and classifies each against the stored current entry version: `changed` / `new` / `removed` / `cosmetic`. Cosmetic changes update the source version but don't create entry versions. Results are **staged** in `run_sources.staged_source_version`, not written as current.
4. **Budget**: every provider call writes to `budget_ledger` first. When `spend_usd` would exceed `budget_usd`, stop per `settings.on_limit`; the run becomes `incomplete` with reason `budget_limit`.
5. **Finalize** (one transaction, after all messages are processed):
   - If every source is verified and storage succeeds: promote staged versions, mark superseded entry versions `archived` with `archived_at` and reason, update `verified_at`, embed new versions, write the briefing, set run `complete`, update `system_status.last_success_*`. If `trigger='scheduled'`, set `schedule_verified_at` if empty.
   - Otherwise: nothing is promoted. Run → `incomplete`. A partial briefing is saved with `partial=true`. The last verified versions stay current. Alert email sent.
   - A source that fails in 3 consecutive runs is escalated so Sabah can fix the URL or pause it. Paused sources are excluded from completeness checks, and their entries are shown as stale.
6. **Briefing**: Claude writes "What changed and what it means for us" from the promoted diffs plus the Creative Academy profile (Somali-speaking beginners, creators and business owners; graphic design, branding, AI content, vibe coding; paid Skool membership and retention; vertical video, founder-led demos, statics, carousels). Meta and TikTok are separate sections. Regional, account and rollout limitations are carried through. Proposed actions go to `recommendations` with status `proposed`.

## 5. Using the knowledge (Bilan chat and planning)

- Before any advertising answer or campaign recommendation, Bilan calls `kb.search(query, platform?)`: hybrid pgvector + `tsv` search over `entry_versions where status='current'`, filtered by platform when known. Answers cite the entry title, source URL and verification date.
- **Live checks**: if the matched entry's category is changeable (policy, feature availability, setup steps), Bilan calls `kb.verify_live(source_id)` before answering. It fetches and hashes the page. If the hash differs, it runs the same extract → compare → promote steps for that one source and records a run with code `LC-xxx` (`origin='live_check'`). If the fetch fails, Bilan says the guidance couldn't be re-verified and gives the stored version's date. These checks use the monthly live-check budget.
- If an entry's source is currently failed or paused, Bilan says the guidance may be out of date.

## 6. Safety boundary
The knowledge worker and briefing jobs run with credentials that have **no access** to the Meta Marketing API or TikTok API for Business write scopes. Recommendations can only be `proposed`, `added_to_plan` or `dismissed` by Sabah. Nothing in this section can publish ads, edit campaigns or change budgets.

## 7. Costs (checked 30 Sep 2026; re-check before deploying)

Unit prices:
- Supabase Pro: $25/month per organisation, including $10 compute credit (covers one Micro instance), 8 GB database, 2M Edge Function invocations.
- Claude Sonnet 5: $2 per million input tokens, $10 per million output tokens. Web search tool: $10 per 1,000 searches plus tokens. Web fetch: tokens only.
- Voyage `voyage-4-lite`: $0.02 per million tokens, first 200M tokens free.
- Firecrawl (optional): free tier 1,000 credits/month; Hobby $19/month ($16 billed yearly) for 5,000 credits. 1 credit per page, 5 for stealth mode.

Estimated research cost per 42-day refresh (~22–40 sources, ~10 with real content changes):

| Item | Estimate |
|---|---|
| Discovery: ~30 searches + result tokens | $0.90 |
| Extraction and comparison of changed pages | $0.70 |
| Relevance analysis and briefing | $0.15 |
| Embeddings | ~$0 (free allowance) |
| Retries and headroom | $0.25–$1.70 |
| **Per refresh** | **~$2–$3.50** (default cap $5) |

Unchanged pages are hash-matched and never sent to Claude, which keeps runs cheap.

- Initial research (one-off, broader discovery, ~150 searches, full extraction): **~$8–$12** (default cap $15).
- Live checks: **~$0.02–$0.05** each (default cap $5/month).

Monthly total: **~$27–$50**. That is Supabase Pro $25, plus Firecrawl $0–$19, plus research ~$2 amortised per refresh and $0–$5 for live checks. The cost of building it with Claude Code is not included.

## 8. Screens (from the prototype)

App shell: 200 px left nav (Bilan wordmark, Chat, Campaigns, Creatives, **Knowledge updates** active, Settings). Section header: title, one-line description, primary **Update now** button (in the `Tabs` layout).

Status block (always visible: status strip in `Tabs`, sticky rail in `Status rail`):
- Status headline, driven only by backend state:
  - `Automatic updates active` (green): only when `schedule_verified_at` is set and the latest refresh is complete.
  - `Last refresh incomplete` (red): latest refresh incomplete or failed. States which sources failed and that the last verified versions are in use.
  - `Automatic updates not active` (amber): `schedule_verified_at` is null. Shown even after a successful manual test.
  - `Refresh running` (blue): active run holds the lock.
- Last successful refresh (date, run code, trigger) · Next scheduled refresh (date, "In N days", "Overdue by N days" in red) · Sources checked / failed for the latest run · Spend vs budget.
- **Update now** is disabled while a run is active, and its label shows live progress (`Refreshing… 12/22`). Its label is **Run initial research** until a complete run exists. A duplicate request shows "A refresh is already running. Duplicate request ignored."

Tabs: Overview · Sources (red badge with failure count) · Update history · Briefings · Knowledge base · Execution logs · Settings.
- **Overview**: running panel (8 stages: Lock, Discover, Fetch n/22, Compare, Index, Archive, Brief, Verify storage, plus the latest log line); red incomplete banner (failed sources, reasons, Retry refresh, View log); activation checklist when not deployed; latest briefing preview in Meta and TikTok columns.
- **Sources**: filter chips (All/Changed/New/Discontinued/Failed/Unchanged with counts). Separate Meta and TikTok tables with columns Source (title + URL) · Type · Result badge · Last verified + note ("Succeeded on retry 2", failure reason, "Archived, not current").
- **Update history**: runs list (scheduled, manual, initial, retry and live checks) → detail with stats, failures, and each change with a red/green version diff and a link to the entry. Links to the briefing and the log.
- **Briefings**: list with an "Incomplete run" flag → article with summary, unverified sources, Meta and TikTok sections (each item: kind badge, title, what changed, limitations in amber, "For Creative Academy"), and Proposed actions (Add to campaign plan / Dismiss; note that nothing is published).
- **Knowledge base**: Meta | TikTok segmented control (never mixed), Current | Archived filter, search. Entry detail shows summary, relevance, limitation chips, source URL, verified date and origin, latest diff, and version history with Current/Archived badges. Shows a red note when the latest run couldn't reach the source.
- **Execution logs**: run selector and a dark monospace log (time · level · stage · message). INFO green, WARN amber, ERROR red.
- **Settings**: fixed 42-day interval, run window, retries, backoff; three budget caps with typical costs; on-limit behaviour; official domains per platform; alert email; locked "Publishing and spend changes: Off".

## 9. Acceptance tests (must pass before calling updates "active")
1. Deploy. Run initial research. It completes; entries exist for both platforms, separately.
2. Set `last_success_at` back 42 days in staging, close the app and wait for the cron tick. A `scheduled` run completes and `schedule_verified_at` is set. Only now does the UI show "Automatic updates active".
3. Force one source to return 403 → the run is `incomplete`, nothing is promoted, the UI shows red, the entry says "last verified version", and the email is sent. Set `failure_path_verified_at`.
4. Click Update now twice quickly, and during a cron tick → exactly one active run.
5. Change a fixture page → a new version is created, the old one is archived, the diff shows in history, and the briefing mentions it with limitations preserved.
6. Set a $0.10 budget → the run stops, is marked `incomplete (budget_limit)`, and spend in the ledger is ≤ the cap plus one call.
7. Ask Bilan a policy question whose source has changed → a live check saves an `LC-` version and the answer cites the new date.
8. Confirm the worker's API keys can't call ad write endpoints.

## 10. Design tokens
- Font: **Seismic Latin VF** (brand; license and self-host the files). The prototype falls back to Work Sans because the brand font isn't publicly hosted. Weights: Light 300 for the wordmark and H1, Regular 400 for H2, Medium 500 and Semibold 600 for UI. **IBM Plex Mono** is used only in the execution log. Base 14/1.45; H1 32/300; H2 22–24/400; stat values 18/600; section labels 11/500, +0.12em tracking, uppercase, `#4A63C9`.
- Wordmark: `BILAN` 28/300, +0.06em tracking, with a brand-blue period, echoing the SOMA "S." monogram.
- Brand primary `#94ABF9`: primary buttons (with charcoal `#1F2328` text), active tab underline, selected-row bar, progress. Hover `#7E97F2`. Primary is too light for text, so text and links use the deeper tint `#4A63C9` (hover `#3A52B5`). Tint backgrounds `#EDF1FE` / `#F4F6FE`; focus ring `#C9D5FC`.
- Neutrals: charcoal ink `#1F2328` · secondary `#3D434B` · muted `#5E646E` · faint `#8F949C` · page `#F5F6F8` · surface `#FFFFFF` · subtle `#F9FAFB` · border `#E3E5EA` · divider `#EEF0F3`.
- Status fg/bg (functional; not brand colours): ok `#1D6B45/#E7F3EC` · warn `#7A4F00/#FBF0D9` · fail `#A61B12/#FCEBE9` · info `#3A52B5/#EDF1FE` · neutral `#4A5465/#EEF0F3`.
- Platform dots: Meta `#6F8BF0`, TikTok `#1F2328`.
- Radii: cards 10 px, buttons 7–8 px, badges 4 px, chips 16 px. Borders 1 px. Spacing 4/8/12/16/20/24/32.
- Log panel: bg `#1F2328`, text `#C9D1DC`, INFO `#7FC8A0`, WARN `#E8C170`, ERROR `#F28B82`.

## Files
- `Knowledge Updates.dc.html`: interactive prototype (open in a browser; needs `support.js` beside it).
- `support.js`: prototype runtime only; not part of the product.
