# Bilan · Knowledge updates

Bilan's persistent, versioned knowledge base of official **Meta** and **TikTok** advertising
guidance. It refreshes on a durable backend schedule every **42 days**, measured from the last
*successful* refresh, whether or not anyone has the app open. It also shows the refresh state honestly.

Built from the design handoff in [`docs/DESIGN_HANDOFF.md`](docs/DESIGN_HANDOFF.md): the UI
follows the prototype (Tabs layout) and the backend follows its spec. The deviations are listed below.

Nothing here can publish ads, edit campaigns or change spend. The service holds no Meta or TikTok
ad-account credentials. Recommendations can only be proposed, then added to the plan or dismissed
by Sabah.

## How it works

```
pg_cron (or the worker) ──every 15 min──▶ kb_tick()  ── queues at most one refresh (DB unique index)
"Update now" ─────────────────────────▶ kb_enqueue() ─┘
worker ── claims the run ──▶ Discover ▶ Fetch (retries 2/10/30 min) ▶ Compare ▶ Index ▶ Archive ▶ Brief ▶ Verify storage
```

1. **Discover**: Claude web search, restricted to the official domains in Settings, finds new,
   moved or removed pages. Third-party pages are never stored.
2. **Fetch** each source: direct HTTPS first. If a page is blocked or empty, the worker falls back
   to a rendered fetch (Firecrawl, optional), then Claude's `web_fetch`.
   **An inaccessible page is a failure, never "unchanged".** The following all count as failures:
   HTTP ≥ 400, network errors, timeouts, login redirects, bot challenges, and a page whose text
   shrank below 40% of the stored version. HTTP 410, or a permanent redirect to a different
   article, counts as *discontinued*; the redirect target is added and indexed in the same run.
3. **Compare**: an identical hash is recorded as unchanged, with no paid call. A different hash
   means Claude extracts entries (summary, body, limitations by kind, "For Creative Academy") and
   classifies each one as changed, new, removed or cosmetic. Results are **staged**, not written
   as current.
4. **Finalize**, in one transaction:
   - **If every active source was verified:** staged versions are promoted, superseded versions
     are archived with a reason, the verification dates update, the briefing and recommendations
     are saved, and the run becomes `complete`.
   - **Otherwise:** nothing is promoted and the run becomes `incomplete`. A partial briefing lists
     the unverified sources, the last verified versions stay current, and an alert email is sent.
5. The 42-day clock only moves on `complete`. An incomplete run is retried once a day, inside the
   run window, for up to 3 days. A run with no activity for 2 hours is marked failed and the lock
   is released. A source that fails in 3 consecutive runs is escalated in the Sources tab
   (fix its URL or pause it).

**Status is driven only by backend state.**
- **Automatic updates active:** a `scheduled` refresh has completed on the production worker
  (`schedule_verified_at`), and the latest refresh is complete.
- **Automatic updates not active:** that has not happened yet. This shows even after a successful
  manual run.

**Using the knowledge:** Bilan's chat calls `GET /api/kb/search` before any advertising answer.
If the matched entries are changeable (policy, feature availability, setup steps), it calls
`POST /api/kb/verify-live` first; a changed page is saved as an `LC-xxx` version. `POST /api/ask`
does all three steps. See [`docs/BILAN_INTEGRATION.md`](docs/BILAN_INTEGRATION.md).

## Deviations from the handoff stack (and why)

| Handoff | Here | Why |
|---|---|---|
| Supabase Queues (`pgmq`) + Edge Functions | One always-on Node worker; retry queue in `run_sources` (`next_attempt_at`) | Edge Functions can't be tested in this environment. The handoff already allows moving the fetch worker "to a small always-on container". |
| `pg_cron` runs `kb_tick()` | Same SQL `kb_tick()`. pg_cron schedules it where available; the worker also calls it every 15 min | Works on Supabase Pro and on hosts without pg_cron. Both callers are safe together. |
| Next.js app | React UI bundled with esbuild, served by the same service | No Bilan app exists yet. The components are plain React and port directly into Next.js later. |
| Claude "Sonnet class" | `claude-sonnet-5-5` | Current Sonnet, same price as Sonnet 5. |
| UUID ids | BIGSERIAL ids + `R-015` / `LC-031` codes | Codes as specified; numeric ids internally. |

Everything else (data model, statuses, run window, retries and backoff, budgets and on-limit
behaviour, alerts, the activation checklist, and the §9 acceptance tests) follows the spec.

## Deploy

**Option A: Render only (cheapest).** `render.yaml` at the repo root creates an always-on web
service and Postgres (pgvector is available; the worker ticks itself).

**Option B: Supabase Pro database + a small always-on container (the handoff's recommendation).**
Create a Supabase Pro project and enable `pg_cron` and `vector` under Database → Extensions. Run the
container (Render, Railway or Fly) with `DATABASE_URL` pointing at Supabase's direct connection
string. The migrations schedule `kb_tick()` with pg_cron automatically.

Either way:
1. Set `ANTHROPIC_API_KEY` and `DEPLOYMENT_ENV=production`. Optionally set `VOYAGE_API_KEY`
   (hybrid search), `FIRECRAWL_API_KEY` (rendered fetch) and `RESEND_API_KEY` + `ALERT_FROM_EMAIL`
   (alerts).
2. Copy the generated `ADMIN_TOKEN`: it's the UI login and Bilan's API token.
3. Open the UI → Settings: set the alert email and check the Creative Academy profile.
4. **Brand font:** Seismic Latin VF is not bundled. License it, put the file in `public/fonts/`
   and add its `url(...)` in `public/styles.css`. Until then the UI uses Work Sans.

### Before calling updates "active" (handoff §9, on the deployed backend)

The same scenarios pass in the automated tests (`test/acceptance.test.ts`). They still have to be
repeated for real, because the tests use a simulated web and model.

1. Run `npm run smoke` in the service shell (≈ $0.10–$0.30). It checks direct fetch of every seed,
   extraction, `web_fetch`, discovery, briefing, and the optional services, printing PASS/FAIL.
2. The initial research runs automatically. Confirm it completes, with separate Meta and TikTok
   entries.
3. In staging, move the last success back 42 days, close the app, and wait for a tick:
   `UPDATE system_status SET last_success_at = now() - interval '42 days 1 hour';`
   A `scheduled` run must complete and the checklist item must tick.
4. Force a source to fail (Sources → Edit URL to a page that returns 403, or pause the network).
   The run must be incomplete, nothing promoted, the UI red, and the alert email sent.
5. Click **Update now** twice quickly: only one run.
6. Ask a policy question in chat after a source changed: an `LC-` version is saved and cited.

## Local development

```bash
cp .env.example .env
npm install
npm run dev                 # builds the UI, starts API + worker on :8080
TEST_DATABASE_URL=postgres://… npm test   # drops and recreates that database's public schema
```

Tests (35) run against real Postgres with a simulated web and model. pg_cron and pgvector tests
run when those extensions are present.

## API (all `/api/*` need `Authorization: Bearer $ADMIN_TOKEN`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Status headline, last success, next scheduled, latest run, active run progress, activation checklist |
| POST | `/api/refresh` | Update now / Run initial research. A duplicate returns the active run. |
| GET | `/api/overview` | Incomplete banner data + latest briefing preview |
| GET/POST/PATCH | `/api/sources` | Latest results per source; add an official page; pause/resume, edit URL, fetch mode |
| GET | `/api/runs`, `/api/runs/:code`, `/api/runs/:code/logs` | Update history, detail with diffs, execution log |
| GET | `/api/briefings`, `/api/briefings/:id` | Briefings |
| PATCH | `/api/recommendations/:id` | `added_to_plan` / `dismissed` |
| GET | `/api/entries`, `/api/entries/:id` | Knowledge base by platform, current/archived, with version history |
| GET/PUT | `/api/settings` | Run window, retries, budgets, on-limit, alert email, profile |
| GET | `/api/kb/search` | Hybrid search over current entries (for Bilan) |
| POST | `/api/kb/verify-live` | Live check of one source (for Bilan) |
| POST | `/api/ask` | Search → live-check → answer |

Costs: [`docs/COSTS.md`](docs/COSTS.md).
