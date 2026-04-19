-- ============================================================================
-- Disable Event Pruning Cron & Extend Retention to 14 Days
-- ============================================================================
-- The 72-hour retention was too aggressive. This migration:
--   1. Unschedules the hourly cron so pruning is off by default
--   2. Updates the function to use a 14-day retention window
--
-- The function and index remain available for manual use:
--   SELECT prune_stale_events();
--
-- To re-enable automatic pruning:
--   SELECT cron.schedule(
--     'event-pruning-worker', '0 * * * *',
--     $$SELECT prune_stale_events();$$
--   );
-- ============================================================================

-- Unschedule the cron job (no-op if already unscheduled)
SELECT cron.unschedule('event-pruning-worker');

-- Update function: 72 hours -> 14 days
CREATE OR REPLACE FUNCTION prune_stale_events()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  prunable_types TEXT[] := ARRAY[
    'map.update', 'map.local', 'map.region', 'map.knowledge',
    'status.snapshot', 'status.update',
    'sector.update', 'port.update',
    'ship.definitions', 'ships.list', 'ports.list',
    'path.region',
    'movement.start', 'course.plot',
    'combat.action_accepted', 'combat.round_waiting',
    'task.start', 'task.finish', 'task.cancel',
    'event.query'
  ];
  batch_size CONSTANT INTEGER := 5000;
  max_rows_per_run CONSTANT INTEGER := 500000;
  cutoff TIMESTAMPTZ := NOW() - INTERVAL '14 days';
  rows_deleted INTEGER;
  total_deleted INTEGER := 0;
BEGIN
  LOOP
    DELETE FROM public.events
    WHERE id IN (
      SELECT id FROM public.events
      WHERE event_type = ANY(prunable_types)
        AND inserted_at < cutoff
      LIMIT batch_size
    );

    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    total_deleted := total_deleted + rows_deleted;

    EXIT WHEN rows_deleted < batch_size;
    EXIT WHEN total_deleted >= max_rows_per_run;
  END LOOP;

  RAISE LOG 'prune_stale_events: deleted % rows (cutoff: %)', total_deleted, cutoff;
  RETURN total_deleted;
END;
$$;

COMMENT ON FUNCTION prune_stale_events() IS
'Prune non-important events older than 14 days. NOT scheduled by default — call manually or re-enable via cron.schedule. Deletes in 5k-row batches, capped at 500k per run.';
