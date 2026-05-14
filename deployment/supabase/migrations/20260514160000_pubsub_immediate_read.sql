-- =============================================================================
-- Pubsub immediate-read subscriber
-- Date: 2026-05-14
--
-- Do not call pgmq.read_with_poll from inside the SECURITY DEFINER wrapper.
-- When wrapped in one SQL statement, the poll can miss rows enqueued after the
-- statement starts and add a full poll-window of event latency. The bot adapter
-- owns the polling cadence; this wrapper authenticates then performs one
-- immediate read.
-- =============================================================================

SET check_function_bodies = OFF;
SET search_path = public;

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
  'Authenticated immediate read from a per-character pgmq queue. Verifies an internal HS256 token minted by verify_token, checks ownership, and returns up to p_qty messages. Poll cadence is owned by the bot adapter to avoid read_with_poll latency inside a SECURITY DEFINER wrapper.';

REVOKE ALL ON FUNCTION public.subscribe_my_events(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscribe_my_events(uuid, text, integer, integer) TO service_role;
