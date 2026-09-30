# Bilan knowledge updates

Bilan's persistent advertising knowledge base for **Meta** and **TikTok**, kept current by a
durable background refresh that runs on the deployed backend every **42 days** (measured from
the last *successful* refresh), whether or not anyone has the app open.

It never publishes ads or changes budgets. It has no ad-account credentials at all. Knowledge
updates can produce *recommendations* in briefings and answers; people apply them.

## What it does

| Requirement | Where |
|---|---|
| Initial research + indexing of official sources | Runs automatically on first start (`KB_AUTO_INITIAL=true`) — `src/refresh/runner.ts` |
| Official sources only, Meta and TikTok kept separate | Per-platform domain allowlists — `src/research/sources.ts` |
| 42-day refresh from last success, durable, no duplicates | `src/refresh/schedule.ts`, unique index `refresh_runs_one_active` |
| Check for new / changed / discontinued guidance | Discovery (Claude web search limited to official domains) + per-page version comparison — `src/refresh/checkSource.ts` |
| Compare against stored versions | Normalized content hash; only changed pages are sent for (paid) analysis |
| Update searchable knowledge base | Postgres full-text search — `src/knowledge/search.ts` |
| Archive superseded guidance | Items are archived with reason + `superseded_by`; search only returns `current` items |
| Source URLs, verification dates, version history | `sources`, `source_versions`, `knowledge_items.verified_at`, supersede chain |
| Regional / account / rollout limits | Stored per item (`regions`, `account_scope`, `rollout_status`, `limitations`) |
| Inaccessible ≠ unchanged | Login walls, 401/403, bot checks, JS shells, timeouts → `failed`; last verified version kept; refresh marked **incomplete** |
| Discontinued pages | 404/410 or redirect to a generic landing page, confirmed on 2 consecutive checks, then archived |
| Creative Academy relevance + briefing | Campaign profile (editable in dashboard) → “What changed and what it means for us” briefing saved per refresh |
| Retrieve before answering; live-check changeable guidance | `POST /api/ask` — `src/knowledge/ask.ts` |
| Monitoring + “Update now” | Dashboard at `/` — `public/` |
| Bounded retries, visible failures | Per-page fetch retries (default 3, backoff); per-refresh retries after 1h/6h/24h, then stops and flags |
| Spending limits | `MAX_USD_PER_REFRESH`, `MAX_USD_PER_MONTH`, `MAX_USD_PER_QUESTION`, source/search caps — enforced before every paid call |
| Execution logs | `run_logs` table, shown per refresh in the dashboard |

### Refresh pipeline

1. **Discover** — Claude web search restricted to each platform's official domains finds policy,
   help-centre, API/changelog and announcement pages; hub pages also contribute relevant links.
2. **Retrieve** each monitored page directly (bounded retries on timeouts/429/5xx). If a page blocks
   direct access, retry through Claude's `web_fetch` tool. If both fail, the source is **failed**.
3. **Compare** the normalized text hash with the stored version. Unchanged pages are re-verified
   without any paid call.
4. **Analyze** changed/new pages: Claude extracts the guidance items, matching them to stored items
   (unchanged / changed / new / discontinued) and noting regional, account and rollout limits.
5. **Store** in one transaction per page: new version, archive superseded/discontinued items,
   insert new items, record human-readable changes.
6. **Brief** — a “What changed and what it means for us” briefing (Meta and TikTok separated),
   with suggested actions for review.
7. **Finish** — `succeeded` only if every step completed and was stored; otherwise `incomplete`
   (some sources unverified, flagged) or `failed`. Only a success resets the 42-day clock.

## Deploy (Render)

`render.yaml` (repo root) defines an always-on web service (API + dashboard + scheduler) and a
Postgres database.

1. In Render: **New → Blueprint**, pick this repository.
2. Set `ANTHROPIC_API_KEY` when prompted. `ADMIN_TOKEN` is generated; copy it from the service's
   Environment tab — it is the dashboard login and the token Bilan's backend uses.
3. Deploy. On start the service migrates the database, registers seed sources and the scheduler
   starts the initial research automatically.

Any host that runs a Docker container 24/7 next to Postgres works the same way (Railway, Fly.io,
a VM). Do **not** use a free/sleeping instance: the scheduler lives in the process. To split
roles, run one container with `PROCESS_ROLE=web` and one with `PROCESS_ROLE=worker`.

### Before claiming automatic updates are active

The dashboard only shows **“Automatic updates are active”** when both are true on the deployed
backend: the scheduler has checked in recently, **and** a refresh started by the scheduler (not
by “Update now” or a test) completed successfully. To verify a new deployment:

1. Open the service shell and run `npm run smoke` (≈ $0.10–0.30). It exercises direct fetching of
   every seed, Claude analysis, web_fetch, web search discovery and briefing generation, and
   prints PASS/FAIL per step.
2. Watch the initial research in the dashboard (Update history → click the run). Expect some
   official pages to be blocked for bots; they should succeed via web_fetch or be listed as failed.
3. If the initial research is **incomplete**, open the failed sources: fix/disable unreachable
   ones (Sources tab) and press **Update now**. The green banner appears after the next
   scheduler-started refresh succeeds.
4. Optional end-to-end schedule test on a staging copy: set `REFRESH_INTERVAL_DAYS=0.02`
   (~29 minutes), confirm a `scheduled` refresh starts on its own and succeeds, then set it
   back to `42`.

## Local development

```bash
cp .env.example .env            # set DATABASE_URL, ADMIN_TOKEN, ANTHROPIC_API_KEY
npm install
npm run dev                     # http://localhost:8080
TEST_DATABASE_URL=postgres://… npm test   # tests drop and recreate the public schema of that database
```

## API

All `/api/*` routes need `Authorization: Bearer $ADMIN_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Last success, next scheduled refresh, automation status, counts, spend |
| POST | `/api/refresh` | “Update now” (returns the existing run if one is already active) |
| GET | `/api/runs`, `/api/runs/:id` | Update history; per-run sources checked/failed, changes, briefing, logs |
| GET | `/api/briefings` | Saved briefings |
| GET/POST/PATCH | `/api/sources` | List, add an official URL, enable/disable a source |
| GET | `/api/sources/:id/versions` | Stored versions of a page |
| GET | `/api/knowledge/search?q=&platform=` | Search current guidance |
| GET | `/api/knowledge/items/:id` | An item with its superseded history |
| POST | `/api/ask` | Retrieve → live-check → answer (see `docs/BILAN_INTEGRATION.md`) |
| GET/PUT | `/api/settings/campaign-profile` | Creative Academy campaign profile |

See `docs/COSTS.md` for hosting, research service and API costs.
