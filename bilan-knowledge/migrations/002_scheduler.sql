-- Durable scheduling lives in Postgres (design handoff §3).
-- kb_tick() is called every 15 minutes by pg_cron when available, and by the worker otherwise.
-- Both are safe together: the one_active_refresh index allows only one active refresh.

-- Queue a refresh. Returns the existing active run instead of creating a duplicate.
-- "manual" becomes "initial" until a complete refresh exists ("Run initial research").
CREATE FUNCTION kb_enqueue(p_trigger TEXT, p_requested_by TEXT)
RETURNS TABLE (run_id BIGINT, run_code TEXT, created BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
  s settings;
  r refresh_runs;
  t TEXT := p_trigger;
BEGIN
  SELECT * INTO s FROM settings WHERE id = 1;
  SELECT * INTO r FROM refresh_runs
    WHERE status IN ('queued', 'running') AND trigger <> 'live_check' ORDER BY id LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT r.id, r.code, false;
    RETURN;
  END IF;
  IF t = 'manual' AND NOT EXISTS (SELECT 1 FROM refresh_runs WHERE status = 'complete' AND trigger <> 'live_check') THEN
    t := 'initial';
  END IF;
  BEGIN
    INSERT INTO refresh_runs (code, trigger, status, requested_by, budget_usd)
    VALUES ('R-' || lpad(nextval('refresh_code_seq')::TEXT, 3, '0'), t, 'queued', p_requested_by,
            CASE WHEN t = 'initial' THEN s.budget_initial_usd ELSE s.budget_refresh_usd END)
    RETURNING * INTO r;
    RETURN QUERY SELECT r.id, r.code, true;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race with a concurrent enqueue (tick or "Update now").
    SELECT * INTO r FROM refresh_runs
      WHERE status IN ('queued', 'running') AND trigger <> 'live_check' ORDER BY id LIMIT 1;
    RETURN QUERY SELECT r.id, r.code, false;
  END;
END $$;

-- Start of the run window that contains p_now (or the most recent one).
CREATE FUNCTION kb_window_start(p_now TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_now >= today THEN today ELSE today - INTERVAL '1 day' END
  FROM (SELECT (date_trunc('day', p_now AT TIME ZONE 'UTC') + s.run_window_utc) AT TIME ZONE 'UTC' AS today
        FROM settings s WHERE id = 1) x
$$;

CREATE FUNCTION kb_tick(p_now TIMESTAMPTZ DEFAULT now())
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  s settings;
  st system_status;
  latest refresh_runs;
  wstart TIMESTAMPTZ;
  in_window BOOLEAN;
  due TIMESTAMPTZ;
  retries_used INT;
  q RECORD;
BEGIN
  SELECT * INTO s FROM settings WHERE id = 1;
  SELECT * INTO st FROM system_status WHERE id = 1;

  -- 1. Recover stuck runs: no log activity for 2 hours -> failed, lock released (alert sent by the worker).
  UPDATE refresh_runs
     SET status = 'failed', finished_at = p_now, stage = 'done',
         error = 'No activity for 2 hours. The run was stopped and the refresh lock released. Last verified versions remain in use.'
   WHERE status = 'running' AND COALESCE(last_activity_at, started_at, created_at) < p_now - INTERVAL '2 hours';

  IF EXISTS (SELECT 1 FROM refresh_runs WHERE status IN ('queued', 'running') AND trigger <> 'live_check') THEN
    RETURN 'refresh already active';
  END IF;

  wstart := kb_window_start(p_now);
  in_window := p_now < wstart + make_interval(hours => s.run_window_hours);
  SELECT * INTO latest FROM refresh_runs WHERE trigger <> 'live_check' ORDER BY id DESC LIMIT 1;

  -- 2. Initial research, when configured.
  IF st.last_success_at IS NULL AND latest.id IS NULL THEN
    IF s.auto_initial THEN
      SELECT * INTO q FROM kb_enqueue('initial', 'scheduler');
      RETURN CASE WHEN q.created THEN 'queued initial research ' ELSE 'refresh already active ' END || q.run_code;
    END IF;
    RETURN 'waiting for initial research';
  END IF;

  -- 3. Retry an incomplete/failed refresh once per day (inside the window) for up to settings.retries days.
  IF latest.status IN ('incomplete', 'failed')
     AND (st.last_success_at IS NULL OR latest.finished_at > st.last_success_at) THEN
    SELECT count(*) INTO retries_used FROM refresh_runs
      WHERE trigger = 'retry' AND created_at > COALESCE(st.last_success_at, '-infinity'::TIMESTAMPTZ);
    IF retries_used < s.retries AND in_window AND latest.created_at < wstart THEN
      SELECT * INTO q FROM kb_enqueue('retry', 'scheduler');
      RETURN CASE WHEN q.created THEN 'queued retry ' ELSE 'refresh already active ' END || q.run_code;
    END IF;
  END IF;

  -- 4. Scheduled refresh: 42 days after the last successful refresh, inside the run window, once.
  IF st.last_success_at IS NOT NULL THEN
    due := st.last_success_at + make_interval(days => s.interval_days);
    IF p_now >= due AND in_window
       AND NOT EXISTS (SELECT 1 FROM refresh_runs WHERE trigger IN ('scheduled', 'retry') AND created_at >= due) THEN
      SELECT * INTO q FROM kb_enqueue('scheduled', 'scheduler');
      RETURN CASE WHEN q.created THEN 'queued scheduled refresh ' ELSE 'refresh already active ' END || q.run_code;
    END IF;
  END IF;

  RETURN 'nothing due';
END $$;
