# Soma Design Marketing

- [`sagal/`](sagal/README.md): **Sagal**, creative producer and organic social media agent. Talk (text, voice
  notes, live voice), planning, carousel and video studios, publishing with server-side permissions,
  inspiration, results shared with Bilan, Needs Sabah, memory and settings. Beginner setup:
  [`sagal/docs/SETUP.md`](sagal/docs/SETUP.md).
- [`bilan-knowledge/`](bilan-knowledge/README.md): Bilan · Knowledge updates. A versioned knowledge base of official Meta and TikTok advertising guidance, refreshed every 42 days on a durable backend schedule, with the Knowledge updates UI from the design handoff. Costs: [`bilan-knowledge/docs/COSTS.md`](bilan-knowledge/docs/COSTS.md).

Both deploy from `render.yaml` and share one Postgres database: Bilan in schema `public`, Sagal in `sagal`,
and the memory they share in `shared`.
