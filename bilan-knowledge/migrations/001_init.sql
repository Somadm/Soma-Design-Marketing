-- Bilan advertising knowledge base: initial schema.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A monitored page on an official Meta or TikTok property.
CREATE TABLE sources (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  category TEXT NOT NULL DEFAULT 'help'
    CHECK (category IN ('policy', 'help', 'api', 'announcement', 'other')),
  origin TEXT NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'discovered', 'live_check', 'manual')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- active: being monitored; discontinued: confirmed removed by the publisher.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discontinued')),
  consecutive_misses INT NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  last_check_status TEXT,
  last_error TEXT,
  last_verified_at TIMESTAMPTZ,   -- last time content was actually retrieved and confirmed
  current_version_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every distinct retrieved version of a source page (full version history).
CREATE TABLE source_versions (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  content_text TEXT NOT NULL,
  final_url TEXT NOT NULL,
  fetched_via TEXT NOT NULL CHECK (fetched_via IN ('direct', 'claude_web_fetch')),
  page_summary TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id BIGINT
);
CREATE INDEX source_versions_source_idx ON source_versions (source_id, first_seen_at DESC);

ALTER TABLE sources
  ADD CONSTRAINT sources_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES source_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- A refresh execution (initial, scheduled, manual, or a single-source live check).
CREATE TABLE refresh_runs (
  id BIGSERIAL PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('initial', 'scheduled', 'retry', 'manual', 'live_check')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'incomplete', 'failed')),
  requested_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  worker_id TEXT,
  sources_total INT NOT NULL DEFAULT 0,
  sources_checked INT NOT NULL DEFAULT 0,
  sources_unchanged INT NOT NULL DEFAULT 0,
  sources_changed INT NOT NULL DEFAULT 0,
  sources_new INT NOT NULL DEFAULT 0,
  sources_discontinued INT NOT NULL DEFAULT 0,
  sources_failed INT NOT NULL DEFAULT 0,
  items_added INT NOT NULL DEFAULT 0,
  items_archived INT NOT NULL DEFAULT 0,
  spend_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  error TEXT,
  briefing_id BIGINT
);

-- Duplicate-job prevention: at most one full refresh may be queued or running at a time.
CREATE UNIQUE INDEX refresh_runs_one_active
  ON refresh_runs ((true))
  WHERE status IN ('queued', 'running') AND trigger <> 'live_check';

CREATE INDEX refresh_runs_created_idx ON refresh_runs (created_at DESC);

-- Per-source outcome within a run ("sources checked and sources that failed").
CREATE TABLE source_checks (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('unchanged', 'changed', 'new', 'discontinued', 'missing', 'failed', 'skipped')),
  http_status INT,
  attempts INT NOT NULL DEFAULT 0,
  fetched_via TEXT,
  error TEXT,
  version_id BIGINT REFERENCES source_versions(id),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX source_checks_run_idx ON source_checks (run_id);

-- A unit of advertising guidance extracted from a source version.
CREATE TABLE knowledge_items (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_version_id BIGINT NOT NULL REFERENCES source_versions(id),
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  guidance TEXT NOT NULL,
  regions TEXT[] NOT NULL DEFAULT '{}',
  account_scope TEXT,
  rollout_status TEXT,
  limitations TEXT,
  effective_date TEXT,
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'archived')),
  archived_reason TEXT,
  archived_at TIMESTAMPTZ,
  superseded_by BIGINT REFERENCES knowledge_items(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_run_id BIGINT,
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(topic, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(guidance, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(limitations, '')), 'D')
  ) STORED
);
CREATE INDEX knowledge_items_search_idx ON knowledge_items USING GIN (search_tsv);
CREATE INDEX knowledge_items_current_idx ON knowledge_items (platform, status);
CREATE INDEX knowledge_items_source_idx ON knowledge_items (source_id, status);

-- Detected changes (what the briefing is built from).
CREATE TABLE knowledge_changes (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok')),
  source_id BIGINT REFERENCES sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'changed', 'discontinued')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  -- Relevance to Creative Academy's campaigns (from the campaign profile).
  relevance TEXT NOT NULL DEFAULT 'medium' CHECK (relevance IN ('high', 'medium', 'low', 'none')),
  relevance_note TEXT,
  item_id BIGINT REFERENCES knowledge_items(id),
  previous_item_id BIGINT REFERENCES knowledge_items(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_changes_run_idx ON knowledge_changes (run_id);

CREATE TABLE briefings (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  complete BOOLEAN NOT NULL,
  body_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Execution logs.
CREATE TABLE run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES refresh_runs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX run_logs_run_idx ON run_logs (run_id, id);

-- Every paid API call, for spending limits and reporting.
CREATE TABLE spend_ledger (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES refresh_runs(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cache_read_tokens INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  web_searches INT NOT NULL DEFAULT 0,
  usd NUMERIC(12, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX spend_ledger_created_idx ON spend_ledger (created_at);

-- Key/value settings (campaign profile, scheduler heartbeat).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
