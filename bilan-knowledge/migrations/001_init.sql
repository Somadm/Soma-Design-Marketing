-- Bilan · Knowledge updates: schema (see docs/DESIGN_HANDOFF.md §2).

CREATE TABLE settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  interval_days INT NOT NULL DEFAULT 42,              -- fixed in the UI; editable only for staging tests
  run_window_utc TIME NOT NULL DEFAULT '03:00',
  run_window_hours INT NOT NULL DEFAULT 3 CHECK (run_window_hours BETWEEN 1 AND 24),
  retries INT NOT NULL DEFAULT 3 CHECK (retries BETWEEN 1 AND 6),
  backoff_minutes INT[] NOT NULL DEFAULT '{2,10,30}',
  budget_refresh_usd NUMERIC(8,2) NOT NULL DEFAULT 5,
  budget_initial_usd NUMERIC(8,2) NOT NULL DEFAULT 15,
  budget_live_month_usd NUMERIC(8,2) NOT NULL DEFAULT 5,
  on_limit TEXT NOT NULL DEFAULT 'stop' CHECK (on_limit IN ('stop', 'finish')),
  alert_email TEXT,
  auto_initial BOOLEAN NOT NULL DEFAULT true,
  campaign_profile TEXT NOT NULL DEFAULT
    'Creative Academy sells a paid Skool membership. Audience: Somali-speaking beginners, creators and business owners. '
    'Topics: graphic design, branding, AI content, vibe coding. Goals: membership sign-ups and retention. '
    'Creative: vertical video, founder-led demos, statics, carousels. Platforms: Meta (Facebook, Instagram) and TikTok.',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings DEFAULT VALUES;

CREATE TABLE system_status (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_success_run BIGINT,
  last_success_at TIMESTAMPTZ,
  schedule_verified_at TIMESTAMPTZ,       -- set ONLY when a trigger='scheduled' run completes on the deployed backend
  failure_path_verified_at TIMESTAMPTZ,   -- set when an incomplete run is finalised on the deployed backend
  deployed_at TIMESTAMPTZ,                -- first check-in of a production worker
  worker_seen_at TIMESTAMPTZ,
  worker_id TEXT,
  worker_deployed BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO system_status DEFAULT VALUES;

CREATE TABLE sources (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('policy', 'help_centre', 'api_docs', 'announcements')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discontinued', 'paused')),
  fetch_mode TEXT NOT NULL DEFAULT 'direct' CHECK (fetch_mode IN ('direct', 'rendered')),
  origin TEXT NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'discovered', 'redirect', 'live_check', 'manual')),
  consecutive_failures INT NOT NULL DEFAULT 0,
  escalated_at TIMESTAMPTZ,
  replaced_by BIGINT REFERENCES sources(id),
  current_version_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  discontinued_at TIMESTAMPTZ
);

CREATE TABLE source_versions (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version INT NOT NULL,
  content_hash TEXT NOT NULL,
  normalised_text TEXT NOT NULL,
  final_url TEXT NOT NULL,
  fetched_via TEXT NOT NULL CHECK (fetched_via IN ('direct', 'rendered', 'claude_web_fetch')),
  fetched_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  run_id BIGINT,
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'discontinued')),
  superseded_at TIMESTAMPTZ,
  UNIQUE (source_id, version)
);
CREATE UNIQUE INDEX one_current_source_version ON source_versions (source_id) WHERE status = 'current';
ALTER TABLE sources ADD CONSTRAINT sources_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES source_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- One piece of guidance. Meta and TikTok never share an entry.
CREATE TABLE entries (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, slug)
);

CREATE TABLE entry_versions (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  version INT NOT NULL,
  source_version_id BIGINT NOT NULL REFERENCES source_versions(id),
  title_cache TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  relevance TEXT,                                   -- "For Creative Academy"
  limitations JSONB NOT NULL DEFAULT '[]',          -- [{kind:'region'|'account'|'rollout'|'placement'|'other', text}]
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'archived')),
  origin TEXT NOT NULL CHECK (origin IN ('refresh', 'live_check')),
  run_id BIGINT,
  verified_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ,
  archived_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title_cache, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED,
  UNIQUE (entry_id, version)
);
CREATE UNIQUE INDEX one_current_per_entry ON entry_versions (entry_id) WHERE status = 'current';
CREATE INDEX entry_versions_tsv ON entry_versions USING GIN (tsv);

CREATE SEQUENCE refresh_code_seq;
CREATE SEQUENCE live_check_code_seq;

CREATE TABLE refresh_runs (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,                        -- R-015, LC-031
  trigger TEXT NOT NULL CHECK (trigger IN ('initial', 'scheduled', 'manual', 'retry', 'live_check')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'incomplete', 'failed', 'cancelled')),
  requested_by TEXT,
  question TEXT,                                    -- live checks: the chat question that triggered it
  result_label TEXT,                                -- live checks: "Verified current", "Saved 1 change"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  worker_id TEXT,
  stage TEXT,
  sources_total INT NOT NULL DEFAULT 0,
  sources_verified INT NOT NULL DEFAULT 0,
  sources_failed INT NOT NULL DEFAULT 0,
  budget_usd NUMERIC(8,2) NOT NULL,
  spend_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  error TEXT,
  incomplete_reason TEXT,                           -- e.g. budget_limit, sources_failed
  note TEXT,
  alert_sent_at TIMESTAMPTZ,
  alert_error TEXT
);
-- Duplicate prevention: at most one active refresh, enforced by the database.
CREATE UNIQUE INDEX one_active_refresh ON refresh_runs ((true))
  WHERE status IN ('queued', 'running') AND trigger <> 'live_check';
CREATE INDEX refresh_runs_created ON refresh_runs (created_at DESC);

CREATE TABLE run_sources (
  run_id BIGINT NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  result TEXT NOT NULL DEFAULT 'pending'
    CHECK (result IN ('pending', 'unchanged', 'cosmetic', 'changed', 'new', 'discontinued', 'failed', 'skipped')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  http_status INT,
  failure_reason TEXT,
  note TEXT,
  fetched_via TEXT,
  staged_source_version JSONB,                      -- held until finalize
  checked_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, source_id)
);

-- What changed, written when staged versions are promoted.
CREATE TABLE changes (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  entry_id BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'changed', 'archived')),
  from_version_id BIGINT REFERENCES entry_versions(id),
  to_version_id BIGINT REFERENCES entry_versions(id),
  what_changed TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX changes_run ON changes (run_id);

CREATE TABLE run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES refresh_runs(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR')),
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB
);
CREATE INDEX run_logs_run ON run_logs (run_id, id);

CREATE TABLE briefings (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL UNIQUE REFERENCES refresh_runs(id) ON DELETE CASCADE,
  partial BOOLEAN NOT NULL,
  summary TEXT NOT NULL,
  body JSONB NOT NULL,                              -- {sections:[{platform, items:[...]}], unverified:[...]}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendations (
  id BIGSERIAL PRIMARY KEY,
  briefing_id BIGINT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'added_to_plan', 'dismissed')),
  decided_at TIMESTAMPTZ
);

CREATE TABLE budget_ledger (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES refresh_runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'voyage', 'firecrawl')),
  purpose TEXT NOT NULL,
  model TEXT,
  units NUMERIC NOT NULL DEFAULT 0,                 -- tokens, credits
  web_searches INT NOT NULL DEFAULT 0,
  usd NUMERIC(10,5) NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX budget_ledger_at ON budget_ledger (at);
