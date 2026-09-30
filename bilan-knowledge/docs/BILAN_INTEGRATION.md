# Using the knowledge base from Bilan

Bilan's chat backend should route every advertising question through this service rather than
answering from the model's own memory. The service enforces the order in code, not in a prompt:

1. **Retrieve** saved, current (non-archived) knowledge for the question, separated by platform.
2. If the question involves changeable guidance (policies, features, availability, setup steps,
   APIs, targeting, limits…), **re-verify the cited official pages live**. Any verified change is
   saved as a `live_check` run and appears in the update history.
3. **Answer** from that knowledge, searching official Meta/TikTok domains for gaps. Official pages
   found this way are indexed in the background.

## Simplest integration: `POST /api/ask`

```http
POST /api/ask
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{ "question": "Can we run TikTok lead ads for a paid course in the UK?", "platform": "tiktok" }
```

`platform` is optional (`"meta"`, `"tiktok"` or omitted to detect). Response:

```json
{
  "answer": "… cites [K1], [K2] with source URLs and verification dates …",
  "platform": "tiktok",
  "knowledge": [{ "ref": "K1", "title": "…", "guidance": "…", "regions": ["UK"],
                  "account_scope": null, "rollout_status": "beta", "source_url": "https://ads.tiktok.com/…",
                  "verified_at": "2026-09-30T11:08:00Z" }],
  "liveChecks": [{ "url": "https://ads.tiktok.com/…", "outcome": "unchanged" }],
  "liveCheckRunId": 42,
  "spendUsd": 0.12
}
```

A `liveChecks[].outcome` of `failed` means the official page couldn't be re-checked just now.
The answer says so, and the saved version may be out of date.

## If Bilan runs its own agent loop

Expose these as tools and instruct the agent to call `search_ad_knowledge` before any advertising
answer or campaign recommendation:

```json
[
  {
    "name": "search_ad_knowledge",
    "description": "Search Bilan's saved, current official Meta and TikTok advertising guidance. Call before answering any advertising question or preparing a campaign recommendation. Returns items with source URL, verification date and regional/account/rollout limits.",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string" },
        "platform": { "type": "string", "enum": ["meta", "tiktok"] }
      },
      "required": ["query"]
    }
  },
  {
    "name": "verify_ad_guidance",
    "description": "Answer an advertising question after re-verifying the relevant official sources live and saving any verified change. Use when the question involves policies, features, availability or setup steps that change.",
    "input_schema": {
      "type": "object",
      "properties": {
        "question": { "type": "string" },
        "platform": { "type": "string", "enum": ["meta", "tiktok"] }
      },
      "required": ["question"]
    }
  }
]
```

Map `search_ad_knowledge` → `GET /api/knowledge/search?q=…&platform=…` and
`verify_ad_guidance` → `POST /api/ask`.

## Boundaries

- The service holds no Meta or TikTok ad-account credentials and has no endpoint that publishes
  ads or changes budgets. Recommendations are text for people to review and apply.
- Meta and TikTok guidance are stored, searched and briefed separately. A rule on one platform is
  never presented as applying to the other.
