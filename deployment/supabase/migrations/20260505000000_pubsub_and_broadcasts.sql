-- =============================================================================
-- Pubsub event delivery (PGMQ scoped reads + per-character auth) and broadcast NOTIFY
-- =============================================================================
--
-- This migration installs:
--   1. pgmq + pgjwt + pgcrypto extensions.
--   2. Legacy internal-token subscribe/archive compatibility functions.
--   3. Trusted bot scoped subscribe/archive functions using EDGE_API_TOKEN.
--   4. Required SQL-owned publish wrappers for event recording.
--   5. Broadcast fan-out through LISTEN/NOTIFY.
--
-- Auth model: clients (the bot) connect to Postgres with the same admin URL
-- the rest of the system uses (`POSTGRES_POOLER_URL` value, copied into
-- `PGMQ_URL` in `.env.bot`) and call `subscribe_my_events_scope` /
-- `archive_my_events_scope`. The scoped functions verify EDGE_API_TOKEN, then
-- check the actor can read every requested character queue.
--
-- The older `subscribe_my_events` / `archive_my_events` functions remain for
-- compatibility with verify_token tests and any deployed legacy bot.
--
-- The signing secret lives in `app_runtime_config` keyed by
-- `pubsub_internal_secret`, generated once per database. The migration is
-- idempotent — re-running on an existing DB does NOT rotate the secret
-- (ON CONFLICT DO NOTHING). To rotate, UPDATE the row manually.
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
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

SET check_function_bodies = OFF;

-- -----------------------------------------------------------------------------
-- Internal token signing secret (auto-generated, stored in app_runtime_config)
-- -----------------------------------------------------------------------------

INSERT INTO public.app_runtime_config (key, value, description)
VALUES (
  'pubsub_internal_secret',
  encode(extensions.gen_random_bytes(32), 'base64'),
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
  'Idempotent queue ensure for a character_id. Fast path checks pg_class before pgmq.create to avoid unnecessary locks on existing queues.';

-- Drop the implicit PUBLIC EXECUTE grant so byoa_bus_client / other
-- authenticated PG roles can't spam pgmq queue creation for arbitrary
-- character_ids. subscribe_my_events calls this from inside its own
-- SECURITY DEFINER body, which runs as the function owner and is
-- unaffected by these grants.
REVOKE ALL ON FUNCTION public.ensure_character_queue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_character_queue(uuid) TO service_role;

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
-- subscribe_my_events: authenticated immediate read
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.subscribe_my_events(
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
  -- p_max_seconds is preserved for signature compatibility with deployed bots.
  -- Poll timing is client-owned; this function intentionally returns
  -- immediately after one read.
  PERFORM p_max_seconds;

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

  PERFORM public.ensure_character_queue(p_character_id);

  RETURN QUERY
    SELECT * FROM pgmq.read(
      'chr_' || p_character_id::text,
      10,    -- vt: visibility timeout (seconds)
      p_qty
    );
END;
$$;

COMMENT ON FUNCTION public.subscribe_my_events IS
  'Authenticated immediate read from a per-character pgmq queue. Verifies an internal HS256 token minted by verify_token, checks ownership, and returns up to p_qty messages.';

REVOKE ALL ON FUNCTION public.subscribe_my_events(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscribe_my_events(uuid, text, integer, integer) TO service_role;

-- -----------------------------------------------------------------------------
-- archive_my_events: authenticated archive of consumed messages
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.archive_my_events(
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

REVOKE ALL ON FUNCTION public.archive_my_events(uuid, text, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_my_events(uuid, text, bigint[]) TO service_role;

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
END;
$$;

COMMENT ON FUNCTION public.pgmq_publish IS
  'Required server-side publish wrapper for pgmq.send. Raises if the queue is missing or publish fails; pubsub delivery is mandatory.';

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

-- -----------------------------------------------------------------------------
-- Scoped trusted-bot queue access
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_actor_access_character(
  p_actor_character_id uuid,
  p_target_character_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH actor_corps AS (
    SELECT cm.corp_id
    FROM public.corporation_members cm
    WHERE cm.character_id = p_actor_character_id
      AND cm.left_at IS NULL

    UNION

    SELECT si.owner_corporation_id AS corp_id
    FROM public.ship_instances si
    WHERE si.ship_id = p_actor_character_id
      AND si.owner_type = 'corporation'
      AND si.owner_corporation_id IS NOT NULL
  )
  SELECT p_actor_character_id = p_target_character_id
  OR EXISTS (
    SELECT 1
    FROM public.ship_instances target_ship
    JOIN actor_corps ac ON ac.corp_id = target_ship.owner_corporation_id
    WHERE target_ship.ship_id = p_target_character_id
      AND target_ship.owner_type = 'corporation'
  );
$$;

COMMENT ON FUNCTION public.can_actor_access_character IS
  'Returns true when actor can read target event queue: self, or a corp-owned ship in actor corporation.';

REVOKE ALL ON FUNCTION public.can_actor_access_character(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_actor_access_character(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._assert_valid_edge_token(p_edge_token text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected text;
BEGIN
  SELECT value
    INTO v_expected
    FROM public.app_runtime_config
   WHERE key = 'edge_api_token';

  IF v_expected IS NULL OR v_expected = '' THEN
    RAISE EXCEPTION 'edge_token_missing' USING ERRCODE = '42501';
  END IF;

  IF p_edge_token IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'invalid_edge_token' USING ERRCODE = '42501';
  END IF;
END;
$$;

COMMENT ON FUNCTION public._assert_valid_edge_token IS
  'Internal helper for scoped pubsub reads. Verifies EDGE_API_TOKEN against app_runtime_config.edge_api_token.';

REVOKE ALL ON FUNCTION public._assert_valid_edge_token(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.subscribe_my_events_scope(
  p_actor_character_id uuid,
  p_edge_token text,
  p_character_ids uuid[],
  p_qty integer DEFAULT 100
) RETURNS TABLE (
  queue_character_id uuid,
  msg_id bigint,
  read_ct integer,
  message jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_character_id uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_qty integer := GREATEST(0, COALESCE(p_qty, 100));
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);

  IF p_actor_character_id IS NULL THEN
    RAISE EXCEPTION 'actor_character_id_required' USING ERRCODE = '22023';
  END IF;

  IF v_qty = 0 THEN
    RETURN;
  END IF;

  FOREACH v_character_id IN ARRAY COALESCE(p_character_ids, ARRAY[]::uuid[]) LOOP
    IF v_character_id IS NULL OR v_character_id = ANY(v_seen) THEN
      CONTINUE;
    END IF;
    v_seen := array_append(v_seen, v_character_id);

    IF NOT public.can_actor_access_character(p_actor_character_id, v_character_id) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    PERFORM public.ensure_character_queue(v_character_id);

    RETURN QUERY
      SELECT
        v_character_id AS queue_character_id,
        r.msg_id,
        r.read_ct,
        r.message
      FROM pgmq.read(
        'chr_' || v_character_id::text,
        10,    -- vt: visibility timeout (seconds)
        v_qty
      ) AS r;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.subscribe_my_events_scope IS
  'Authenticated immediate read from all allowed per-character PGMQ queues in a bot session scope. EDGE_API_TOKEN proves trusted backend; actor/target access is checked per queue.';

REVOKE ALL ON FUNCTION public.subscribe_my_events_scope(uuid, text, uuid[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscribe_my_events_scope(uuid, text, uuid[], integer) TO service_role;

CREATE OR REPLACE FUNCTION public.archive_my_events_scope(
  p_actor_character_id uuid,
  p_edge_token text,
  p_queue_character_ids uuid[],
  p_msg_ids bigint[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_len integer;
  v_i integer;
  v_character_id uuid;
  v_msg_id bigint;
  v_archived integer := 0;
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);

  IF p_actor_character_id IS NULL THEN
    RAISE EXCEPTION 'actor_character_id_required' USING ERRCODE = '22023';
  END IF;

  v_len := COALESCE(array_length(p_queue_character_ids, 1), 0);
  IF v_len <> COALESCE(array_length(p_msg_ids, 1), 0) THEN
    RAISE EXCEPTION 'queue/msg array length mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_len = 0 THEN
    RETURN 0;
  END IF;

  FOR v_i IN 1..v_len LOOP
    v_character_id := p_queue_character_ids[v_i];
    v_msg_id := p_msg_ids[v_i];

    IF v_character_id IS NULL OR v_msg_id IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT public.can_actor_access_character(p_actor_character_id, v_character_id) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    IF pgmq.archive('chr_' || v_character_id::text, v_msg_id) THEN
      v_archived := v_archived + 1;
    END IF;
  END LOOP;

  RETURN v_archived;
END;
$$;

COMMENT ON FUNCTION public.archive_my_events_scope IS
  'Authenticated archive for messages read by subscribe_my_events_scope. Validates queue/msg array lengths and actor access per queue.';

REVOKE ALL ON FUNCTION public.archive_my_events_scope(uuid, text, uuid[], bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_my_events_scope(uuid, text, uuid[], bigint[]) TO service_role;

-- -----------------------------------------------------------------------------
-- Required SQL-owned event publishing
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_event_with_recipients(
  p_event_type TEXT,
  p_direction TEXT DEFAULT 'event_out',
  p_scope TEXT DEFAULT 'direct',
  p_actor_character_id UUID DEFAULT NULL,
  p_corp_id UUID DEFAULT NULL,
  p_sector_id INTEGER DEFAULT NULL,
  p_ship_id UUID DEFAULT NULL,
  p_character_id UUID DEFAULT NULL,
  p_sender_id UUID DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_meta JSONB DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_recipients UUID[] DEFAULT ARRAY[]::UUID[],
  p_reasons TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_is_broadcast BOOLEAN DEFAULT FALSE,
  p_task_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_payload_out JSONB;
  v_has_recipients BOOLEAN := COALESCE(array_length(p_recipients, 1), 0) > 0;
  v_subject_is_corp_member BOOLEAN := FALSE;

  v_corp_member_ids UUID[] := ARRAY[]::UUID[];
  v_corp_ship_ids UUID[] := ARRAY[]::UUID[];
  v_corp_delivery_ids UUID[] := ARRAY[]::UUID[];
  v_corp_reason_ids UUID[] := ARRAY[]::UUID[];
  v_corp_reason_values TEXT[] := ARRAY[]::TEXT[];
  v_subject_ids UUID[] := ARRAY[]::UUID[];
  v_has_corp_members BOOLEAN := FALSE;
  v_should_expand_corp BOOLEAN := FALSE;

  v_publish_recipient_ids UUID[] := ARRAY[]::UUID[];
  v_publish_reasons TEXT[] := ARRAY[]::TEXT[];
  v_publish_event_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_new_publish_recipient_ids UUID[];
  v_new_publish_reasons TEXT[];
  v_new_publish_event_ids BIGINT[];

  v_row RECORD;
  v_idx INTEGER;
  v_i INTEGER;
  v_id UUID;
  v_reason TEXT;
  v_corp_event_id BIGINT := NULL;
  v_broadcast_event_id BIGINT := NULL;
  v_event_id BIGINT := NULL;
  v_msg JSONB;
BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN
    RAISE EXCEPTION 'recipient/reason length mismatch'
      USING ERRCODE = '22023';
  END IF;

  v_payload_out := CASE
    WHEN p_task_id IS NOT NULL THEN v_payload || jsonb_build_object('__task_id', p_task_id::TEXT)
    ELSE v_payload
  END;

  IF v_has_recipients THEN
    FOR v_i IN 1..array_length(p_recipients, 1) LOOP
      IF p_recipients[v_i] IS NULL THEN
        CONTINUE;
      END IF;
      v_idx := array_position(v_publish_recipient_ids, p_recipients[v_i]);
      IF v_idx IS NULL THEN
        v_publish_recipient_ids := array_append(v_publish_recipient_ids, p_recipients[v_i]);
        v_publish_reasons := array_append(v_publish_reasons, p_reasons[v_i]);
        v_publish_event_ids := array_append(v_publish_event_ids, NULL::BIGINT);
      END IF;
    END LOOP;
  END IF;

  IF p_corp_id IS NOT NULL AND (p_character_id IS NOT NULL OR v_has_recipients OR p_ship_id IS NOT NULL OR p_actor_character_id IS NOT NULL) THEN
    SELECT ARRAY_AGG(cm.character_id)
    INTO v_corp_member_ids
    FROM public.corporation_members cm
    WHERE cm.corp_id = p_corp_id
      AND cm.left_at IS NULL;

    v_corp_member_ids := COALESCE(v_corp_member_ids, ARRAY[]::UUID[]);
    v_has_corp_members := COALESCE(array_length(v_corp_member_ids, 1), 0) > 0;

    SELECT ARRAY_AGG(si.ship_id)
    INTO v_corp_ship_ids
    FROM public.ship_instances si
    WHERE si.owner_type = 'corporation'
      AND si.owner_corporation_id = p_corp_id;

    v_corp_ship_ids := COALESCE(v_corp_ship_ids, ARRAY[]::UUID[]);
    v_corp_delivery_ids := v_corp_member_ids || v_corp_ship_ids;

    FOREACH v_id IN ARRAY v_corp_ship_ids LOOP
      IF v_id IS NULL THEN
        CONTINUE;
      END IF;
      v_corp_reason_ids := array_append(v_corp_reason_ids, v_id);
      v_corp_reason_values := array_append(v_corp_reason_values, 'corp_ship');
    END LOOP;

    FOREACH v_id IN ARRAY v_corp_member_ids LOOP
      IF v_id IS NULL THEN
        CONTINUE;
      END IF;
      v_idx := array_position(v_corp_reason_ids, v_id);
      IF v_idx IS NULL THEN
        v_corp_reason_ids := array_append(v_corp_reason_ids, v_id);
        v_corp_reason_values := array_append(v_corp_reason_values, 'corp_member');
      ELSE
        v_corp_reason_values[v_idx] := 'corp_member';
      END IF;
    END LOOP;

    IF p_character_id IS NOT NULL THEN
      v_subject_ids := array_append(v_subject_ids, p_character_id);
      v_subject_is_corp_member := p_character_id = ANY(v_corp_delivery_ids);
    END IF;
    IF p_ship_id IS NOT NULL THEN
      v_subject_ids := array_append(v_subject_ids, p_ship_id);
    END IF;
    IF p_actor_character_id IS NOT NULL THEN
      v_subject_ids := array_append(v_subject_ids, p_actor_character_id);
    END IF;
  END IF;

  IF v_has_recipients THEN
    FOR v_row IN
      INSERT INTO public.events (
        direction, event_type, scope, actor_character_id, corp_id,
        sector_id, ship_id, character_id, sender_id, payload, meta,
        request_id, task_id, inserted_at,
        recipient_character_id, recipient_reason, is_broadcast
      )
      SELECT
        p_direction, p_event_type, p_scope, p_actor_character_id,
        NULL,
        p_sector_id, p_ship_id, p_character_id, p_sender_id,
        v_payload, p_meta,
        p_request_id, p_task_id, v_now,
        t.recipient, t.reason, FALSE
      FROM UNNEST(p_recipients, p_reasons) AS t(recipient, reason)
      WHERE p_corp_id IS NULL
         OR NOT (t.recipient = ANY(v_corp_delivery_ids))
      RETURNING id, recipient_character_id
    LOOP
      v_idx := array_position(v_publish_recipient_ids, v_row.recipient_character_id);
      IF v_idx IS NOT NULL AND v_publish_event_ids[v_idx] IS NULL THEN
        v_publish_event_ids[v_idx] := v_row.id;
      END IF;
    END LOOP;
  END IF;

  IF p_corp_id IS NOT NULL AND NOT p_is_broadcast THEN
    INSERT INTO public.events (
      direction, event_type, scope, actor_character_id, corp_id,
      sector_id, ship_id, character_id, sender_id, payload, meta,
      request_id, task_id, inserted_at,
      recipient_character_id, recipient_reason, is_broadcast
    ) VALUES (
      p_direction, p_event_type, p_scope, p_actor_character_id, p_corp_id,
      p_sector_id, p_ship_id, p_character_id, p_sender_id,
      v_payload, p_meta,
      p_request_id, p_task_id, v_now,
      CASE WHEN v_subject_is_corp_member THEN p_character_id ELSE NULL END,
      'corp_broadcast', FALSE
    )
    RETURNING id INTO v_corp_event_id;

    IF COALESCE(array_length(v_publish_recipient_ids, 1), 0) > 0 THEN
      FOR v_i IN 1..array_length(v_publish_recipient_ids, 1) LOOP
        IF v_publish_event_ids[v_i] IS NULL
           AND v_publish_recipient_ids[v_i] = ANY(v_corp_delivery_ids) THEN
          v_publish_event_ids[v_i] := v_corp_event_id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF p_is_broadcast AND NOT v_has_recipients THEN
    INSERT INTO public.events (
      direction, event_type, scope, actor_character_id, corp_id,
      sector_id, ship_id, character_id, sender_id, payload, meta,
      request_id, task_id, inserted_at,
      recipient_character_id, recipient_reason, is_broadcast
    ) VALUES (
      p_direction, p_event_type, p_scope, p_actor_character_id,
      NULL,
      p_sector_id, p_ship_id, p_character_id, p_sender_id,
      v_payload, p_meta,
      p_request_id, p_task_id, v_now,
      NULL, NULL, TRUE
    )
    RETURNING id INTO v_broadcast_event_id;
  END IF;

  IF p_corp_id IS NOT NULL THEN
    IF p_scope = 'corp' THEN
      v_should_expand_corp := TRUE;
    END IF;

    IF NOT v_should_expand_corp AND COALESCE(array_length(v_subject_ids, 1), 0) > 0 THEN
      FOR v_i IN 1..array_length(v_subject_ids, 1) LOOP
        v_idx := array_position(v_corp_reason_ids, v_subject_ids[v_i]);
        IF v_idx IS NOT NULL AND v_corp_reason_values[v_idx] = 'corp_ship' THEN
          v_should_expand_corp := TRUE;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF NOT v_should_expand_corp AND COALESCE(array_length(v_publish_recipient_ids, 1), 0) > 0 THEN
      FOR v_i IN 1..array_length(v_publish_recipient_ids, 1) LOOP
        v_idx := array_position(v_corp_reason_ids, v_publish_recipient_ids[v_i]);
        IF v_idx IS NOT NULL AND v_corp_reason_values[v_idx] = 'corp_ship' THEN
          v_should_expand_corp := TRUE;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF NOT v_should_expand_corp AND COALESCE(array_length(v_subject_ids, 1), 0) = 0 THEN
      v_should_expand_corp := TRUE;
    END IF;

    IF v_has_corp_members AND v_should_expand_corp AND COALESCE(array_length(v_publish_recipient_ids, 1), 0) > 0 THEN
      v_new_publish_recipient_ids := ARRAY[]::UUID[];
      v_new_publish_reasons := ARRAY[]::TEXT[];
      v_new_publish_event_ids := ARRAY[]::BIGINT[];

      FOR v_i IN 1..array_length(v_publish_recipient_ids, 1) LOOP
        v_idx := array_position(v_corp_reason_ids, v_publish_recipient_ids[v_i]);
        IF v_idx IS NOT NULL AND v_corp_reason_values[v_idx] = 'corp_ship' THEN
          CONTINUE;
        END IF;
        v_new_publish_recipient_ids := array_append(v_new_publish_recipient_ids, v_publish_recipient_ids[v_i]);
        v_new_publish_reasons := array_append(v_new_publish_reasons, v_publish_reasons[v_i]);
        v_new_publish_event_ids := array_append(v_new_publish_event_ids, v_publish_event_ids[v_i]);
      END LOOP;

      v_publish_recipient_ids := v_new_publish_recipient_ids;
      v_publish_reasons := v_new_publish_reasons;
      v_publish_event_ids := v_new_publish_event_ids;
    END IF;

    IF v_should_expand_corp AND COALESCE(array_length(v_corp_reason_ids, 1), 0) > 0 THEN
      FOR v_i IN 1..array_length(v_corp_reason_ids, 1) LOOP
        v_id := v_corp_reason_ids[v_i];
        v_reason := v_corp_reason_values[v_i];
        IF v_has_corp_members AND v_reason = 'corp_ship' THEN
          CONTINUE;
        END IF;

        v_idx := array_position(v_publish_recipient_ids, v_id);
        IF v_idx IS NULL THEN
          v_publish_recipient_ids := array_append(v_publish_recipient_ids, v_id);
          v_publish_reasons := array_append(v_publish_reasons, v_reason);
          v_publish_event_ids := array_append(v_publish_event_ids, v_corp_event_id);
        ELSIF v_publish_event_ids[v_idx] IS NULL THEN
          v_publish_event_ids[v_idx] := v_corp_event_id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF p_is_broadcast THEN
    v_msg := jsonb_build_object(
      'event_type', p_event_type,
      'direction', p_direction,
      'scope', p_scope,
      'payload', v_payload_out,
      'meta', p_meta,
      'request_id', p_request_id,
      'sector_id', p_sector_id,
      'ship_id', p_ship_id,
      'character_id', p_character_id,
      'sender_id', p_sender_id,
      'actor_character_id', p_actor_character_id,
      'corp_id', p_corp_id,
      'task_id', p_task_id,
      'is_broadcast', TRUE,
      'recipient_id', NULL,
      'recipient_reason', NULL,
      'recipient_ids', '[]'::jsonb,
      'recipient_reasons', '[]'::jsonb,
      'event_context', jsonb_build_object(
        'event_id', v_broadcast_event_id,
        'character_id', NULL,
        'reason', NULL,
        'scope', p_scope,
        'recipient_ids', '[]'::jsonb,
        'recipient_reasons', '[]'::jsonb
      )
    );

    BEGIN
      PERFORM public.notify_broadcast(v_msg);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'record_event_with_recipients notify_broadcast failed for event_type=%: %',
        p_event_type, SQLERRM;
    END;
  END IF;

  IF COALESCE(array_length(v_publish_recipient_ids, 1), 0) = 0 THEN
    RETURN;
  END IF;

  FOR v_i IN 1..array_length(v_publish_recipient_ids, 1) LOOP
    v_id := v_publish_recipient_ids[v_i];
    v_reason := v_publish_reasons[v_i];
    v_event_id := v_publish_event_ids[v_i];
    IF v_event_id IS NULL THEN
      v_event_id := v_corp_event_id;
    END IF;

    v_msg := jsonb_build_object(
      'event_type', p_event_type,
      'direction', p_direction,
      'scope', p_scope,
      'payload', v_payload_out,
      'meta', p_meta,
      'request_id', p_request_id,
      'sector_id', p_sector_id,
      'ship_id', p_ship_id,
      'character_id', p_character_id,
      'sender_id', p_sender_id,
      'actor_character_id', p_actor_character_id,
      'corp_id', p_corp_id,
      'task_id', p_task_id,
      'is_broadcast', p_is_broadcast,
      'recipient_id', v_id,
      'recipient_reason', v_reason,
      'recipient_ids', jsonb_build_array(v_id),
      'recipient_reasons', jsonb_build_array(v_reason),
      'event_context', jsonb_build_object(
        'event_id', v_event_id,
        'character_id', v_id,
        'reason', v_reason,
        'scope', p_scope,
        'recipient_ids', jsonb_build_array(v_id),
        'recipient_reasons', jsonb_build_array(v_reason)
      )
    );

    PERFORM public.pgmq_publish('chr_' || v_id::TEXT, v_msg);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts denormalized event rows and publishes the same event to required SQL-owned pubsub delivery. Per-character pgmq publish failures raise and roll back the event transaction.';

REVOKE ALL ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) TO service_role;

DO $$
DECLARE
  v_ship_id UUID;
BEGIN
  FOR v_ship_id IN
    SELECT si.ship_id
    FROM public.ship_instances si
    JOIN public.characters c ON c.character_id = si.ship_id
    WHERE si.owner_type = 'corporation'
      AND si.owner_corporation_id IS NOT NULL
  LOOP
    PERFORM public.ensure_character_queue(v_ship_id);
  END LOOP;
END;
$$;
