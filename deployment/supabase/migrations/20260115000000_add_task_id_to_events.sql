-- Add task_id column to events table for tracking task-scoped event groups
-- Date: 2026-01-15

SET check_function_bodies = OFF;
SET search_path = public;

-- ---------------------------------------------------------------------------
-- 1. Add task_id column to events table
-- ---------------------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN task_id UUID;

COMMENT ON COLUMN public.events.task_id IS 'Optional task identifier for grouping events from a single TaskAgent execution.';

-- Create index for efficient task_id queries
CREATE INDEX IF NOT EXISTS idx_events_task_id
  ON public.events (task_id)
  WHERE task_id IS NOT NULL;

-- Composite index for task queries with timestamp filtering
CREATE INDEX IF NOT EXISTS idx_events_task_id_timestamp
  ON public.events (task_id, timestamp DESC)
  WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Update record_event_with_recipients function to accept task_id
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN
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
  v_event_id BIGINT;
  v_reason_counts JSONB;
BEGIN
  IF COALESCE(array_length(p_recipients, 1), 0) <> COALESCE(array_length(p_reasons, 1), 0) THEN
    RAISE EXCEPTION 'recipient/reason length mismatch'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.events (
    direction,
    event_type,
    scope,
    actor_character_id,
    corp_id,
    sector_id,
    ship_id,
    character_id,
    sender_id,
    payload,
    meta,
    request_id,
    task_id,
    inserted_at
  ) VALUES (
    p_direction,
    p_event_type,
    p_scope,
    p_actor_character_id,
    p_corp_id,
    p_sector_id,
    p_ship_id,
    p_character_id,
    p_sender_id,
    COALESCE(p_payload, '{}'::jsonb),
    p_meta,
    p_request_id,
    p_task_id,
    NOW()
  ) RETURNING id INTO v_event_id;

  IF COALESCE(array_length(p_recipients, 1), 0) > 0 THEN
    INSERT INTO public.event_character_recipients (event_id, character_id, reason)
    SELECT v_event_id, recipient, reason
    FROM UNNEST(p_recipients, p_reasons) AS t(recipient, reason)
    ON CONFLICT DO NOTHING;

    WITH reason_counts AS (
      SELECT reason, COUNT(*) AS cnt
      FROM UNNEST(p_recipients, p_reasons) AS t(_, reason)
      GROUP BY reason
    )
    SELECT jsonb_object_agg(reason, cnt)
    INTO v_reason_counts
    FROM reason_counts;

    IF v_reason_counts IS NOT NULL THEN
      RAISE LOG 'event.recipient_counts %', jsonb_build_object(
        'event_id', v_event_id,
        'scope', p_scope,
        'counts', v_reason_counts
      );
    END IF;
  END IF;

  IF p_is_broadcast THEN
    INSERT INTO public.event_broadcast_recipients (event_id)
    VALUES (v_event_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Atomically inserts an event row and snapshots its recipients for RLS-backed delivery. Supports optional task_id for grouping task-related events.';

GRANT EXECUTE ON FUNCTION public.record_event_with_recipients TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Update visible_events view to include task_id
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
  e.ship_id
FROM public.events e;

COMMENT ON VIEW public.visible_events IS 'Client-facing view for postgres_changes + event replay; enforced via events RLS policies.';

GRANT SELECT ON public.visible_events TO authenticated;
GRANT SELECT ON public.visible_events TO service_role;
