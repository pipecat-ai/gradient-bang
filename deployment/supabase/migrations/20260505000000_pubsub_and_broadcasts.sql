-- =============================================================================
-- Pubsub event delivery (pgmq + per-character auth) and broadcast NOTIFY
-- =============================================================================
--
-- This migration:
--   1. Enables pgmq + pgjwt extensions
--   2. Auto-provisions a stable internal HS256 signing secret into
--      `app_runtime_config` (generated on first run via gen_random_bytes,
--      preserved by reset-world.sh alongside the other runtime config)
--   3. Adds SECURITY DEFINER functions for authenticated subscribe/archive.
--      Per-character queues are created lazily on first authorized subscribe
--      (no trigger, no backfill) so polling-only deployments do zero pgmq work.
--   4. Adds `pgmq_publish` — service-role wrapper so edge functions can
--      enqueue alongside writing to the `events` table. Silently no-ops if
--      the target queue does not yet exist.
--   5. Adds `notify_broadcast` — service-role wrapper around pg_notify on
--      the `gb_broadcasts` channel, for fan-out events that every subscriber
--      must receive (chat, gm/system messages)
--
-- Auth model: clients (the bot) connect to Postgres with the same admin URL
-- the rest of the system uses (`POSTGRES_POOLER_URL` value, copied into
-- `PGMQ_URL` in `.env.bot`) and call only `subscribe_my_events` /
-- `archive_my_events`. Both functions verify a short-lived **internal HS256
-- token** minted by the `verify_token` edge function, signed with the secret
-- this migration provisions. The edge function is the place that handles
-- Supabase Auth JWT verification (HS256 *or* ES256, transparently) and
-- ownership checks. This split decouples our SQL auth from Supabase Auth's
-- signing-key rotation while keeping per-character authorization enforced
-- inside the SECURITY DEFINER function (defense in depth).
--
-- The signing secret lives in `app_runtime_config` keyed by
-- `pubsub_internal_secret`, generated once per database. The migration is
-- idempotent — re-running on an existing DB does NOT rotate the secret
-- (ON CONFLICT DO NOTHING). To rotate, UPDATE the row manually, then restart
-- any active bot sessions.
--
-- Broadcast trust model: only the server publishes broadcasts. The publish
-- path goes through `notify_broadcast()`, granted only to service_role. Bot
-- subscribers issue LISTEN gb_broadcasts on their direct DB connection
-- (LISTEN has no privilege controls in Postgres) but cannot reach the publish
-- function. A misbehaving client could call NOTIFY directly from its session,
-- but the events table remains authoritative — a fake notification can't
-- forge an event row, only momentarily render in another live session before
-- divergence is detectable.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- Internal token signing secret (auto-generated, stored in app_runtime_config)
-- -----------------------------------------------------------------------------

INSERT INTO public.app_runtime_config (key, value, description)
VALUES (
  'pubsub_internal_secret',
  encode(gen_random_bytes(32), 'base64'),
  'HS256 signing secret used by verify_token edge function and subscribe_my_events / archive_my_events SQL. Auto-provisioned by the pgmq pubsub migration; rotate via UPDATE.'
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.pubsub_internal_secret()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT value FROM public.app_runtime_config WHERE key = 'pubsub_internal_secret';
$$;

COMMENT ON FUNCTION public.pubsub_internal_secret IS
  'Returns the HS256 signing secret used to mint and verify internal pubsub tokens. Reads from app_runtime_config (auto-provisioned by the pgmq pubsub migration).';

REVOKE ALL ON FUNCTION public.pubsub_internal_secret() FROM PUBLIC;
-- service_role calls this from the verify_token edge function (to sign
-- minted tokens). subscribe_my_events / archive_my_events are SECURITY
-- DEFINER and run as the function owner, so they don't need a grant.
GRANT EXECUTE ON FUNCTION public.pubsub_internal_secret() TO service_role;

-- -----------------------------------------------------------------------------
-- Queue lifecycle helper
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_character_queue(p_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_qtable text := 'q_chr_' || p_character_id::text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgmq' AND c.relname = v_qtable
  ) THEN
    RETURN;
  END IF;
  PERFORM pgmq.create('chr_' || p_character_id::text);
EXCEPTION
  WHEN duplicate_table THEN
    NULL;
END;
$$;

COMMENT ON FUNCTION public.ensure_character_queue IS
  'Idempotent queue ensure for a character_id. Fast path checks pg_class to avoid the AccessExclusiveLock that CREATE TABLE IF NOT EXISTS takes on existing tables — required because the caller (subscribe_my_events) holds its txn open for a 30s read_with_poll.';

-- -----------------------------------------------------------------------------
-- Ownership predicate: can user U access character/ship C?
-- Direct ownership OR corp ship in user's corp.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_user_access_character(
  p_user_id uuid,
  p_character_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Direct ownership: user owns this character via user_characters
  SELECT EXISTS (
    SELECT 1 FROM public.user_characters
    WHERE user_id = p_user_id
      AND character_id = p_character_id
  )
  OR
  -- Corp membership: target is a corp ship in a corp where the user owns
  -- a member character (corp ships are dual-registered: row in `characters`
  -- with character_id == ship_id, plus row in `ship_instances` with
  -- owner_type='corporation').
  EXISTS (
    SELECT 1
    FROM public.ship_instances target_ship
    JOIN public.user_characters uc ON true
    JOIN public.characters my_char ON my_char.character_id = uc.character_id
    WHERE target_ship.ship_id = p_character_id
      AND target_ship.owner_type = 'corporation'
      AND uc.user_id = p_user_id
      AND my_char.corporation_id = target_ship.owner_corporation_id
  );
$$;

COMMENT ON FUNCTION public.can_user_access_character IS
  'Returns true if user U can access character/ship C. Direct ownership via user_characters, OR corp ship via corp membership.';

-- -----------------------------------------------------------------------------
-- subscribe_my_events: authenticated long-poll read
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.subscribe_my_events(
  p_character_id uuid,
  p_internal_token text,
  p_max_seconds integer DEFAULT 30,
  p_qty integer DEFAULT 100
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_payload json;
  v_valid boolean;
  v_user_id uuid;
BEGIN
  -- Verify the internal HS256 token signed by the `verify_token` edge function.
  -- pgjwt's verify() returns (header, payload, valid) and enforces exp itself
  -- (returns valid=false on expiry); we still get the parsed payload so we
  -- can differentiate signature failure from expiry for clearer errors.
  SELECT payload, valid
    INTO v_payload, v_valid
    FROM extensions.verify(
      p_internal_token,
      public.pubsub_internal_secret(),
      'HS256'
    );

  IF v_valid IS NOT TRUE THEN
    IF v_payload IS NOT NULL
       AND (v_payload->>'exp') IS NOT NULL
       AND (v_payload->>'exp')::integer < extract(epoch FROM now())::integer THEN
      RAISE EXCEPTION 'token_expired' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  -- Defense against accidental cross-secret reuse: the internal token must
  -- have been minted by `verify_token` (issuer claim).
  IF v_payload->>'iss' IS DISTINCT FROM 'verify_token' THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  -- The internal token is scoped to the character it was minted for; reject
  -- attempts to reuse it against a different character.
  IF (v_payload->>'character_id')::uuid IS DISTINCT FROM p_character_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_user_id := (v_payload->>'sub')::uuid;

  -- Authorize: user must own character or have corp access. Defense in depth —
  -- survives a leaked internal token if the user has since lost ownership.
  IF NOT public.can_user_access_character(v_user_id, p_character_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Lazy: queue only exists once an authorized subscriber has connected.
  PERFORM public.ensure_character_queue(p_character_id);

  RETURN QUERY
    SELECT * FROM pgmq.read_with_poll(
      'chr_' || p_character_id::text,
      10,            -- vt: visibility timeout (seconds)
      p_qty,
      p_max_seconds,
      250            -- poll_interval_ms
    );
END;
$$;

COMMENT ON FUNCTION public.subscribe_my_events IS
  'Authenticated long-poll read from a per-character pgmq queue. Verifies an internal HS256 token minted by the verify_token edge function, checks ownership, returns up to p_qty messages within p_max_seconds. Raises invalid_token / token_expired / forbidden on auth failure.';

-- -----------------------------------------------------------------------------
-- archive_my_events: authenticated archive of consumed messages
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.archive_my_events(
  p_character_id uuid,
  p_internal_token text,
  p_msg_ids bigint[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_payload json;
  v_valid boolean;
  v_user_id uuid;
  v_archived integer := 0;
  v_msg_id bigint;
BEGIN
  SELECT payload, valid
    INTO v_payload, v_valid
    FROM extensions.verify(
      p_internal_token,
      public.pubsub_internal_secret(),
      'HS256'
    );

  IF v_valid IS NOT TRUE THEN
    IF v_payload IS NOT NULL
       AND (v_payload->>'exp') IS NOT NULL
       AND (v_payload->>'exp')::integer < extract(epoch FROM now())::integer THEN
      RAISE EXCEPTION 'token_expired' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  IF v_payload->>'iss' IS DISTINCT FROM 'verify_token' THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  IF (v_payload->>'character_id')::uuid IS DISTINCT FROM p_character_id THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_user_id := (v_payload->>'sub')::uuid;

  IF NOT public.can_user_access_character(v_user_id, p_character_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  FOREACH v_msg_id IN ARRAY p_msg_ids LOOP
    IF pgmq.archive('chr_' || p_character_id::text, v_msg_id) THEN
      v_archived := v_archived + 1;
    END IF;
  END LOOP;

  RETURN v_archived;
END;
$$;

COMMENT ON FUNCTION public.archive_my_events IS
  'Authenticated archive of consumed messages from a per-character pgmq queue. Same auth model as subscribe_my_events.';

-- -----------------------------------------------------------------------------
-- pgmq_publish: thin wrapper for service-role server-side enqueue
--
-- Edge functions (running as `service_role`) need to publish to per-character
-- pgmq queues alongside writing to the `events` table. Supabase's RPC API
-- only exposes the `public` schema, so we wrap `pgmq.send` here.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pgmq_publish(
  p_queue_name text,
  p_msg jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_msg_id bigint;
BEGIN
  v_msg_id := pgmq.send(p_queue_name, p_msg);
  RETURN v_msg_id;
EXCEPTION
  -- Queue doesn't exist yet — no subscriber has ever connected for this
  -- recipient. Silent no-op so polling-only deployments don't error.
  WHEN undefined_table THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.pgmq_publish IS
  'Server-side publish wrapper for pgmq.send. Returns NULL if queue does not exist (no subscriber yet). Granted to service_role only; subscribers must use subscribe_my_events.';

REVOKE ALL ON FUNCTION public.pgmq_publish(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgmq_publish(text, jsonb) TO service_role;

-- -----------------------------------------------------------------------------
-- notify_broadcast: server-only fan-out via Postgres LISTEN/NOTIFY
--
-- Why not pgmq for broadcasts? pgmq.read+archive is competing-consumer: the
-- first reader to archive a message removes it for everyone else. That's the
-- opposite of what broadcasts need (every subscriber must receive every
-- broadcast). Postgres NOTIFY is the right primitive — every connection that
-- has issued LISTEN on the channel receives every notification.
--
-- Payload limit: NOTIFY payloads are capped at 8000 bytes. Chat broadcasts
-- and gm/system messages fit comfortably; if we ever need larger payloads
-- we'll switch to an id-only nudge with an events-table fetch.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_broadcast(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cap to a safe headroom under Postgres' 8000-byte NOTIFY limit. The
  -- limit is bytes, not characters — chat can contain multibyte UTF-8, so
  -- length() would undercount and let pg_notify raise. octet_length() is
  -- the correct check. If the payload exceeds, drop the broadcast rather
  -- than raising: broadcasts are best-effort, and a single oversize
  -- message must not break event recording (already done on the events
  -- table side).
  IF octet_length(p_payload::text) > 7800 THEN
    RAISE WARNING 'notify_broadcast: payload too large (% bytes). dropping',
      octet_length(p_payload::text);
    RETURN;
  END IF;
  PERFORM pg_notify('gb_broadcasts', p_payload::text);
END;
$$;

COMMENT ON FUNCTION public.notify_broadcast IS
  'Server-only broadcast publish wrapper. Granted to service_role only. Subscribers consume via LISTEN gb_broadcasts on a direct DB connection.';

REVOKE ALL ON FUNCTION public.notify_broadcast(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_broadcast(jsonb) TO service_role;
