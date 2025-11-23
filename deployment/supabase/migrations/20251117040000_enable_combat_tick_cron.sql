-- ============================================================================
-- Enable Combat Tick Scheduled Worker
-- ============================================================================
-- This migration sets up automatic combat round resolution using pg_cron.
-- The combat_tick edge function is called every 5 seconds to process
-- any combat rounds whose deadline has passed.
--
-- Architecture:
-- - Uses pg_cron (PostgreSQL-native cron scheduler)
-- - Uses pg_net (async HTTP client for Postgres)
-- - Works in both local development and production
-- - No external workers or pytest fixtures needed
--
-- Benefits:
-- - Starts automatically with Supabase stack
-- - Same behavior in dev/test/prod
-- - Reliable scheduling (survives crashes)
-- - Database-driven (no external dependencies)
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Grant necessary permissions for HTTP requests
-- pg_net needs to be able to make HTTP requests from the database
GRANT USAGE ON SCHEMA net TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO postgres;
GRANT ALL ON ALL ROUTINES IN SCHEMA net TO postgres;

-- Create a helper function to invoke combat_tick edge function
-- This wraps the HTTP call and handles errors gracefully
CREATE OR REPLACE FUNCTION invoke_combat_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  edge_url TEXT;
  api_token TEXT;
  request_id BIGINT;
BEGIN
  -- Get configuration from environment or use defaults
  -- In production, set these via Supabase secrets
  -- In local dev, these come from .env.supabase
  edge_url := COALESCE(
    current_setting('app.supabase_url', true),
    'http://host.docker.internal:54321'  -- Local Docker default
  ) || '/functions/v1/combat_tick';

  api_token := COALESCE(
    current_setting('app.edge_api_token', true),
    'local-dev-token'  -- Local dev default (matches .env.supabase EDGE_API_TOKEN)
  );

  -- Make async HTTP POST request to combat_tick endpoint
  -- pg_net.http_post returns immediately (doesn't block)
  SELECT net.http_post(
    url := edge_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-api-token', api_token  -- Edge functions expect x-api-token header
    ),
    body := '{}'::jsonb
  ) INTO request_id;

  -- Log the request (optional, for debugging)
  -- RAISE NOTICE 'Combat tick request sent: %', request_id;

EXCEPTION
  WHEN OTHERS THEN
    -- Don't fail the cron job if HTTP request fails
    -- Combat will be retried in next tick (5 seconds)
    RAISE WARNING 'Combat tick HTTP request failed: %', SQLERRM;
END;
$$;

COMMENT ON FUNCTION invoke_combat_tick IS
'Helper function to invoke combat_tick edge function via HTTP. Called by cron job every 5 seconds.';

-- NOTE: Configuration is handled in the function via current_setting() with fallbacks:
-- - Local dev: Uses hardcoded 'http://host.docker.internal:54321' and 'test-token-12345'
-- - Production: Set via Supabase dashboard or ALTER DATABASE (requires superuser):
--   ALTER DATABASE postgres SET app.supabase_url = 'https://your-project.supabase.co';
--   ALTER DATABASE postgres SET app.edge_api_token = 'your-production-token';

-- Schedule the combat tick job
-- Runs every 5 seconds using pg_cron's interval syntax
-- NOTE: pg_cron uses standard 5-field cron format, NOT 6-field with seconds.
-- For sub-minute intervals, use the 'N seconds' interval syntax.
SELECT cron.schedule(
  'combat-tick-worker',           -- Job name (must be unique)
  '5 seconds',                    -- Every 5 seconds (interval syntax)
  $$SELECT invoke_combat_tick();$$ -- SQL to execute
);

-- Alternative schedules (uncomment to use):
-- Every 2 seconds (aggressive): '2 seconds'
-- Every 10 seconds (conservative): '10 seconds'
-- Every 30 seconds: '30 seconds'
-- Every minute (minimal overhead): '* * * * *' or '1 minute'

COMMENT ON EXTENSION pg_cron IS 'Job scheduler for PostgreSQL (used for combat tick worker)';
COMMENT ON EXTENSION pg_net IS 'Async HTTP client for PostgreSQL (used to invoke edge functions)';

-- ============================================================================
-- Verification Queries (run manually to check status)
-- ============================================================================
-- Check if job is scheduled:
-- SELECT * FROM cron.job WHERE jobname = 'combat-tick-worker';
--
-- View recent job runs:
-- SELECT * FROM cron.job_run_details
-- WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker')
-- ORDER BY start_time DESC LIMIT 10;
--
-- Check for HTTP request errors:
-- SELECT * FROM net._http_response
-- WHERE status_code >= 400
-- ORDER BY created DESC LIMIT 10;
--
-- Manually trigger combat tick (testing):
-- SELECT invoke_combat_tick();
-- ============================================================================
