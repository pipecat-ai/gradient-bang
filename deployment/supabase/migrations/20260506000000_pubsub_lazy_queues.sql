-- =============================================================================
-- pubsub: lazy queue creation
--
-- Stops the server from auto-creating a per-character pgmq queue at character
-- INSERT. Queues are now created on the first authorized `subscribe_my_events`
-- call, and `pgmq_publish` silently no-ops when the target queue does not
-- exist. Net effect: polling-only deployments do zero pgmq work.
--
-- Existing queues created by the previous migration's backfill are NOT
-- dropped — that would be destructive on prod and is outside this change.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_ensure_character_queue ON public.characters;
DROP FUNCTION IF EXISTS public._tg_ensure_character_queue();

-- subscribe_my_events: same as 20260505000000_pubsub_and_broadcasts.sql, but
-- with a lazy ensure_character_queue() call after the ownership check.

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

  -- Lazy: queue only exists once an authorized subscriber has connected.
  PERFORM public.ensure_character_queue(p_character_id);

  RETURN QUERY
    SELECT * FROM pgmq.read_with_poll(
      'chr_' || p_character_id::text,
      10,
      p_qty,
      p_max_seconds,
      250
    );
END;
$$;

-- pgmq_publish: tolerate missing queue (polling-only deployments). Returns
-- NULL when the target queue has never been subscribed to. Both call sites
-- (events.ts:287, pg_queries.ts:2710) ignore the returned msg_id.

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
  WHEN undefined_table THEN
    RETURN NULL;
END;
$$;
