# Handoff: Sagal workspace (Soma app)

## Overview
Sagal is Sabah's creative producer and organic social media manager inside the Soma app. Bilan (paid advertising strategist) shares the app but has a separate workspace. This package covers Sagal only: a conversation-first workspace with live voice, plus planning, carousel and video production, publishing, inspiration, results shared with Bilan, a "Needs Sabah" inbox, and memory/settings.

## About the design files
`Sagal.dc.html` is a **design reference built in HTML**: a working prototype that shows intended look and behaviour. It is not production code. Recreate it in the target codebase's framework and patterns (or pick an appropriate stack, e.g. React + TypeScript, if none exists).

Everything that looks connected is **simulated**: Sagal's replies, voice, HeyGen, Captions, platform publishing, results and account states. The UI labels these with dashed "Simulated" / "Sample" tags. Keep equivalent honesty in production: never show "Published" until the platform confirms it.

## Fidelity
High fidelity for layout, type, colour, copy and states. Recreate closely. Icons are minimal placeholders (text glyphs, one mic SVG); swap in the codebase's icon set.

## Design tokens
Colours
- Ink `#111111` (text, primary buttons, Sagal's mark)
- Paper `#FFFFFF`; Surface `#FAF9F6`; Stone `#F5F3EE` / `#F3F1EC` / `#F1EEE7`; Stone-deep `#EDEAE3`
- Lines `#E6E3DC`, `#EFEDE8`; input borders `#CFCAC0`, `#D9D5CC`; dashed `#8C877E` / `#BDB8AE`
- Secondary text `#4A4843` (≥ 7:1 on white). Never use lighter grey for body text.
- Soma blue `#94ABF9`: selected states, accent buttons, small details. **Always with ink text on top. Never blue text on white.** Tint `#EAF0FF`.
- Status: ok `#E2F2E8`/`#1F5E3B`, warn `#FBEFD5`/`#6B4300`, error `#FBE7E4`/`#9A2318`, neutral `#EDEAE3`/`#4A4843`

Type
- Display: Instrument Serif 400 (titles 40–68px, line-height 1, tracking −0.02em; card titles 24–36px)
- UI: Schibsted Grotesk 400/500/600/700 (body 15–17px / 1.5–1.6; controls 13–14px 600)
- Labels: JetBrains Mono 10.5–11px, uppercase, +0.05em (kickers, timestamps, tags)

Shape and space
- Radii: pills 999px; cards 18–24px; inputs 12px; slide previews 14–16px
- Spacing: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 28 / 32 px; page padding `clamp(16px,3vw,40px)`
- Shadow only on large slide previews: `0 30px 60px -36px rgba(0,0,0,.4)`
- Hit targets ≥ 44px on mobile controls

Identity
- Sagal: black circle, white Instrument Serif "S". Used everywhere until a portrait is approved (Memory → Sagal's appearance has an image slot + brief).
- Bilan: black rounded square, white bold "B" (square vs circle keeps the two agents distinct at a glance).
- Sabah: blue circle "Sa" where ownership is shown.

## App shell
- Desktop: left nav 236px (`#FAF9F6`, right border) → main.
  - Top of nav: "Soma" wordmark, Sagal | Bilan workspace switch (segmented pill), role line.
  - Nav items (active = blue fill, weight 600). "Needs Sabah" shows an ink count badge.
  - Under "Talk to Sagal" (when active): "+ New conversation" and conversations grouped by project.
  - Footer: prototype state switcher (Live / Empty / Loading / Disconnected / Failed / Success — prototype only, remove in production) and "Sabah · Europe/Helsinki · HH:MM".
- < 880px (mobile): nav becomes an off-canvas drawer (Menu button in a top bar). On Talk, a segmented control switches **Chat** ↔ **Current work · {tab}**.
- 880–1180px: workspace panel opens full-width over the chat with a "Back to chat" button.

## Screens

### 1. Talk to Sagal (primary)
Three columns on desktop ≥1180: nav | conversation (flex) | workspace (`clamp(380px,38vw,560px)`, expandable to full width).

Conversation header: project kicker (mono) + thread title (serif 24–32px), "Sample conversation" tag, Show/Hide workspace.

Messages (max-width 720px, 28px gap)
- Sagal: no bubble. 30px S mark, name + mono time, text 17/1.6. Optional: quote block (Stone, serif 24–30px), carousel card (3 slide minis + title + "Open on the right ↗"), other cards (week/idea/script), decision chips (pills, picked = blue), inbox list.
- Sabah: right-aligned Stone bubble (20/20/6/20 radius), optional "Re: Slide 3 · The question" context chip (blue tint), voice-note pill (play button, waveform, duration, transcript), attachment chips, status line ("Not sent" + Retry; "Queued, sends when Sagal reconnects").
- Typing: three blinking dots + "Sagal is thinking (constructively)".

Empty state (new conversation): 64px mark, "Hi Sabah. *What are we making?*", four starter cards: "Let's plan this week." / "I have an idea—help me develop it." / "Turn this project into a story." / "Show me what needs my input."

Composer: context chip (removable), attachment chips, textarea (Enter sends, Shift+Enter newline), **+ Attach** (menu: Image, PDF, Footage, Audio — note Audio is references, *not* Sabah's voiceover), **Voice note** (records → timer, Discard / Send voice note), **Talk live** (starts voice), **Send** (blue when there is content).

Workspace panel tabs: Carousel · Script · Idea · This week.
- Carousel: 4:5 slide preview, ‹ › nav, "Slide n · Role", 7-thumb strip, **Discuss slide n** (puts a context chip in the composer and returns to chat), Open in Carousel studio.
- Script: status band ("Waiting for Sabah's voiceover"), timed lines, separation note, link to Video studio.
- Idea: title, story, audience/purpose/platforms, Sagal's three questions.
- This week: day list with posts and status pills; "Nothing. On purpose." for empty days.

### 2. Voice conversation (replaces composer while active)
Orb (76px S mark) + state title (serif 28–38px) + one-line plain-language hint.
States and visuals:
- **Listening**: blue ring pulsing outward (1.8s). Hint: Sagal waits for a natural pause.
- **Processing**: dashed ink ring rotating. "Thinking…"
- **Speaking**: solid 4px blue ring + 5 ink bars (scaleY animation, speed follows playback speed). "Stop Sagal" becomes active (blue).
- **Reconnecting**: grey mark, dashed grey ring rotating; keeps what was said; typing still works.
- **Microphone unavailable**: grey mark with × badge; actions "Try the microphone again" / "Keep typing instead".
- **Muted**: × badge, no pulse, "You're muted".
Controls (44px pills): Mute mic, Stop Sagal (interrupt), Transcript on/off, Speed (0.9× / 1.0× / 1.15× / 1.3×), Voice select, Type instead, End conversation. Live transcript card shows both speakers; interrupted lines are cut with "… (interrupted)". Every completed turn is appended to the thread with "· spoken".
Prototype-only row: "Simulate: I've finished talking" and state chips.

### 3. Test Sagal's voice
Header + honest notice ("Not Sagal's voice yet": playback uses the browser's speech synthesis only for wording/pacing). Three provider cards (Recommended, Lower cost, Evaluated). English and Somali phrase cards: play, rating chips (Too fast / Right pace / Too flat / Love it), per-phrase note, and an overall feedback box → "Save feedback to Memory". Somali phrases were drafted by Claude and must be checked by a native speaker before testing.

### 4. Plan together
7-day agreed plan (today tinted blue) with idea cards (format, title, platforms, "Back to the board"). Idea board: cards with story, audience, purpose, format, platform chips, day select, **Move into the plan**, Develop with Sagal. Copy explains that moving into the plan authorises production and publishing within the chosen mode.

### 5. Carousel studio
Story-progression bar (7 segments: Hook, Context, Question, Process, Decision, Trade-off, Close; past = blue, current = ink). Grid ≥1200: thumbnail navigator 104px (comment count badges) | large preview | editor 360px. Below 1200: single column, horizontal navigator.
Preview crops: **4:5** 1080×1350, **1:1** 1080×1080, **9:16** 1080×1920 (platform-UI zones shaded top 13% / bottom 21%). Text-safe area: dashed blue inset with a label. Type scales via container query units.
Editor: headline, supporting line, kicker, story role, visual note, look (Ink / Paper / Soma blue / Stone), per-slide comments, per-platform captions (Instagram 2,200, Facebook 63,206, TikTok 4,000 character counters).
Sample story: "The one-sentence homepage", a design decision told without client outcomes.

### 6. Video studio
Status pill "Waiting for Sabah's voiceover" → "Voiceover received". Six-step pipeline with status chips. **Upload Sabah's voiceover** card (2px ink border, "Production asset · your own voice", "Not Sagal's voice"). Script. HeyGen card and Captions card each with honest states: connected-waiting, ready, rendering, rendered, failed, disconnected, **manual handoff** (file list + steps + "I've made it / uploaded it"). Cover + platform captions (YouTube Shorts: later).

### 7. Publishing calendar
Title + **Pause all publishing** (ink; becomes blue "Resume publishing" with an explanatory banner). Authorisation summary (mode, channels, scope, spend limit) linking to permissions. Platform filters (YouTube Shorts marked later). Status legend. Week grid; selected post detail: platform preview, account, time "Thursday 1 Oct, 12:30 · Europe/Helsinki", format, Sagal's note, actions (Retry, Hold, Resume, Approve in review mode).
Statuses: **Scheduled** (blue tint), **Publishing…** (amber), **Published · confirmed** (green, only after platform confirmation), **Failed** (red, with reason and next step), **Paused** (neutral), **Later · not connected**.

### 8. Inspiration
Filter: Brooklyn / New York, Somali / diaspora. Cards: image slot, category, "Reference only", title, source line, "What Sagal noticed", "Original Soma idea", Develop with Sagal. Private items (e.g. family archive) are marked "don't post".

### 9. Results & Bilan
Four organic metrics (sample), three lessons with evidence (including "Still guessing"). Shared task list with filters (Brief from Bilan / Asset prepared / Proposed for paid), each row: type, title, evidence, owner mark + next step, status pill; proposed items that need Sabah get "Send to Bilan" / "Keep organic".

### 10. Needs Sabah
Title counts items in words ("Five things need you."). Cards: kind (Missing audio, Decision, Outside the plan, Production problem, Publishing failed), due, serif title, Sagal's plain-language explanation, primary action, secondary, "Talk it through". Handled list records the choice and time.

### 11. Memory & settings
Sub-nav: Business facts (editable), Brand assets (image slots + palette), Approved language (say / not), Creative preferences, Voice (voice, speed, transcript, turn length, interrupting; conversational audio vs voiceover explanation), Connected accounts (status + reconnect), Notifications (switches; quiet hours 21:00–08:00 Helsinki, failures break through), Publishing permissions (mode cards, channel switches, content scope, € monthly production spend limit, "Always comes back to you" list), Sagal's appearance (pending approval).

## Autonomy model
- **Publish within an approved plan** (default): Sagal produces and publishes items in the agreed weekly plan on authorised channels without asking again.
- **Review each finished post**: nothing publishes until Sabah approves it in Publishing.
- Always returns to Sabah: new topic / unplanned post, moving a post more than a day, a new platform, new use of Sabah's likeness or voice, spend over limit, public replies to criticism.
- Store authorisations as explicit records (channels, scope, spend limit, mode, who/when) and check them server-side before every publish or spend action.

## Voice architecture (recommendation)
Research checked 30 September 2026. Re-check prices before build.

**Keep Claude as the reasoning system.** The speech layer only listens, handles turn-taking and speaks.

1. **Preferred: ElevenLabs Agents (ElevenAgents) + Claude.**
   - Cascaded pipeline: speech-to-text → LLM → text-to-speech, plus ElevenLabs' turn-taking model and interruption handling. Not speech-to-speech.
   - Claude is selectable as the agent's LLM (Claude models are listed in their docs), or point the agent at a **Custom LLM** endpoint (OpenAI-compatible Chat Completions/Responses format). Recommended: Custom LLM → your own server that calls Claude, so Sagal's memory, tools and permissions live in your backend and the voice layer never reasons on its own.
   - Somali: listed for Eleven v3/v4 TTS and Scribe STT. Scribe's own accuracy table puts Somali in the "moderate" band (>25–50% WER). **Documented, but quality must be tested**, especially recognition.
   - Price: $0.08 per agent minute on all self-serve plans (lowered recently); LLM usage billed separately. Source: elevenlabs.io/pricing and their pricing-change post.
   - Latency: TTS model inference is marketed at ~75ms (Flash v2.5); with Claude in the loop, expect roughly 1–2 s to first audio. This is an estimate; measure it.
   - Separate service: ElevenLabs account + your Claude proxy server.
2. **Lower cost: Azure Speech (STT + neural TTS) + Claude, orchestrated by you.**
   - Dedicated Somali voices `so-SO-UbaxNeural` (female) and `so-SO-MuuseNeural` (male). Confirm Somali STT locale support before committing.
   - Roughly $16 per 1M characters (prebuilt neural TTS) and ~$1 per audio hour (standard STT). These figures come from third-party summaries; confirm with the Azure pricing calculator.
   - You must build voice activity detection, turn-taking and barge-in yourself. Less expressive than ElevenLabs.
3. **Evaluated: live speech-to-speech model (e.g. OpenAI gpt-realtime).** Best natural turn-taking and lowest latency, but the speech model does the reasoning. That replaces Claude, so it is not recommended as Sagal's brain. Price reference: $32 / $64 per 1M audio input / output tokens (openai.com/api/pricing).

Voice behaviour spec: warm, expressive, witty, subtle New York character (no exaggerated accent). Turns ≤ ~20 s unless asked. Stop immediately on user speech (barge-in). Say "I'll stop there" style handovers.

**Audio separation (hard rule):** "Talk to Sagal" audio is conversational and ephemeral. "Sabah's voiceover" is an uploaded production asset stored in a separate bucket/table with its own type. HeyGen jobs may only reference `voiceover` assets uploaded by Sabah. There is no code path that sends Sagal TTS audio to HeyGen, and no voice cloning of Sabah.

## State management (suggested)
- `conversation`: id, projectId, title, messages[] (from, text, attachments[], context {type: slide|idea|post, id}, via: text|voice|voice_note, status: sending|sent|queued|failed)
- `voiceSession`: status (idle|connecting|listening|processing|speaking|reconnecting|mic_unavailable), muted, transcriptOn, speed, voiceId, liveTranscript[]
- `workspace`: open, expanded, tab, focused item
- `carousel`: slides[] (role, kicker, headline, body, visual, theme), comments by slide, captions by platform, crop, safeAreaOn
- `videoJob`: script, voiceoverAssetId, heygen {state, jobId, error}, captions {state, manual}, cover, platformCaptions
- `post`: platform, accountId, scheduledAt (UTC, displayed in Europe/Helsinki), status (scheduled|publishing|confirmed|failed|paused), privateUntilAudit (YouTube/TikTok), platformPostId, error, approvedBy
- `publishingSettings`: mode, channels, scope, spendLimitEUR, paused
- `inboxItem`: kind, due, title, body, actions, resolution
- `sharedTask` (with Bilan): type, title, status, owner, evidence, next

## Persistence and shared memory
- Conversations persisted server-side, grouped by project, resumable on any device.
- Memory store shared by Sagal and Bilan (business facts, brand assets, approved language, preferences), with per-field ownership and edit history. Retrieve into Claude's context per turn; don't rely on the voice provider's knowledge base.
- Voice turns written to the same conversation as text.

## Integrations and honest states
Channels: Instagram, Facebook, TikTok, YouTube Shorts, LinkedIn. Show "confirmed" only on platform confirmation or webhook.

| Service | Connection | What Sabah sets up | Gate to know about |
| --- | --- | --- | --- |
| Instagram | Meta Graph API, `instagram_business_content_publish` | Professional (Business/Creator) account linked to the Facebook Page; Meta developer app | Own accounts work with a tester/developer role; App Review only for accounts you don't own |
| Facebook Page | Meta Graph API (Pages) | Same Meta app; admin of the Page | Same as above |
| TikTok | Content Posting API, `video.publish` | TikTok developer app | Unaudited apps post private-only. Use **Upload as draft** until the audit passes |
| YouTube Shorts | YouTube Data API v3 `videos.insert`, `youtube.upload` scope (no separate Shorts endpoint; vertical ≤ 60s + #Shorts) | Google Cloud project, OAuth consent screen, YouTube channel | Unverified projects upload **private-only** until Google's compliance audit; default 100 uploads/day |
| LinkedIn (personal) | Posts API, `w_member_social` via self-serve "Share on LinkedIn" | LinkedIn developer app associated with a LinkedIn Page, privacy policy URL | No review for posting as yourself. Carousels go out as PDF document posts |
| LinkedIn (company page) | Community Management API, `w_organization_social` | Page admin role, verified organisation | Partner approval, weeks to months |
| HeyGen | API key, pay-as-you-go wallet (separate from the web plan) | API key + top-up | Only Sabah's uploaded voiceover may be sent |
| Captions (Mirage) | API key (`x-api-key`) | API key | Use captioning only; never Mirage's generated voices or avatars |

Build order: server + private storage + token vault → HeyGen and Captions → Instagram/Facebook → LinkedIn (personal) → YouTube Shorts and TikTok in private/draft mode → public once their audits pass. Keys are added by Sabah at the end into the server's secret store; the app must run end-to-end with every integration in "not connected / manual handoff" state first.
- HeyGen (avatar video from Sabah's voiceover + script). Captions (editing). Both need a **manual handoff** path: package files, steps, "mark done", upload result.
- Retries are scheduled at the next agreed slot, never immediately, and never outside the plan.

## Auth, storage, permissions
- Single-owner auth for Sabah (passkey/OAuth); Bilan and Sagal act as service identities with scoped permissions.
- Private media storage (signed URLs, no public buckets). Voiceovers and private references (e.g. family archive) are flagged not-for-publish unless approved.
- Microphone: request permission only on "Talk live" or "Voice note". Handle denied / no device / revoked mid-call with the "Microphone unavailable" state; typing always works.
- Platform tokens stored server-side, encrypted; reconnect flows surface in Needs Sabah.

## Unresolved / to test
- Somali recognition and speech quality (ElevenLabs and Azure), with native-speaker review.
- Real end-to-end voice latency with Claude.
- Whether ElevenLabs' Somali support extends to the agent runtime (their agent docs list fewer languages than their TTS docs).
- Sagal's portrait (pending approval; placeholder slot + brief in Memory).
- Soma's real business facts, handles and brand assets (sample values in prototype).

## Files
- `Sagal.dc.html`: the full prototype (all screens and states)
- `image-slot.js`: image placeholder component used by the prototype
