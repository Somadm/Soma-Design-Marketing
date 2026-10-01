# Sagal · creative producer & organic social

Sagal is Sabah's creative producer and organic social media manager inside the Soma app: a
conversation-first workspace (text, voice notes and live voice) plus planning, carousel and video
production, publishing, inspiration, results shared with Bilan, a **Needs Sabah** inbox, and memory/settings.

Built from the design handoff in [`docs/DESIGN_HANDOFF.md`](docs/DESIGN_HANDOFF.md).
**Setup for beginners: [`docs/SETUP.md`](docs/SETUP.md).**

## Phase 1: nothing is connected, everything works

Every service starts as **Not connected**, and the app runs end to end through the manual handoff states:

| Service | Until it's connected |
|---|---|
| Claude | Sagal says plainly that she can't think yet; your message is kept with **Retry**. |
| Email (Resend) | Sign-in codes and alerts are written to the server log. |
| HeyGen | Video studio gives you a package (script, your voiceover) and "I've made it in HeyGen" + upload the render. |
| Captions | Package (render, subtitles.srt, edit notes) and "I've uploaded it" + upload the final edit. |
| Instagram, Facebook, LinkedIn, YouTube, TikTok | At the planned time the post moves to **Post by hand** and a Needs Sabah item has the caption; you mark it "I've posted it". It shows as **Posted by you**, never "Published · confirmed". |
| Voice | **Talk live** uses the browser's own speech recognition and voice, labelled "not Sagal's voice yet". |

Keys are pasted in **Memory & settings → Connected accounts** and stored encrypted. OAuth for Meta, LinkedIn,
Google (YouTube) and TikTok is built in (one-time state, PKCE for TikTok, tokens encrypted). The
platform publishing calls, HeyGen/Captions job calls and the ElevenLabs voice layer are the next build;
the adapters, permission checks and states they plug into are in place (`src/publishing/worker.ts`,
`src/integrations/production.ts`, `ui/screens/Voice.tsx`).

## How it fits together

```
Browser (React)  ──HTTPS──▶  Fastify server (one always-on service)
                               ├─ /api/*            session cookie + x-sagal header on every write
                               ├─ Talk             Claude (streamed) + Sagal's tools, per-turn memory
                               ├─ Publishing worker every 30 s: due posts → permission guard → adapter or manual handoff
                               ├─ Vault            AES-256-GCM secrets (SECRETS_MASTER_KEY)
                               └─ Storage          private S3-compatible bucket(s), signed links only
Postgres  ── schema sagal  (Sagal's tables)
          └─ schema shared (memory_entries, memory_history, tasks: read by Sagal and Bilan)
```

- **Sign-in**: one owner (`OWNER_EMAIL`), email + password, then a 6-digit emailed code on every sign-in
  (also for setup and password reset). Codes expire in 10 minutes, 5 tries; 5 wrong passwords lock sign-in for
  15 minutes. Sessions are 30-day httpOnly cookies.
- **Times**: stored as UTC (`TIMESTAMPTZ`); plan days and post times are entered and shown in Europe/Helsinki
  (DST handled in `src/time.ts`).
- **Publishing permissions are enforced on the server** (`src/publishing/permissions.ts`). Before every publish
  the guard reads the authorisation in force and checks: sample content, pause-all, held by Sabah, authorised
  channel, in the agreed plan, and approval in review mode. Spend checks the monthly € limit. Authorisations are
  append-only records (who, when, what) and every decision is logged in `permission_checks`.
  Retries go to the next agreed slot, never immediately.
- **Audio separation (hard rule)**: Talk-to-Sagal audio (voice notes) is `media_assets.kind = conversation_audio`
  under `conversation-audio/`. Sabah's voiceovers are a separate table (`voiceovers`), a separate storage area
  (`voiceovers/`, or their own bucket) and the database only accepts `uploaded_by = 'sabah'` audio there.
  `buildHeygenRequest` accepts only a voiceover row; there is no path from Sagal's voice to HeyGen, and nothing
  clones Sabah's voice. Tests cover all of this.
- **Claude, two speeds**: Sonnet 5.5 for everyday chat, quick edits and live voice; Opus 5.5 for planning,
  strategy, whole drafts, careful rewrites and long documents (`src/agent/models.ts`). Sonnet can also hand a turn
  up to Opus itself (`use_deeper_thinking`, only at the start of a turn). Sabah switches between Automatic /
  always Sonnet / always Opus in Talk or Memory & settings → Sagal's thinking; each reply shows which model wrote
  it. Models: `SAGAL_MODEL_EVERYDAY`, `SAGAL_MODEL_DEEP`.
  The stable system prompt is cached; memory, the week's plan, inbox and connections are read fresh each turn.
  Server-side refusal fallback is on. Sagal's tools: create idea, create/edit carousel, write video script,
  offer choices, ask Sabah, remember, propose for paid, show this week. She can't publish or change the plan.

## Shared with Bilan

Bilan can read Sagal's memory with plain SQL on the same database:

```sql
SELECT section, key, value, owner FROM shared.memory_entries;      -- facts, approved language, preferences, notes
SELECT * FROM shared.tasks WHERE status IN ('Sent to Bilan', 'Ready for Bilan');
```

Write with `owner/updated_by = 'bilan'` and add a row to `shared.memory_history`. Entries Sabah owns are hers:
agents ask instead of overwriting (`src/domain/memory.ts`).

## Develop

```bash
npm install
npm run dev        # builds the UI, starts the server with reload (needs .env, see .env.example)
npm test           # 65 tests: auth, permissions, worker, audio separation, Claude loop, API, designs, inspiration, morning routine
npm run typecheck
```

Deviations from the handoff: the prototype-only state switcher isn't shipped; real states come from real data.
"Later · not connected" is used for scheduled posts on unconnected channels, plus two honest statuses the
prototype didn't need: **Post by hand** and **Posted by you**.
