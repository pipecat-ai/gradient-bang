-- =============================================================================
-- Denormalize event recipients for events_since performance
-- Date: 2026-02-26
--
-- Moves recipient data from join tables (event_character_recipients,
-- event_broadcast_recipients) directly onto the events table. Multi-recipient
-- events get one row per recipient going forward; historical multi-recipient
-- events keep only one recipient (first by character_id) to avoid resurfacing
-- stale events with new IDs.
--
-- Target: collapse events_since from 6 queries across 3 tables to 1 query on 1 table.
-- =============================================================================

SET check_function_bodies = OFF;
SET search_path = public;

-- ---------------------------------------------------------------------------
-- 1. Add denormalized columns to events
-- ---------------------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN recipient_character_id UUID,
  ADD COLUMN recipient_reason TEXT,
  ADD COLUMN is_broadcast BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.events.recipient_character_id IS 'Character this event row is delivered to (one row per recipient).';
COMMENT ON COLUMN public.events.recipient_reason IS 'Why this character received the event (direct, task_owner, sector_snapshot, etc).';
COMMENT ON COLUMN public.events.is_broadcast IS 'TRUE for events visible to all subscribers.';

-- ---------------------------------------------------------------------------
-- 2. Backfill from existing recipient tables
-- ---------------------------------------------------------------------------

-- 2a. Backfill character recipients (pick first by character_id for multi-recipient events)
WITH first_recipient AS (
  SELECT DISTINCT ON (event_id) event_id, character_id, reason
  FROM public.event_character_recipients
  ORDER BY event_id, character_id
)
UPDATE public.events e
SET
  recipient_character_id = fr.character_id,
  recipient_reason = fr.reason
FROM first_recipient fr
WHERE fr.event_id = e.id;

-- 2b. Backfill broadcast flag
UPDATE public.events e
SET is_broadcast = TRUE
FROM public.event_broadcast_recipients ebr
WHERE ebr.event_id = e.id;

-- ---------------------------------------------------------------------------
-- 3. Create indexes for the new single-query polling pattern
-- ---------------------------------------------------------------------------

-- Primary polling index: WHERE recipient_character_id = $char AND id > $since
CREATE INDEX idx_events_recipient_character_id
  ON public.events (recipient_character_id, id ASC)
  WHERE recipient_character_id IS NOT NULL;

-- Broadcast events: WHERE is_broadcast = TRUE AND id > $since
CREATE INDEX idx_events_broadcast_id
  ON public.events (id ASC)
  WHERE is_broadcast = TRUE;

-- Corp events: WHERE corp_id = $corp AND id > $since
-- (replaces idx_events_corp_inserted which uses inserted_at DESC)
CREATE INDEX idx_events_corp_id_asc
  ON public.events (corp_id, id ASC)
  WHERE corp_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Replace record_event_with_recipients function
--    Same signature; internally inserts N rows (one per recipient) instead of
--    1 event + N recipient rows. Returns MIN(id) for backwards compatibility.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
);

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
BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN
    RAISE EXCEPTION 'recipient/reason length mismatch'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(array_length(p_recipients, 1), 0) > 0 THEN
    -- Insert one row per recipient
    WITH inserted AS (
      INSERT INTO public.events (
        direction, event_type, scope, actor_character_id, corp_id,
        sector_id, ship_id, character_id, sender_id, payload, meta,
        request_id, task_id, inserted_at,
        recipient_character_id, recipient_reason, is_broadcast
      )
      SELECT
        p_direction, p_event_type, p_scope, p_actor_character_id, p_corp_id,
        p_sector_id, p_ship_id, p_character_id, p_sender_id,
        COALESCE(p_payload, '{}'::jsonb), p_meta,
        p_request_id, p_task_id, v_now,
        recipient, reason, p_is_broadcast
      FROM UNNEST(p_recipients, p_reasons) AS t(recipient, reason)
      RETURNING id
    )
    SELECT MIN(id) INTO v_first_event_id FROM inserted;

  ELSIF p_is_broadcast THEN
    -- Broadcast with no character recipients: single row
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
      NULL, NULL, TRUE
    ) RETURNING id INTO v_first_event_id;
  END IF;

  RETURN v_first_event_id;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts one event row per recipient with denormalized recipient_character_id/reason. Returns first event ID.';

GRANT EXECUTE ON FUNCTION public.record_event_with_recipients TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Update RLS policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS events_character_visibility ON public.events;
DROP POLICY IF EXISTS events_broadcast_visibility ON public.events;

CREATE POLICY events_character_visibility ON public.events
  FOR SELECT
  TO authenticated
  USING (recipient_character_id = auth.uid());

CREATE POLICY events_broadcast_visibility ON public.events
  FOR SELECT
  TO authenticated
  USING (is_broadcast = TRUE);

-- ---------------------------------------------------------------------------
-- 6. Update visible_events view to include new columns
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.visible_events;

CREATE VIEW public.visible_events AS
SELECT
  e.id,
  e.event_type,
  e.timestamp,
  e.payload,
  e.scope,
  e.actor_character_id,
  e.sector_id,
  e.corp_id,
  e.task_id,
  e.inserted_at,
  e.request_id,
  e.meta,
  e.direction,
  e.character_id,
  e.sender_id,
  e.ship_id,
  e.recipient_character_id,
  e.recipient_reason,
  e.is_broadcast
FROM public.events e;

COMMENT ON VIEW public.visible_events IS 'Client-facing view for postgres_changes + event replay; enforced via events RLS policies.';

GRANT SELECT ON public.visible_events TO authenticated;
GRANT SELECT ON public.visible_events TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Drop old recipient tables and their indexes
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_event_character_recipients_character_event;
DROP INDEX IF EXISTS idx_event_character_recipients_event;
DROP INDEX IF EXISTS idx_event_character_recipients_char_event_asc;
DROP INDEX IF EXISTS idx_event_broadcast_recipients_event;

DROP TABLE IF EXISTS public.event_broadcast_recipients;
DROP TABLE IF EXISTS public.event_character_recipients;
