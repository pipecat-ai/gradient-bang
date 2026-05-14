-- BYOA infrastructure.
--
-- Three concerns in one migration:
--   1. ship_instances columns marking a corp ship as BYOA-controlled and
--      holding the per-ship wake URL + encrypted wake-secret.
--   2. byoa_operator_secret() + get_ship_byoa_wake_config() — SECURITY
--      DEFINER accessors that keep the wake-secret encryption key in
--      server scope.
--   3. Channel-as-capability bus surface — byoa_bus_client role, pgmq
--      schema revokes, bus_peers registry, and bus_* SECURITY DEFINER
--      wrappers that the BYOA login (and bot service_role) use for all
--      pub/sub traffic.

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

-- =============================================================================
-- Channel-as-capability bus wrappers
--
-- BYOA operators connect with a restricted DB role and can only execute the
-- public.bus_* SECURITY DEFINER wrappers below. Each wrapper takes both a
-- queue name and a channel and verifies the pair against the bus_peers
-- registry. Queue names are server-allocated opaque UUIDs and are enumerable
-- via pg_class; knowledge of the channel is the bus capability.
-- =============================================================================

-- Restricted login role. Migrations do not bake a password; create a per-env
-- login role and grant this role to it, e.g.
--   GRANT byoa_bus_client TO byoa_bus_client_login;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byoa_bus_client') THEN
    CREATE ROLE byoa_bus_client NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO byoa_bus_client;

-- Close the pgmq enumeration door for both the BYOA role and PUBLIC. Bot-side
-- bus traffic goes through the same SECURITY DEFINER wrappers, so this does
-- not affect privileged callers (service_role + ad-hoc psql).
REVOKE ALL ON SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM PUBLIC;

-- Peer registry. Bus layer is identity-free; channel→ship/character binding
-- happens at channel-issuance time (wake_agent), not here.
CREATE TABLE public.bus_peers (
  queue_name text PRIMARY KEY,
  channel    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX bus_peers_channel_idx ON public.bus_peers(channel);
REVOKE ALL ON TABLE public.bus_peers FROM PUBLIC;
COMMENT ON TABLE public.bus_peers IS
  'Channel/queue registry for the public.bus_* SECURITY DEFINER wrappers. Not exposed to byoa_bus_client.';

-- Server-side channel format validator. Channels are 'gb_' followed by 32 hex
-- chars (UUID-128 hex). Wrappers reject anything else so a malformed channel
-- can never enter bus_peers.
CREATE OR REPLACE FUNCTION public._bus_validate_channel(p_channel text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_channel IS NULL OR p_channel !~ '^gb_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'channel_invalid' USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._bus_validate_channel(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.bus_join(p_channel text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_queue_name text;
BEGIN
  PERFORM public._bus_validate_channel(p_channel);
  v_queue_name := 'q_' || replace(gen_random_uuid()::text, '-', '');
  PERFORM pgmq.create(v_queue_name);
  INSERT INTO public.bus_peers (queue_name, channel)
    VALUES (v_queue_name, p_channel);
  RETURN v_queue_name;
END;
$$;
REVOKE ALL ON FUNCTION public.bus_join(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_join(text) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_publish(
  p_channel  text,
  p_my_queue text,
  p_message  jsonb
) RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_peer record;
  v_msg_ids bigint[] := ARRAY[]::bigint[];
  v_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  -- Fan out to every registered peer on the channel. A crashed peer that
  -- failed to call bus_leave can leave a stale bus_peers row pointing at a
  -- dropped pgmq queue; catch undefined_table, prune the row, and keep going
  -- so one dead peer doesn't take down the publish.
  FOR v_peer IN
    SELECT queue_name FROM public.bus_peers WHERE channel = p_channel
  LOOP
    BEGIN
      v_id := pgmq.send(v_peer.queue_name, p_message);
      v_msg_ids := array_append(v_msg_ids, v_id);
    EXCEPTION
      WHEN undefined_table THEN
        DELETE FROM public.bus_peers WHERE queue_name = v_peer.queue_name;
    END;
  END LOOP;

  RETURN v_msg_ids;
END;
$$;
REVOKE ALL ON FUNCTION public.bus_publish(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_publish(text, text, jsonb) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_subscribe(
  p_my_queue    text,
  p_channel     text,
  p_vt          integer DEFAULT 30,
  p_qty         integer DEFAULT 10,
  p_max_seconds integer DEFAULT 5
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT * FROM pgmq.read_with_poll(
      queue_name       => p_my_queue,
      vt               => p_vt,
      qty              => p_qty,
      max_poll_seconds => p_max_seconds
    );
END;
$$;
REVOKE ALL ON FUNCTION public.bus_subscribe(text, text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_subscribe(text, text, integer, integer, integer) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_archive(
  p_my_queue text,
  p_channel  text,
  p_msg_id   bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN pgmq.delete(p_my_queue, p_msg_id);
END;
$$;
REVOKE ALL ON FUNCTION public.bus_archive(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_archive(text, text, bigint) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_leave(
  p_my_queue text,
  p_channel  text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM pgmq.drop_queue(p_my_queue);
  EXCEPTION
    WHEN undefined_table THEN NULL;
  END;
  DELETE FROM public.bus_peers
    WHERE queue_name = p_my_queue
      AND channel = p_channel;
END;
$$;
REVOKE ALL ON FUNCTION public.bus_leave(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_leave(text, text) TO byoa_bus_client, service_role;
