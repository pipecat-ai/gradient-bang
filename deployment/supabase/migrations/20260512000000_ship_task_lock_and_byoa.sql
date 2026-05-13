-- BYOA ownership columns + long-lived BYOA token primitive.
--
-- Earlier revisions of this migration also introduced DB-persistent ship-task
-- lock columns (current_task_id, task_started_at, task_actor_character_id,
-- task_last_heartbeat_at, byoa_session_channel, byoa_session_allocated_at) and
-- the acquire/release/force_release/refresh_heartbeats RPCs. Those were
-- removed: the lock now lives in-memory in the bot process (see
-- VoiceAgent._locked_ships) with crash detection via the BYOA presence
-- heartbeat and TASK_AGENT_TIMEOUT. See CHANGELOG.md for rationale.

-- ---------------------------------------------------------------------------
-- Columns on ship_instances
-- ---------------------------------------------------------------------------

ALTER TABLE ship_instances
  ADD COLUMN byoa_owner_character_id    UUID NULL,
  ADD COLUMN byoa_mode                  TEXT NOT NULL DEFAULT 'private'
    CHECK (byoa_mode = 'private');

COMMENT ON COLUMN ship_instances.byoa_owner_character_id IS
  'For BYOA corp ships: the player whose external agent controls this ship. NULL = not a BYOA ship.';
COMMENT ON COLUMN ship_instances.byoa_mode IS
  'BYOA-only: currently always ''private''. BYOA ships are owner-only in this phase; the column is retained for forward-compatible UI/API shape.';

-- ---------------------------------------------------------------------------
-- Per-ship BYOA wake config
-- ---------------------------------------------------------------------------
-- Where to POST the wake + a shared bearer for that POST. In local dev the
-- URL is `http://host.docker.internal:8765/wake` (the operator's
-- `byoa --serve` daemon); in prod it's the operator's Vercel Function URL
-- (e.g. `https://op.vercel.app/api/wake`). The receiver — operator-hosted —
-- owns calling Sandbox.create with their project env merged into the sandbox
-- `env` param, so we never see operator secrets (LLM keys, prompt, …).
--
-- byoa_wake_secret_enc is a per-ship HMAC-shaped shared secret: operator
-- sets it on their side (daemon `.env.byoa` or Vercel project env) AND
-- writes it here via `ship_byoa_configure { action: 'set' }`. Per-ship
-- (not a global env var on wake_agent) so one operator's leak never lets
-- another operator's URL be forged against. Stored encrypted via
-- pgp_sym_encrypt with the key in byoa_operator_secret(); never returned
-- to clients.
--
-- NULL byoa_runtime_source_url = use DEFAULT_BYOA_SOURCE_URL from
-- wake_agent's edge env. NULL byoa_wake_secret_enc = wake_agent refuses
-- to dispatch (defence-in-depth — an unset bearer means an unauthenticated
-- POST, never desirable).

ALTER TABLE ship_instances
  ADD COLUMN byoa_runtime_source_url  TEXT NULL,
  ADD COLUMN byoa_wake_secret_enc     BYTEA NULL,
  ADD COLUMN byoa_runtime_updated_at  TIMESTAMPTZ NULL;

ALTER TABLE ship_instances
  ADD CONSTRAINT byoa_runtime_url_http
    CHECK (
      byoa_runtime_source_url IS NULL
      OR (
        byoa_runtime_source_url ~ '^https?://'
        AND length(byoa_runtime_source_url) <= 4096
      )
    );

COMMENT ON COLUMN ship_instances.byoa_runtime_source_url IS
  'HTTPS URL wake_agent POSTs the wake payload to. Operator-hosted receiver (local daemon or Vercel Function) owns Sandbox.create. NULL = use DEFAULT_BYOA_SOURCE_URL from wake_agent env. Set via ship_byoa_configure { action: ''set'' }.';
COMMENT ON COLUMN ship_instances.byoa_wake_secret_enc IS
  'Per-ship shared bearer between wake_agent and the operator''s wake receiver. pgp_sym_encrypt''d with byoa_operator_secret(). Never select this column outside SECURITY DEFINER wrappers.';
COMMENT ON COLUMN ship_instances.byoa_runtime_updated_at IS
  'When byoa_runtime_source_url / byoa_wake_secret_enc was last written. Diagnostics only.';

-- pgcrypto provides gen_random_bytes() + pgp_sym_encrypt/decrypt used below
-- for the per-ship wake-secret encryption. Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- =============================================================================
-- BYOA operator-secret accessor
--
-- Symmetric encryption key for byoa_wake_secret_enc on ship_instances.
-- Independent lifecycle from the BYOA-token signing secret so rotating one
-- doesn't invalidate the other.
--
-- Rotation procedure: UPDATE app_runtime_config SET value=encode(gen_random_bytes(32),'base64')
-- WHERE key='byoa_operator_secret'; rotating invalidates existing
-- ciphertexts — operators must re-run ship_byoa_configure set with their
-- secret afterwards.
-- =============================================================================

INSERT INTO public.app_runtime_config (key, value, description)
VALUES (
  'byoa_operator_secret',
  encode(gen_random_bytes(32), 'base64'),
  'Symmetric secret used by pgp_sym_encrypt/decrypt for byoa_wake_secret_enc on ship_instances. Auto-provisioned by this migration; rotate via UPDATE.'
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.byoa_operator_secret()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT value FROM public.app_runtime_config WHERE key = 'byoa_operator_secret';
$$;

COMMENT ON FUNCTION public.byoa_operator_secret IS
  'Returns the symmetric secret used to encrypt/decrypt byoa_wake_secret_enc on ship_instances. Reads from app_runtime_config; rotation invalidates existing ciphertexts.';

REVOKE ALL ON FUNCTION public.byoa_operator_secret() FROM PUBLIC;
-- Only service_role and SECURITY DEFINER wrappers running as function
-- owner should ever see this secret. Edge functions (ship_byoa_configure
-- when setting the wake secret; wake_agent when dispatching) call
-- pgp_sym_encrypt / pgp_sym_decrypt with byoa_operator_secret() as the
-- key from inside their own SQL.
GRANT EXECUTE ON FUNCTION public.byoa_operator_secret() TO service_role;

-- =============================================================================
-- Wake-config getter
--
-- wake_agent reads (source_url, wake_secret) for a ship in one round-trip.
-- The wake_secret is decrypted inside the function body (key never leaves
-- the SECURITY DEFINER scope). Returns NULL for either field when unset.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_ship_byoa_wake_config(p_ship_id uuid)
RETURNS TABLE(source_url text, wake_secret text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    s.byoa_runtime_source_url,
    CASE
      WHEN s.byoa_wake_secret_enc IS NULL THEN NULL
      ELSE extensions.pgp_sym_decrypt(
        s.byoa_wake_secret_enc,
        public.byoa_operator_secret()
      )
    END
  FROM public.ship_instances s
  WHERE s.ship_id = p_ship_id;
$$;

COMMENT ON FUNCTION public.get_ship_byoa_wake_config IS
  'Returns the per-ship BYOA wake URL and decrypted wake secret. Used by wake_agent at dispatch time. SECURITY DEFINER so the operator_secret never escapes server scope; REVOKEd from PUBLIC so only service_role / dispatch path can call.';

REVOKE ALL ON FUNCTION public.get_ship_byoa_wake_config(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ship_byoa_wake_config(uuid) TO service_role;
