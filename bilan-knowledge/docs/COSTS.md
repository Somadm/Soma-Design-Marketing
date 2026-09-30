# Costs

Three things cost money: **hosting**, **the research service** and **API usage**. The research
service *is* the Claude API: Claude's web search and web fetch tools plus the model. There's no
separate search subscription. All prices below are list prices at the time of writing; check the
providers' pricing pages before you commit.

## 1. Hosting (fixed)

| Item | Why it's needed | Typical price |
|---|---|---|
| Always-on web service (e.g. Render *Starter*) | Runs the API, dashboard and the scheduler 24/7 | ~$7/month |
| Managed Postgres (e.g. Render *Basic 256 MB*) | Persistent knowledge base, versions, runs, logs | ~$6–7/month |
| **Total** | | **~$13–15/month** |

Free or auto-sleeping instances aren't suitable: the scheduler would stop when the instance
sleeps. Storage is small. Page versions are text, typically well under 1 GB for years of history.

## 2. Research service and model usage (variable)

Claude API list prices used by the spending limits (`src/research/budget.ts`):

| | Input | Output |
|---|---|---|
| Claude Opus 5.5 (default `RESEARCH_MODEL`) | $4 / million tokens | $20 / million tokens |
| Claude Sonnet 5.5 (optional, cheaper) | $2 / million tokens | $10 / million tokens |
| Web search | $10 per 1,000 searches | |
| Web fetch | no per-fetch fee; fetched content is billed as input tokens | |

What each operation costs with the default model (estimates):

| Operation | When | Estimate |
|---|---|---|
| Direct fetch + hash compare of an unchanged page | Every refresh, every page | $0 |
| Page fetched via Claude web_fetch (blocked for bots) | Every refresh, for blocked pages | ~$0.03–0.08 per page |
| Analysis of a new or changed page | Only when content changed | ~$0.08–0.25 per page |
| Discovery (up to 8 searches per platform) | Every refresh | ~$1–2 |
| Briefing | Every refresh with changes | ~$0.05–0.15 |
| **Initial research** (~50 pages) | Once | **~$8–15** |
| **42-day refresh** (~20–40% of pages changed) | Every 42 days | **~$3–8** |
| Question with live check | Per question | ~$0.05–0.35 |

Monthly API spend: about **$3–6** for the schedule, plus **$5–35 per 100 questions**, depending
on how often live checks find changes.

**Typical total: ~$20–50/month**, dominated by how much Bilan is asked.

## 3. Limits you control

Every paid call is estimated (worst case, with full output) *before* it runs, and refused if it
would exceed a limit. A refresh that hits a limit stops, is marked **incomplete** with the
reason, and keeps the last verified knowledge.

| Setting | Default | Meaning |
|---|---|---|
| `MAX_USD_PER_REFRESH` | 20 | Cap per refresh (initial research fits comfortably) |
| `MAX_USD_PER_MONTH` | 50 | Cap across refreshes and questions per calendar month |
| `MAX_USD_PER_QUESTION` | 1 | Cap per question, including its live checks |
| `MAX_SOURCES_PER_REFRESH` | 150 | Pages checked per refresh |
| `MAX_DISCOVERY_SEARCHES_PER_PLATFORM` | 8 | Web searches per platform per refresh |
| `MAX_NEW_SOURCES_PER_REFRESH` | 40 | New pages added per refresh |
| `LIVE_CHECK_MAX_SOURCES` | 3 | Sources re-verified per question |
| `LIVE_CHECK_FRESH_HOURS` | 24 | Skip live re-check if verified this recently |
| `RESEARCH_MODEL` | `claude-opus-5-5` | `claude-sonnet-5-5` roughly halves model costs, at some cost to extraction quality |

Actual spend per call is recorded in `spend_ledger` and shown in the dashboard (per refresh and
month to date).
