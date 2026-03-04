-- =============================================================================
-- Add missing ship_id index on events + optimize record_event_with_recipients
-- Date: 2026-03-04
--
-- Index: Supabase recommended btree indexes on events for event_type, ship_id,
-- character_id, and recipient_character_id. Three of four are already covered
-- by existing composite indexes (idx_events_type, idx_events_character,
-- idx_events_recipient_character_id). Only ship_id is genuinely missing.
--
-- Function optimization: record_event_with_recipients queried
-- corporation_members twice when p_corp_id was set. This revision:
--   1. Uses a single CTE to fetch active corp member IDs once
--   2. Replaces NOT IN (subselect) with array membership check
--   3. Changes return type from BIGINT to VOID (no caller uses the ID)
--   4. Removes all RETURNING / currval overhead
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add missing ship_id index
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_ship_id
  ON public.events USING btree (ship_id)
  WHERE ship_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Drop + recreate (return type change requires DROP)
-- ---------------------------------------------------------------------------
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
BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN
    RAISE EXCEPTION 'recipient/reason length mismatch'
      USING ERRCODE = '22023';
  END IF;

  -- Fetch active corp member IDs once (used for both subject check and
  -- individual-row exclusion). Only queries corporation_members when needed.
  IF p_corp_id IS NOT NULL AND (p_character_id IS NOT NULL OR v_has_recipients) THEN
    SELECT ARRAY_AGG(cm.character_id)
    INTO v_corp_member_ids
    FROM public.corporation_members cm
    WHERE cm.corp_id = p_corp_id
      AND cm.left_at IS NULL;

    v_corp_member_ids := COALESCE(v_corp_member_ids, ARRAY[]::UUID[]);

    IF p_character_id IS NOT NULL THEN
      v_subject_is_corp_member := p_character_id = ANY(v_corp_member_ids);
    END IF;
  END IF;

  -- Individual recipient rows (corp_id is always NULL on these).
  -- When a corp_id is provided, ALL active corp members are excluded —
  -- they receive the event via the corp row instead.
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
  -- When the subject is a corp member, set recipient_character_id so the
  -- subject can also find this event by character_id alone (without needing
  -- corp_id in the poll). This merges individual + corp delivery into one row.
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
) IS 'Inserts denormalized event rows (one-of individual/corp/broadcast per row). Corp members are excluded from individual rows when corp_id is set; they receive events via the corp row. When the subject is a corp member, the corp row includes their character_id for fallback delivery.';
