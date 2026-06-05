-- ============================================================================
-- Fix destroyed ship leaderboard ghost wealth and add safe retention pruning
-- ============================================================================
-- The corporation-aware leaderboard view added on 2026-04-14 dropped the
-- destroyed_at filter from the older soft-delete migration, so destroyed ships
-- can still contribute wealth.
--
-- This migration:
--   1. Rebuilds leaderboard_wealth so both personal and corporation ship
--      aggregates exclude destroyed ships.
--   2. Adds a scheduled prune_destroyed_ships() function for old destroyed ship
--      rows, rewriting historical references before deleting ship rows.
-- ============================================================================

DROP VIEW IF EXISTS leaderboard_wealth;
CREATE VIEW leaderboard_wealth AS
WITH personal_ship_wealth AS (
  SELECT
    si.owner_id AS character_id,
    COUNT(*) AS ship_count,
    SUM(si.credits) AS total_ship_credits,
    SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100) AS total_cargo_value,
    SUM(sd.base_value) AS total_ship_value
  FROM ship_instances si
  JOIN ship_definitions sd ON si.ship_type = sd.ship_type
  WHERE NOT si.is_escape_pod
    AND si.destroyed_at IS NULL
    AND si.owner_type IS DISTINCT FROM 'corporation'
  GROUP BY si.owner_id
),
corp_ship_wealth AS (
  SELECT
    si.owner_corporation_id AS corp_id,
    COUNT(*) AS corp_ship_count,
    SUM(si.credits) AS corp_ship_credits,
    SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100) AS corp_cargo_value,
    SUM(sd.base_value) AS corp_ship_value
  FROM ship_instances si
  JOIN ship_definitions sd ON si.ship_type = sd.ship_type
  WHERE NOT si.is_escape_pod
    AND si.destroyed_at IS NULL
    AND si.owner_type = 'corporation'
    AND si.owner_corporation_id IS NOT NULL
  GROUP BY si.owner_corporation_id
)
SELECT
  c.character_id,
  c.name,
  CASE
    WHEN c.is_npc = TRUE THEN 'npc'
    ELSE 'human'
  END AS player_type,
  c.credits_in_megabank AS bank_credits,
  (COALESCE(psw.total_ship_credits, 0) + COALESCE(csw.corp_ship_credits, 0)) AS ship_credits,
  (COALESCE(psw.total_cargo_value, 0) + COALESCE(csw.corp_cargo_value, 0)) AS cargo_value,
  (COALESCE(psw.ship_count, 0) + COALESCE(csw.corp_ship_count, 0)) AS ships_owned,
  (COALESCE(psw.total_ship_value, 0) + COALESCE(csw.corp_ship_value, 0)) AS ship_value,
  (
    c.credits_in_megabank
    + COALESCE(psw.total_ship_credits, 0)
    + COALESCE(psw.total_cargo_value, 0)
    + COALESCE(psw.total_ship_value, 0)
    + COALESCE(csw.corp_ship_credits, 0)
    + COALESCE(csw.corp_cargo_value, 0)
    + COALESCE(csw.corp_ship_value, 0)
  ) AS total_wealth
FROM characters c
LEFT JOIN personal_ship_wealth psw ON psw.character_id = c.character_id
LEFT JOIN corp_ship_wealth csw ON csw.corp_id = c.corporation_id
WHERE c.player_metadata->>'player_type' IS DISTINCT FROM 'corporation_ship'
ORDER BY total_wealth DESC;

CREATE OR REPLACE FUNCTION prune_destroyed_ships()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  retention_window CONSTANT INTERVAL := INTERVAL '14 days';
  batch_size CONSTANT INTEGER := 5000;
  max_rows_per_run CONSTANT INTEGER := 500000;
  cutoff TIMESTAMPTZ := NOW() - retention_window;
  rows_deleted INTEGER;
  total_deleted INTEGER := 0;
BEGIN
  LOOP
    WITH deletable AS (
      SELECT si.ship_id
      FROM public.ship_instances si
      WHERE si.destroyed_at IS NOT NULL
        AND si.destroyed_at < cutoff
        AND NOT EXISTS (
          SELECT 1
          FROM public.characters c
          WHERE c.current_ship_id = si.ship_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.corporation_ships cs
          WHERE cs.ship_id = si.ship_id
        )
      ORDER BY si.destroyed_at
      LIMIT batch_size
    ), scrub_events AS (
      UPDATE public.events e
      SET ship_id = NULL
      FROM deletable d
      WHERE e.ship_id = d.ship_id
      RETURNING e.id
    ), scrub_port_transactions AS (
      DELETE FROM public.port_transactions pt
      USING deletable d
      WHERE pt.ship_id = d.ship_id
      RETURNING pt.id
    )
    DELETE FROM public.ship_instances si
    USING deletable d
    WHERE si.ship_id = d.ship_id;

    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    total_deleted := total_deleted + rows_deleted;

    EXIT WHEN rows_deleted < batch_size;
    EXIT WHEN total_deleted >= max_rows_per_run;
  END LOOP;

  RAISE LOG 'prune_destroyed_ships: deleted % rows (cutoff: %)', total_deleted, cutoff;
  RETURN total_deleted;
END;
$$;

COMMENT ON FUNCTION prune_destroyed_ships() IS
'Prune destroyed ship rows older than 14 days. Historical events are preserved by nulling ship_id before delete; port_transactions for pruned ships are deleted. Runs daily in 5k-row batches, capped at 500k per run.';

SELECT cron.schedule(
  'destroyed-ship-pruning-worker',
  '0 3 * * *',
  $$SELECT prune_destroyed_ships();$$
);
