-- Optimistic-concurrency-control update for sector_contents.combat.
--
-- Combat state is read-modify-written from four edge functions
-- (move arrival hook, combat_action, combat_initiate, combat_tick) on
-- different connections (REST and pg). Without serialization, two
-- writers loading the blob simultaneously can clobber each other —
-- e.g. a mid-encounter join arriving while combat_tick is resolving a
-- round can drop either the joiner or the resolution depending on who
-- writes second.
--
-- This function takes a compare-and-swap update keyed on the encounter
-- blob's `last_updated` field. Callers capture the loaded encounter's
-- `last_updated` at read time and pass it as `p_expected`. If the
-- current row's `last_updated` matches, the update commits; otherwise
-- the function returns false and the caller can retry from a fresh
-- read.
--
-- The `IS NOT DISTINCT FROM` operator handles a NULL expected value
-- correctly (treats NULL = NULL as true), which lets a "first write"
-- caller skip CAS by passing NULL explicitly.

CREATE OR REPLACE FUNCTION cas_update_combat(
  p_sector_id INTEGER,
  p_expected_last_updated TEXT,
  p_new_combat JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated_count INTEGER;
BEGIN
  UPDATE sector_contents
  SET combat = p_new_combat,
      updated_at = NOW()
  WHERE sector_id = p_sector_id
    AND (
      p_expected_last_updated IS NULL
      OR (combat->>'last_updated') IS NOT DISTINCT FROM p_expected_last_updated
    );

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count > 0;
END;
$$;

COMMENT ON FUNCTION cas_update_combat(INTEGER, TEXT, JSONB) IS
  'CAS update for sector_contents.combat — used by edge functions to detect concurrent RMW of the encounter blob';

GRANT EXECUTE ON FUNCTION cas_update_combat(INTEGER, TEXT, JSONB) TO authenticated, service_role, anon;
