-- =============================================================================
-- Fix duplicate event delivery for corp-ship pseudo-characters
-- Date: 2026-04-14
--
-- Background: corporation-owned ships are registered in `characters` as
-- pseudo-characters with `character_id = ship_id`. They are NOT rows in
-- `corporation_members`, so the exclusion logic added in
-- 20260304010000_events_ship_id_index_and_optimize_record_event.sql (which
-- merges individual + corp delivery into a single row for corp members) did
-- not cover them. The result: every event emitted via pgEmitCharacterEvent
-- for a corp ship produced both an individual row (recipient=pseudoChar)
-- AND a corp row (corp_id=corpA), and the bot poller (which subscribes with
-- both the pseudo-char id and the corp id) received the event twice.
--
-- Fix: extend the "corp delivery" exclusion set to also include ship_ids of
-- ships owned by the corporation. Since corp-ship pseudo-chars use
-- character_id = ship_id, unioning corp-owned ship_ids into
-- v_corp_member_ids makes the existing exclusion/merge logic apply to them.
-- =============================================================================

DROP FUNCTION IF EXISTS public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
);

SET check_function_bodies = OFF;
SET search_path = public;

CREATE FUNCTION public.record_event_with_recipients(
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
  v_has_recipients BOOLEAN := COALESCE(array_length(p_recipients, 1), 0) > 0;
  v_subject_is_corp_member BOOLEAN := FALSE;
  v_corp_member_ids UUID[];
  v_corp_ship_ids UUID[];
BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN
    RAISE EXCEPTION 'recipient/reason length mismatch'
      USING ERRCODE = '22023';
  END IF;

  -- Fetch corp-delivery exclusion set: all character_ids that receive this
  -- event via the corp row instead of an individual row. This includes:
  --   1. Active corporation members
  --   2. Corp-owned ship pseudo-characters (character_id = ship_id)
  -- Only queried when corp_id is set and we actually need the exclusion.
  IF p_corp_id IS NOT NULL AND (p_character_id IS NOT NULL OR v_has_recipients) THEN
    SELECT ARRAY_AGG(cm.character_id)
    INTO v_corp_member_ids
    FROM public.corporation_members cm
    WHERE cm.corp_id = p_corp_id
      AND cm.left_at IS NULL;

    v_corp_member_ids := COALESCE(v_corp_member_ids, ARRAY[]::UUID[]);

    SELECT ARRAY_AGG(si.ship_id)
    INTO v_corp_ship_ids
    FROM public.ship_instances si
    WHERE si.owner_type = 'corporation'
      AND si.owner_corporation_id = p_corp_id;

    v_corp_ship_ids := COALESCE(v_corp_ship_ids, ARRAY[]::UUID[]);

    v_corp_member_ids := v_corp_member_ids || v_corp_ship_ids;

    IF p_character_id IS NOT NULL THEN
      v_subject_is_corp_member := p_character_id = ANY(v_corp_member_ids);
    END IF;
  END IF;

  -- Individual recipient rows (corp_id is always NULL on these).
  -- When a corp_id is provided, ALL recipients in the exclusion set are
  -- skipped — they receive the event via the corp row instead.
  IF v_has_recipients THEN
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
       OR NOT (t.recipient = ANY(v_corp_member_ids));
  END IF;

  -- Corp row: one row for the corporation.
  -- When the subject is in the corp-delivery set (a corp member OR a
  -- corp-owned ship pseudo-char), set recipient_character_id so the subject
  -- can also find this event by character_id alone. This merges individual
  -- + corp delivery into one row.
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
      CASE WHEN v_subject_is_corp_member THEN p_character_id ELSE NULL END,
      'corp_broadcast', FALSE
    );
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
    );
  END IF;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts denormalized event rows (one-of individual/corp/broadcast per row). Recipients in the corp-delivery set (active corp members + corp-owned ship pseudo-chars) are excluded from individual rows when corp_id is set; they receive events via the corp row. When the subject is in that set, the corp row includes their character_id for fallback delivery.';
