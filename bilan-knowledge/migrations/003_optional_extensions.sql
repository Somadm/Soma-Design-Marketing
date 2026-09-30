-- Optional extensions. Each is enabled only where the database offers it; the app
-- checks at runtime what is present (pgvector for hybrid search, pg_cron for ticks).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'pgvector not enabled: %', SQLERRM;
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE entry_versions ADD COLUMN IF NOT EXISTS embedding vector(1024)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'schedule_in_database') THEN
        PERFORM cron.schedule_in_database('bilan-kb-tick', '*/15 * * * *', 'SELECT kb_tick()', current_database());
      ELSE
        PERFORM cron.schedule('bilan-kb-tick', '*/15 * * * *', 'SELECT kb_tick()');
      END IF;
    EXCEPTION WHEN others THEN
      -- e.g. pg_cron not in shared_preload_libraries, or no permission. The worker ticks instead.
      RAISE NOTICE 'pg_cron not enabled: %', SQLERRM;
    END;
  END IF;
END $$;
