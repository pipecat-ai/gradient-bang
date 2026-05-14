-- =============================================================================
-- Batched scoped PGMQ polling
-- Date: 2026-05-14
--
-- The bot should keep one scoped PGMQ reader connection per session, not one
-- poll loop/connection per character queue. These helpers keep the hot path
-- direct-to-Postgres while preserving trusted-bot authorization:
--
--   EDGE_API_TOKEN proves the caller is the backend bot.
--   can_actor_access_character proves the actor can read each requested queue.
-- =============================================================================

SET check_function_bodies = OFF;
SET search_path = public;

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
