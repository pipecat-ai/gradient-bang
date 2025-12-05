-- =============================================================================
-- Update invoke_combat_tick to include Supabase auth headers (anon key)
-- =============================================================================
CREATE OR REPLACE FUNCTION invoke_combat_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  base_url TEXT;
  api_token TEXT;
  anon_key TEXT;
  request_id BIGINT;
  env_hint TEXT;
BEGIN
  SELECT value INTO base_url FROM app_runtime_config WHERE key = 'supabase_url';
  SELECT value INTO api_token FROM app_runtime_config WHERE key = 'edge_api_token';
  SELECT value INTO anon_key FROM app_runtime_config WHERE key = 'supabase_anon_key';
  env_hint := current_setting('app.environment', true);

  IF base_url IS NULL OR api_token IS NULL THEN
    IF env_hint IN ('dev', 'test', 'local') THEN
      base_url := COALESCE(base_url, 'http://host.docker.internal:54321');
      api_token := COALESCE(api_token, 'local-dev-token');
      anon_key := COALESCE(anon_key, 'anon-key');
      RAISE NOTICE 'invoke_combat_tick(): missing config rows, using dev defaults (env=%)', env_hint;
    ELSE
      RAISE EXCEPTION 'invoke_combat_tick(): app_runtime_config missing supabase_url or edge_api_token';
    END IF;
  END IF;

  IF anon_key IS NULL THEN
    IF env_hint IN ('dev', 'test', 'local') THEN
      anon_key := 'anon-key';
    ELSE
      RAISE EXCEPTION 'invoke_combat_tick(): app_runtime_config missing supabase_anon_key';
    END IF;
  END IF;

  base_url := rtrim(base_url, '/') || '/functions/v1/combat_tick';

  SELECT net.http_post(
    url := base_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-api-token', api_token,
      'Authorization', concat('Bearer ', anon_key),
      'apikey', anon_key
    ),
    body := '{}'::jsonb
  ) INTO request_id;

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Combat tick HTTP request failed: %', SQLERRM;
END;
$$;

COMMENT ON FUNCTION invoke_combat_tick IS 'Helper that calls combat_tick edge function via pg_net; reads config from app_runtime_config (url, edge_api_token, supabase_anon_key).';
