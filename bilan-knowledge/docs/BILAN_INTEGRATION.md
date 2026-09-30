# Using the knowledge from Bilan's chat and planning

Before any advertising answer or campaign recommendation, Bilan must:

1. **Search** saved knowledge: `GET /api/kb/search?q=…&platform=meta|tiktok`.
   This searches current entry versions only (archived versions are never returned), using hybrid
   full-text + vector search when embeddings are enabled.
2. **Live-check changeable guidance.** If a matched entry's category is `policy`,
   `feature_availability` or `setup_steps`, call `POST /api/kb/verify-live {"source_id": …, "question": "…"}`
   first. A changed page is extracted, compared and promoted immediately as an `LC-xxx` run with
   `origin='live_check'`. If the fetch fails, the result is `Not verified`: Bilan must say the
   guidance couldn't be re-verified and give the stored version's date.
3. **Answer, citing** the entry title, source URL and verification date. If a result has
   `stale: true` (its source failed in the latest refresh, is paused or is escalated), say the
   guidance may be out of date.

`POST /api/ask {"question": "…", "platform": "meta"}` runs all three steps and returns
`{ answer, knowledge[], liveChecks[] }`.

All calls send `Authorization: Bearer <ADMIN_TOKEN>`.

## Tool definitions for Bilan's agent

```json
[
  {
    "name": "kb_search",
    "description": "Search Bilan's saved, current official Meta and TikTok advertising guidance. Call before any advertising answer or campaign recommendation. Returns entries with source URL, verification date, limitations, 'For Creative Academy' relevance, category and a stale flag.",
    "input_schema": { "type": "object", "properties": { "query": { "type": "string" }, "platform": { "type": "string", "enum": ["meta", "tiktok"] } }, "required": ["query"] }
  },
  {
    "name": "kb_verify_live",
    "description": "Re-verify one official source now before answering. Use when a matched entry's category is policy, feature_availability or setup_steps. Saves any verified change.",
    "input_schema": { "type": "object", "properties": { "source_id": { "type": "integer" }, "question": { "type": "string" } }, "required": ["source_id"] }
  }
]
```

## Boundaries

- Meta and TikTok entries are never mixed. Filter by platform whenever it is known.
- The service cannot publish ads, edit campaigns or change spend, and holds no credentials that
  could. Recommendations are `proposed` until Sabah adds them to the plan or dismisses them.
