-- World Events
-- Time-bounded competitive events that players join at character creation via a secret code.
-- Events scope the leaderboard to participants, freeze results when the event ends,
-- and stay visible for a configurable window afterward.

-- ============================================================================
-- World Events Table
-- ============================================================================

CREATE TABLE world_events (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  join_code     TEXT NOT NULL UNIQUE,
  link_url      TEXT,
  image_url     TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  visible_until TIMESTAMPTZ NOT NULL,
  frozen_results JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (visible_until >= ends_at)
);

CREATE INDEX idx_world_events_visible ON world_events(visible_until);

COMMENT ON TABLE world_events IS 'Time-bounded competitive events with join codes';
COMMENT ON COLUMN world_events.join_code IS 'Secret code players enter at character creation to join';
COMMENT ON COLUMN world_events.frozen_results IS 'Snapshot of leaderboard at event end; NULL while running';
COMMENT ON COLUMN world_events.visible_until IS 'Event stays visible until this time (typically ends_at + 48h)';

-- ============================================================================
-- World Event Participants (one event per character)
-- ============================================================================

CREATE TABLE world_event_participants (
  event_id     UUID NOT NULL REFERENCES world_events(event_id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(character_id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, character_id),
  UNIQUE (character_id)
);

CREATE INDEX idx_wep_event ON world_event_participants(event_id);

COMMENT ON TABLE world_event_participants IS 'Junction table linking characters to their event (max one per character)';

-- ============================================================================
-- Extend leaderboard_cache for event-scoped caching
-- ============================================================================

-- Drop the singleton CHECK constraint so we can add event cache rows
ALTER TABLE leaderboard_cache DROP CONSTRAINT leaderboard_cache_id_check;

-- Add event_id column (NULL = global cache, UUID = event-specific cache)
ALTER TABLE leaderboard_cache ADD COLUMN event_id UUID REFERENCES world_events(event_id) ON DELETE CASCADE;

-- Ensure one cache row per event and one global row
CREATE UNIQUE INDEX idx_leaderboard_cache_event ON leaderboard_cache(event_id) WHERE event_id IS NOT NULL;

-- Make id auto-increment for new rows
ALTER TABLE leaderboard_cache ALTER COLUMN id SET DEFAULT nextval(pg_get_serial_sequence('leaderboard_cache', 'id'));

-- Create a sequence if one doesn't exist (the original table used DEFAULT 1)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE 'leaderboard_cache%') THEN
    CREATE SEQUENCE leaderboard_cache_id_seq OWNED BY leaderboard_cache.id;
    PERFORM setval('leaderboard_cache_id_seq', 1);
    ALTER TABLE leaderboard_cache ALTER COLUMN id SET DEFAULT nextval('leaderboard_cache_id_seq');
  END IF;
END $$;

-- ============================================================================
-- Validate event join code
-- ============================================================================

CREATE OR REPLACE FUNCTION validate_event_join_code(p_join_code TEXT)
RETURNS UUID AS $$
  SELECT event_id FROM world_events
  WHERE lower(trim(join_code)) = lower(trim(p_join_code))
    AND starts_at <= NOW()
    AND ends_at > NOW();
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION validate_event_join_code IS 'Returns event_id if code matches a currently running event, NULL otherwise';

-- ============================================================================
-- Freeze event results (snapshot leaderboard at event end)
-- ============================================================================

CREATE OR REPLACE FUNCTION freeze_world_event_results(p_event_id UUID)
RETURNS void AS $$
DECLARE
  v_participant_ids UUID[];
  v_results JSONB;
BEGIN
  SELECT array_agg(character_id) INTO v_participant_ids
  FROM world_event_participants WHERE event_id = p_event_id;

  IF v_participant_ids IS NULL THEN
    v_results := jsonb_build_object(
      'wealth', '[]'::jsonb,
      'territory', '[]'::jsonb,
      'trading', '[]'::jsonb,
      'exploration', '[]'::jsonb,
      'frozen_at', to_jsonb(NOW())
    );
  ELSE
    SELECT jsonb_build_object(
      'wealth', COALESCE((
        SELECT jsonb_agg(row_to_json(w) ORDER BY w.total_wealth DESC)
        FROM leaderboard_wealth w WHERE w.character_id = ANY(v_participant_ids)
      ), '[]'::jsonb),
      'territory', COALESCE((
        SELECT jsonb_agg(row_to_json(t) ORDER BY t.sectors_controlled DESC)
        FROM leaderboard_territory t WHERE t.character_id = ANY(v_participant_ids)
      ), '[]'::jsonb),
      'trading', COALESCE((
        SELECT jsonb_agg(row_to_json(tr) ORDER BY tr.total_trade_volume DESC)
        FROM leaderboard_trading tr WHERE tr.character_id = ANY(v_participant_ids)
      ), '[]'::jsonb),
      'exploration', COALESCE((
        SELECT jsonb_agg(row_to_json(e) ORDER BY e.sectors_visited DESC)
        FROM leaderboard_exploration e WHERE e.character_id = ANY(v_participant_ids)
      ), '[]'::jsonb),
      'frozen_at', to_jsonb(NOW())
    ) INTO v_results;
  END IF;

  UPDATE world_events SET frozen_results = v_results WHERE event_id = p_event_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION freeze_world_event_results IS 'Snapshots leaderboard data for event participants and stores in frozen_results';

-- ============================================================================
-- Cron job: freeze ended events every minute
-- ============================================================================

SELECT cron.schedule(
  'freeze-ended-world-events',
  '* * * * *',
  $$SELECT freeze_world_event_results(event_id)
    FROM world_events
    WHERE ends_at <= NOW() AND frozen_results IS NULL;$$
);
