-- Supabase Events RLS + Recipient Snapshot migration
-- Date: 2025-11-10

SET check_function_bodies = OFF;
SET search_path = public;

-- ---------------------------------------------------------------------------
-- 1. Extend events table with scope + auditing fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'direct'
    CHECK (scope IN ('direct','sector','corp','broadcast','gm_broadcast','self','system','admin')),
  ADD COLUMN actor_character_id UUID,
  ADD COLUMN corp_id UUID REFERENCES public.corporations(corp_id),
  ADD COLUMN inserted_at TIMESTAMPTZ;

UPDATE public.events
SET inserted_at = COALESCE(inserted_at, timestamp);

ALTER TABLE public.events
  ALTER COLUMN inserted_at SET NOT NULL,
  ALTER COLUMN inserted_at SET DEFAULT NOW();

COMMENT ON COLUMN public.events.scope IS 'Routing hint for downstream policies (direct, sector, corp, broadcast, gm_broadcast, self, system, admin).';
COMMENT ON COLUMN public.events.actor_character_id IS 'Character that triggered the event (nullable for system/GMs).';
COMMENT ON COLUMN public.events.corp_id IS 'Primary corporation referenced by the event (auditing only).';
COMMENT ON COLUMN public.events.inserted_at IS 'Insertion timestamp for ordering + retention policies.';

-- ---------------------------------------------------------------------------
-- 2. Recipient tables (normalized visibility snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_character_recipients (
  event_id BIGINT NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES public.characters(character_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) > 0),
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, character_id)
);

COMMENT ON TABLE public.event_character_recipients IS 'Visibility snapshot per character per event.';
COMMENT ON COLUMN public.event_character_recipients.reason IS 'Tag describing which scope granted access (sector_snapshot, corp_snapshot, direct, etc).';

CREATE TABLE IF NOT EXISTS public.event_broadcast_recipients (
  event_id BIGINT PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.event_broadcast_recipients IS 'Marker for events that should reach every subscriber (gm/system broadcasts).';

CREATE INDEX IF NOT EXISTS idx_event_character_recipients_character_event
  ON public.event_character_recipients (character_id, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_event_character_recipients_event
  ON public.event_character_recipients (event_id);

CREATE INDEX IF NOT EXISTS idx_event_broadcast_recipients_event
  ON public.event_broadcast_recipients (event_id);

CREATE INDEX IF NOT EXISTS idx_events_actor_inserted
  ON public.events (actor_character_id, inserted_at DESC)
  WHERE actor_character_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_corp_inserted
  ON public.events (corp_id, inserted_at DESC)
  WHERE corp_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Helper functions for JWT inspection + record_event workflow
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jwt_claim(claim_name TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN claim_name IS NULL THEN NULL
    ELSE (
      COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), ''), '{}')::jsonb ->> claim_name
    )
  END;
$$;

COMMENT ON FUNCTION public.jwt_claim(TEXT) IS 'Extracts a single claim from the Supabase JWT (NULL when unavailable).';

CREATE OR REPLACE FUNCTION public.is_service_role()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(public.jwt_claim('role') = 'service_role', FALSE);
$$;

COMMENT ON FUNCTION public.is_service_role() IS 'Returns TRUE when the current JWT belongs to the Supabase service role.';

CREATE OR REPLACE FUNCTION public.has_admin_claim()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(lower(public.jwt_claim('is_admin')) IN ('1','true','t','yes'), FALSE);
$$;

COMMENT ON FUNCTION public.has_admin_claim() IS 'Checks for an is_admin=true claim inside the caller JWT.';

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
  p_is_broadcast BOOLEAN DEFAULT FALSE
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
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN
) IS 'Atomically inserts an event row and snapshots its recipients for RLS-backed delivery.';

GRANT EXECUTE ON FUNCTION public.record_event_with_recipients TO service_role;

-- ---------------------------------------------------------------------------
-- 4. RLS-facing view + policies
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

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

CREATE POLICY events_service_select ON public.events
  FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY events_service_insert ON public.events
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY events_character_visibility ON public.events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.event_character_recipients r
      WHERE r.event_id = events.id
        AND r.character_id = auth.uid()
    )
  );

CREATE POLICY events_broadcast_visibility ON public.events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.event_broadcast_recipients b
      WHERE b.event_id = events.id
    )
  );

CREATE POLICY events_self_visibility ON public.events
  FOR SELECT
  TO authenticated
  USING (
    events.scope IN ('self','system')
    AND events.actor_character_id = auth.uid()
  );

CREATE POLICY events_admin_override ON public.events
  FOR SELECT
  TO authenticated
  USING (public.has_admin_claim() OR public.is_service_role());

CREATE POLICY events_deny_insert ON public.events
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.events;
  END IF;
END;
$$;
