-- =============================================================================
-- Runtime Config Table + Combat Cron Function (uses config table instead of GUCs)
-- =============================================================================
-- Why: Supabase Cloud disallows ALTER SYSTEM / ALTER DATABASE, so GUC-based
-- config for invoke_combat_tick() fails. This migration introduces a small
-- config table that the cron helper reads instead.
-- =============================================================================

-- Create dedicated runtime config table
CREATE TABLE IF NOT EXISTS app_runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Lock down privileges (adjust owner as needed after migration)
REVOKE ALL ON app_runtime_config FROM PUBLIC;
GRANT SELECT ON app_runtime_config TO postgres;
GRANT SELECT, INSERT, UPDATE ON app_runtime_config TO supabase_admin;

COMMENT ON TABLE app_runtime_config IS 'Key/value runtime config used by Postgres-side helpers (e.g., combat cron).';
COMMENT ON COLUMN app_runtime_config.key IS 'Stable config key (e.g., supabase_url, edge_api_token).';
COMMENT ON COLUMN app_runtime_config.value IS 'Value for the given key (plain text).';

-- Replace invoke_combat_tick to read from app_runtime_config
CREATE OR REPLACE FUNCTION invoke_combat_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  base_url TEXT;
  api_token TEXT;
  request_id BIGINT;
  env_hint TEXT;
BEGIN
  -- Pull config from app_runtime_config
  SELECT value INTO base_url FROM app_runtime_config WHERE key = 'supabase_url';
  SELECT value INTO api_token FROM app_runtime_config WHERE key = 'edge_api_token';
  env_hint := current_setting('app.environment', true);

  IF base_url IS NULL OR api_token IS NULL THEN
    IF env_hint IN ('dev', 'test', 'local') THEN
      base_url := COALESCE(base_url, 'http://host.docker.internal:54321');
      api_token := COALESCE(api_token, 'local-dev-token');
      RAISE NOTICE 'invoke_combat_tick(): missing config rows, using dev defaults (env=%)', env_hint;
    ELSE
      RAISE EXCEPTION 'invoke_combat_tick(): app_runtime_config missing supabase_url or edge_api_token';
    END IF;
  END IF;

  base_url := rtrim(base_url, '/') || '/functions/v1/combat_tick';

  SELECT net.http_post(
    url := base_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-api-token', api_token
    ),
    body := '{}'::jsonb
  ) INTO request_id;

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Combat tick HTTP request failed: %', SQLERRM;
END;
$$;

COMMENT ON FUNCTION invoke_combat_tick IS 'Helper that calls combat_tick edge function via pg_net; reads config from app_runtime_config.';
