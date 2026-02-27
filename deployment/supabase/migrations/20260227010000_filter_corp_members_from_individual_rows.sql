-- =============================================================================
-- Filter corp members from individual recipient rows
-- Date: 2026-02-27
--
-- When both recipients and corp_id are provided, recipients who are active
-- members of the corp are excluded from individual rows — they receive the
-- event via the corp row instead. This avoids duplicate delivery for players
-- who match both the recipient_character_id and corp_id clauses in events_since.
-- =============================================================================

SET check_function_bodies = OFF;
SET search_path = public;

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
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first_event_id BIGINT;
  v_now TIMESTAMPTZ := NOW();
  v_has_recipients BOOLEAN := COALESCE(array_length(p_recipients, 1), 0) > 0;
BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN
    RAISE EXCEPTION 'recipient/reason length mismatch'
      USING ERRCODE = '22023';
  END IF;

  -- Individual recipient rows (corp_id is always NULL on these).
  -- When a corp_id is provided, skip recipients who are active members of
  -- that corp — they will receive the event via the corp row instead.
  IF v_has_recipients THEN
    WITH inserted AS (
      INSERT INTO public.events (
        direction, event_type, scope, actor_character_id, corp_id,
        sector_id, ship_id, character_id, sender_id, payload, meta,
        request_id, task_id, inserted_at,
        recipient_character_id, recipient_reason, is_broadcast
      )
      SELECT
        p_direction, p_event_type, p_scope, p_actor_character_id,
        NULL,  -- corp_id is NULL on individual rows
        p_sector_id, p_ship_id, p_character_id, p_sender_id,
        COALESCE(p_payload, '{}'::jsonb), p_meta,
        p_request_id, p_task_id, v_now,
        t.recipient, t.reason, FALSE
      FROM UNNEST(p_recipients, p_reasons) AS t(recipient, reason)
      WHERE p_corp_id IS NULL
         OR t.recipient NOT IN (
              SELECT cm.character_id
              FROM public.corporation_members cm
              WHERE cm.corp_id = p_corp_id
                AND cm.left_at IS NULL
            )
      RETURNING id
    )
    SELECT MIN(id) INTO v_first_event_id FROM inserted;
  END IF;

  -- Corp row (one row for the corporation, no individual recipient)
  IF p_corp_id IS NOT NULL AND NOT p_is_broadcast THEN
    INSERT INTO public.events (
      direction, event_type, scope, actor_character_id, corp_id,
      sector_id, ship_id, character_id, sender_id, payload, meta,
      request_id, task_id, inserted_at,
      recipient_character_id, recipient_reason, is_broadcast
    ) VALUES (
      p_direction, p_event_type, p_scope, p_actor_character_id, p_corp_id,
      p_sector_id, p_ship_id, p_character_id, p_sender_id,
      COALESCE(p_payload, '{}'::jsonb), p_meta,
      p_request_id, p_task_id, v_now,
      NULL, 'corp_broadcast', FALSE
    );
    -- Set first event id if no recipients were inserted
    IF v_first_event_id IS NULL THEN
      SELECT currval(pg_get_serial_sequence('public.events', 'id')) INTO v_first_event_id;
    END IF;
  END IF;

  -- Broadcast row (corp_id is NULL, no individual recipient)
  IF p_is_broadcast AND NOT v_has_recipients THEN
    INSERT INTO public.events (
      direction, event_type, scope, actor_character_id, corp_id,
      sector_id, ship_id, character_id, sender_id, payload, meta,
      request_id, task_id, inserted_at,
      recipient_character_id, recipient_reason, is_broadcast
    ) VALUES (
      p_direction, p_event_type, p_scope, p_actor_character_id,
      NULL,  -- corp_id is NULL on broadcast rows
      p_sector_id, p_ship_id, p_character_id, p_sender_id,
      COALESCE(p_payload, '{}'::jsonb), p_meta,
      p_request_id, p_task_id, v_now,
      NULL, NULL, TRUE
    ) RETURNING id INTO v_first_event_id;
  END IF;

  RETURN v_first_event_id;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts event rows enforcing one-of individual/corp/broadcast per row. Corp members are excluded from individual rows when corp_id is set. Returns first event ID.';
