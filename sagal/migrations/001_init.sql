-- Sagal lives in its own schema so it can share one Postgres database with Bilan
-- (Bilan uses `public`). Anything both agents read lives in `shared`.
-- All timestamps are TIMESTAMPTZ (stored as UTC); the UI shows Europe/Helsinki.

CREATE SCHEMA IF NOT EXISTS sagal;
CREATE SCHEMA IF NOT EXISTS shared;

-- ───────────────────────── Shared with Bilan ─────────────────────────

-- Business facts, approved language, creative preferences, notes, voice feedback.
-- `owner` is who may change an entry without asking: Sabah owns what she typed,
-- Sagal and Bilan own what they wrote. Every change is kept in memory_history.
CREATE TABLE shared.memory_entries (
  id          BIGSERIAL PRIMARY KEY,
  section     TEXT NOT NULL CHECK (section IN ('facts','language','preferences','notes','voice_feedback')),
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  owner       TEXT NOT NULL CHECK (owner IN ('sabah','sagal','bilan')),
  updated_by  TEXT NOT NULL CHECK (updated_by IN ('sabah','sagal','bilan')),
  sample      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (section, key)
);

CREATE TABLE shared.memory_history (
  id          BIGSERIAL PRIMARY KEY,
  entry_id    BIGINT,
  section     TEXT NOT NULL,
  key         TEXT NOT NULL,
  old_value   JSONB,
  new_value   JSONB,
  changed_by  TEXT NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Work passed between Sagal and Bilan (briefs, prepared assets, posts proposed for paid).
CREATE TABLE shared.tasks (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('Brief from Bilan','Asset prepared','Proposed for paid')),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  owner       TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '',
  next_step   TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  sample      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Auth (single owner) ─────────────────────────

CREATE TABLE sagal.owner (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  verified_at    TIMESTAMPTZ,
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.email_codes (
  id           TEXT PRIMARY KEY,
  purpose      TEXT NOT NULL CHECK (purpose IN ('verify','login','reset')),
  code_hash    TEXT NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.sessions (
  token_hash    TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent    TEXT
);

-- ───────────────────────── Secrets and connections ─────────────────────────

-- API keys and OAuth tokens, encrypted with AES-256-GCM (key: SECRETS_MASTER_KEY).
CREATE TABLE sagal.secrets (
  name        TEXT PRIMARY KEY,
  ciphertext  BYTEA NOT NULL,
  iv          BYTEA NOT NULL,
  tag         BYTEA NOT NULL,
  hint        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.integrations (
  service        TEXT PRIMARY KEY,
  state          TEXT NOT NULL DEFAULT 'not_connected'
                 CHECK (state IN ('not_connected','credentials_saved','connected','needs_reconnect')),
  account_label  TEXT,
  connected_at   TIMESTAMPTZ,
  last_error     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.oauth_states (
  state          TEXT PRIMARY KEY,
  service        TEXT NOT NULL,
  code_verifier  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Media ─────────────────────────

-- Everything uploaded EXCEPT Sabah's voiceovers. `conversation_audio` is Talk-to-Sagal
-- audio (voice notes): conversational, never a production asset.
CREATE TABLE sagal.media_assets (
  id               BIGSERIAL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN
                   ('image','pdf','footage','audio_reference','conversation_audio','brand','portrait','inspiration','render','export')),
  storage_key      TEXT NOT NULL UNIQUE,
  filename         TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL,
  label            TEXT,
  do_not_publish   BOOLEAN NOT NULL DEFAULT false,
  uploaded_by      TEXT NOT NULL DEFAULT 'sabah',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sabah's own recorded voiceovers: a separate table and storage area. HeyGen jobs may
-- only reference rows from here. Not-for-publish until used in an approved video.
CREATE TABLE sagal.voiceovers (
  id            BIGSERIAL PRIMARY KEY,
  storage_key   TEXT NOT NULL UNIQUE CHECK (storage_key LIKE 'voiceovers/%'),
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL CHECK (content_type LIKE 'audio/%'),
  size_bytes    BIGINT NOT NULL,
  uploaded_by   TEXT NOT NULL DEFAULT 'sabah' CHECK (uploaded_by = 'sabah'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Conversations ─────────────────────────

CREATE TABLE sagal.projects (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.conversations (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES sagal.projects(id),
  title       TEXT NOT NULL DEFAULT 'New conversation',
  sample      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES sagal.conversations(id) ON DELETE CASCADE,
  sender           TEXT NOT NULL CHECK (sender IN ('sabah','sagal','system')),
  text             TEXT NOT NULL DEFAULT '',
  via              TEXT NOT NULL DEFAULT 'text' CHECK (via IN ('text','voice','voice_note')),
  context          JSONB,          -- {type: slide|idea|post|inbox|reference, id, label}
  attachments      JSONB NOT NULL DEFAULT '[]',  -- [{assetId, kind, name}]
  voice_note_id    BIGINT REFERENCES sagal.media_assets(id),
  card             JSONB,          -- {type: carousel|idea|week|script, id, title, sub}
  quote            TEXT,
  decision         JSONB,          -- {options: [...], picked}
  status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error            TEXT,
  interrupted      BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON sagal.messages (conversation_id, id);

-- ───────────────────────── Planning and production ─────────────────────────

CREATE TABLE sagal.ideas (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  story       TEXT NOT NULL DEFAULT '',
  audience    TEXT NOT NULL DEFAULT '',
  purpose     TEXT NOT NULL DEFAULT '',
  format      TEXT NOT NULL DEFAULT 'Carousel',
  platforms   TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'board' CHECK (status IN ('board','agreed')),
  plan_date   DATE,          -- Helsinki calendar date when agreed
  agreed_at   TIMESTAMPTZ,
  created_by  TEXT NOT NULL DEFAULT 'sagal',
  sample      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.carousels (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  project     TEXT NOT NULL DEFAULT '',
  idea_id     BIGINT REFERENCES sagal.ideas(id) ON DELETE SET NULL,
  draft       INT NOT NULL DEFAULT 1,
  slides      JSONB NOT NULL DEFAULT '[]',   -- [{role,kicker,head,body,visual,theme}]
  captions    JSONB NOT NULL DEFAULT '{}',   -- {Instagram: "...", ...}
  sample      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.slide_comments (
  id           BIGSERIAL PRIMARY KEY,
  carousel_id  BIGINT NOT NULL REFERENCES sagal.carousels(id) ON DELETE CASCADE,
  slide_index  INT NOT NULL,
  who          TEXT NOT NULL CHECK (who IN ('sabah','sagal')),
  text         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.video_jobs (
  id                 BIGSERIAL PRIMARY KEY,
  title              TEXT NOT NULL,
  idea_id            BIGINT REFERENCES sagal.ideas(id) ON DELETE SET NULL,
  script             JSONB NOT NULL DEFAULT '[]',  -- [{t, part, line}]
  script_status      TEXT NOT NULL DEFAULT 'Draft',
  voiceover_id       BIGINT REFERENCES sagal.voiceovers(id) ON DELETE SET NULL,
  heygen             JSONB NOT NULL DEFAULT '{"state":"waiting"}',
  captions_edit      JSONB NOT NULL DEFAULT '{"state":"waiting"}',
  render_asset_id    BIGINT REFERENCES sagal.media_assets(id) ON DELETE SET NULL,
  final_asset_id     BIGINT REFERENCES sagal.media_assets(id) ON DELETE SET NULL,
  platform_captions  JSONB NOT NULL DEFAULT '{}',
  due_at             TIMESTAMPTZ,
  sample             BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Publishing ─────────────────────────

-- Explicit, append-only authorisation records. The newest row is in force.
-- The server checks it before every publish or spend action.
CREATE TABLE sagal.authorisations (
  id               BIGSERIAL PRIMARY KEY,
  mode             TEXT NOT NULL CHECK (mode IN ('plan','review')),
  channels         TEXT[] NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'agreed_plan_only',
  spend_limit_eur  NUMERIC(10,2) NOT NULL CHECK (spend_limit_eur >= 0),
  paused           BOOLEAN NOT NULL DEFAULT false,
  granted_by       TEXT NOT NULL DEFAULT 'sabah',
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  note             TEXT
);

CREATE TABLE sagal.posts (
  id                   BIGSERIAL PRIMARY KEY,
  idea_id              BIGINT REFERENCES sagal.ideas(id) ON DELETE SET NULL,
  platform             TEXT NOT NULL CHECK (platform IN ('Instagram','Facebook','TikTok','YouTube Shorts','LinkedIn')),
  account_label        TEXT NOT NULL DEFAULT '',
  title                TEXT NOT NULL,
  format               TEXT NOT NULL DEFAULT '',
  kind                 TEXT NOT NULL DEFAULT 'carousel' CHECK (kind IN ('carousel','video','image')),
  caption              TEXT NOT NULL DEFAULT '',
  note                 TEXT NOT NULL DEFAULT '',
  scheduled_at         TIMESTAMPTZ NOT NULL,
  status               TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN
                       ('scheduled','publishing','confirmed','failed','paused','manual','posted_by_hand')),
  held_by_sabah        BOOLEAN NOT NULL DEFAULT false,
  approved_by          TEXT,
  approved_at          TIMESTAMPTZ,
  needs_voiceover_job  BIGINT REFERENCES sagal.video_jobs(id) ON DELETE SET NULL,
  carousel_id          BIGINT REFERENCES sagal.carousels(id) ON DELETE SET NULL,
  platform_post_id     TEXT,
  confirmed_at         TIMESTAMPTZ,
  error                TEXT,
  attempts             INT NOT NULL DEFAULT 0,
  sample               BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX posts_due ON sagal.posts (status, scheduled_at);

-- Every decision the permission guard makes, allowed or not.
CREATE TABLE sagal.permission_checks (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT NOT NULL,           -- publish | spend
  subject     TEXT NOT NULL,
  allowed     BOOLEAN NOT NULL,
  reason      TEXT NOT NULL,
  authorisation_id BIGINT REFERENCES sagal.authorisations(id),
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.spend_ledger (
  id          BIGSERIAL PRIMARY KEY,
  service     TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  amount_eur  NUMERIC(10,2) NOT NULL CHECK (amount_eur >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Inbox, inspiration, results, settings ─────────────────────────

CREATE TABLE sagal.inbox_items (
  id                BIGSERIAL PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN
                    ('Missing audio','Decision','Outside the plan','Production problem','Publishing failed','Approval needed','Reconnect needed','Spend limit')),
  due_label         TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  primary_label     TEXT NOT NULL,
  primary_action    TEXT NOT NULL DEFAULT 'resolve',   -- resolve | go:<screen>[/<tab>]
  secondary_label   TEXT,
  secondary_action  TEXT,
  urgent            BOOLEAN NOT NULL DEFAULT false,
  ref               JSONB NOT NULL DEFAULT '{}',
  dedupe_key        TEXT UNIQUE,
  resolution        TEXT,
  resolved_at       TIMESTAMPTZ,
  notified_at       TIMESTAMPTZ,
  created_by        TEXT NOT NULL DEFAULT 'sagal',
  sample            BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.inspiration (
  id              BIGSERIAL PRIMARY KEY,
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT '',
  noticed         TEXT NOT NULL DEFAULT '',
  idea            TEXT NOT NULL DEFAULT '',
  private         BOOLEAN NOT NULL DEFAULT false,   -- "don't post"
  image_asset_id  BIGINT REFERENCES sagal.media_assets(id) ON DELETE SET NULL,
  sample          BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.lessons (
  id          BIGSERIAL PRIMARY KEY,
  kicker      TEXT NOT NULL,
  title       TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '',
  sample      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sagal.settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defaults: everything starts not connected, publishing within the approved plan.
INSERT INTO sagal.authorisations (mode, channels, spend_limit_eur, paused, granted_by, note)
VALUES ('plan', ARRAY['Instagram','Facebook','TikTok','YouTube Shorts','LinkedIn'], 40, false, 'sabah', 'Default when the app was installed');

INSERT INTO sagal.integrations (service) VALUES
  ('anthropic'), ('email'), ('heygen'), ('captions'), ('meta'), ('linkedin'), ('youtube'), ('tiktok');

INSERT INTO sagal.projects (name) VALUES ('Unsorted');
