# Costs

Prices were checked on 30 Sep 2026 (from the design handoff §7 and Anthropic's list prices).
Re-check them before deploying. This excludes the cost of building the system.

## Unit prices

| Service | What it's for | Price |
|---|---|---|
| Claude Sonnet 5.5 (`RESEARCH_MODEL`) | Extraction, comparison, briefing, answers | $2 per million input tokens, $10 per million output tokens |
| Claude web search | Discovery of new/moved pages on official domains | $10 per 1,000 searches + tokens |
| Claude web fetch | Fallback retrieval for blocked pages | Tokens only |
| Voyage `voyage-4-lite` (optional) | Hybrid search embeddings | $0.02 per million tokens; first 200M tokens free |
| Firecrawl (optional) | Rendered fetch of JavaScript-rendered pages | Free tier 1,000 credits/month; Hobby $19/month for 5,000 |
| Resend (optional) | Alert emails | Free tier covers this volume |

## Hosting (pick one)

| Option | Monthly |
|---|---|
| A. Render Starter web service (~$7) + Render Postgres Basic (~$6–7) | **~$13–15** |
| B. Supabase Pro ($25, includes pg_cron + pgvector) + small always-on container (~$5–7) | **~$30–32** |

Free or auto-sleeping plans aren't suitable. The worker must run 24/7, and free Supabase projects
pause after 7 days without activity, which would silently stop a 42-day schedule.

## Research cost per run

Unchanged pages are hash-matched and never sent to Claude, which keeps refreshes cheap.

| Item | Per 42-day refresh (~22–40 sources, ~10 changed) |
|---|---|
| Discovery: up to 15 searches per platform + result tokens | ~$0.90 |
| Extraction and comparison of changed pages | ~$0.70 |
| Briefing | ~$0.15 |
| Embeddings | ~$0 (free allowance) |
| Retries, web_fetch fallbacks, headroom | $0.25–$1.70 |
| **Per refresh** | **~$2–$3.50** (default cap $5) |

- **Initial research** (one-off, all pages extracted): **~$8–$12** (default cap $15).
- **Live checks:** ~$0.02–$0.05 each; a check of an unchanged page costs nothing beyond hosting.
  The default cap is $5/month.
- **Chat answers via `/api/ask`:** ~$0.01–$0.05 each (capped per answer by `MAX_USD_PER_ANSWER`).

## Monthly total

| | Option A | Option B |
|---|---|---|
| Hosting | $13–15 | $30–32 |
| Research (refresh amortised ≈ $2 + live checks $0–5) | $2–7 | $2–7 |
| Firecrawl (only if needed) | $0–19 | $0–19 |
| **Total** | **~$15–41** | **~$32–58** |

## Limits (Settings tab)

Every paid call is estimated at its worst case before it runs and written to `budget_ledger`
after. When a limit is reached:
- **"Stop and mark incomplete":** the call is refused.
- **"Finish current source, then stop":** sources already in progress finish, then the run stops.

Either way the run is `incomplete (budget_limit)` and no current guidance is replaced.
