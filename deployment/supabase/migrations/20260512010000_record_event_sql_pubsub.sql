-- =============================================================================
-- Canonical event pubsub publishing from SQL
-- Date: 2026-05-12
--
-- `record_event_with_recipients` is the authoritative event writer. Pubsub
-- delivery must live here too, otherwise events emitted by SQL-only functions
-- (quest progress/rewards, triggers, RPCs) are visible to polling but never
-- reach per-character pgmq queues.
--
-- This replaces the JS dual-write path. Edge functions still format payloads
-- and call this RPC; SQL now owns the persistence + delivery boundary.
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

  -- Seed the pgmq recipient map from explicit recipients. This mirrors the old
  -- JS publisher: first reason wins for duplicate recipient ids.
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

  -- Fetch corp-delivery set: active members + corp-owned ship pseudo-chars.
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

    -- Build the same tagged delivery map as the old JS path. Ships are loaded
    -- first, members override if an id appears in both sets.
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

  -- Individual recipient rows (corp_id is always NULL on these).
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

  -- Corp row: one row for the corporation.
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

  -- Broadcast row (corp_id is NULL, no individual recipient).
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

  -- Mirror the old JS pgmq corp expansion predicate:
  --   - expand corp-scoped events,
  --   - expand events whose subject/direct recipient is a corp ship,
  --   - expand actorless/system-ish corp events,
  --   - do not expand a human member's personal event to corpmates.
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

    -- When active human members exist and a corp-ship event expands to them,
    -- suppress the corp ship pseudo-character queue to avoid competing-consumer
    -- duplicate/lost delivery.
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

  -- Broadcast delivery is LISTEN/NOTIFY fanout, not pgmq.
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

    BEGIN
      PERFORM public.pgmq_publish('chr_' || v_id::TEXT, v_msg);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'record_event_with_recipients pgmq_publish failed for event_type=% recipient=%: %',
        p_event_type, v_id, SQLERRM;
    END;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts denormalized event rows and publishes the same event to SQL-owned pubsub delivery (per-character pgmq or broadcast NOTIFY). Recipients in the corp-delivery set (active corp members + corp-owned ship pseudo-chars) are excluded from individual rows when corp_id is set; pgmq delivery mirrors the existing corp expansion rules.';

GRANT EXECUTE ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) TO service_role;
