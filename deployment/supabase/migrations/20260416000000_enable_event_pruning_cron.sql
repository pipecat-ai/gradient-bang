-- ============================================================================
-- Enable Hourly Event Pruning Worker
-- ============================================================================
-- Prunes non-important events older than 72 hours to control table growth.
-- Events are fire-and-forget: consumed via polling and not used for game state
-- reconstruction. Only meaningful gameplay events (combat outcomes, trades,
-- quests, chat, corp actions, etc.) are retained for activity history.
--
-- Prunable event types fall into two categories:
--   1. Data sync / UI state pushes (map.*, status.*, sector/port/ship defs)
--   2. Transient lifecycle events (task.*, movement.start, error, etc.)
--
-- Uses pg_cron (already enabled for combat-tick-worker and port-regeneration).
-- Deletes in batches to avoid long-held locks.
-- ============================================================================

-- Partial index: only covers prunable event types, so it stays small.
-- NOTE: if the prunable types list changes, update BOTH this index AND the
-- function body below in the same migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_prunable_inserted
  ON public.events (inserted_at)
  WHERE event_type = ANY(ARRAY[
    'map.update', 'map.local', 'map.region', 'map.knowledge',
    'status.snapshot', 'status.update',
    'sector.update', 'port.update',
    'ship.definitions', 'ships.list', 'ports.list',
    'path.region',
    'movement.start', 'course.plot',
    'combat.action_accepted', 'combat.round_waiting',
    'task.start', 'task.finish', 'task.cancel',
    'event.query'
  ]);

-- Prune function: batched deletes, capped per invocation
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
  cutoff TIMESTAMPTZ := NOW() - INTERVAL '72 hours';
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
'Prune non-important events older than 72 hours. Called hourly by cron. Deletes in 5k-row batches, capped at 500k per run.';

-- Schedule hourly at minute 0 (same cadence as port-regeneration-worker)
SELECT cron.schedule(
  'event-pruning-worker',
  '0 * * * *',
  $$SELECT prune_stale_events();$$
);

-- ============================================================================
-- Verification Queries
-- ============================================================================
-- Check if job is scheduled:
-- SELECT * FROM cron.job WHERE jobname = 'event-pruning-worker';
--
-- View recent job runs:
-- SELECT * FROM cron.job_run_details
-- WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'event-pruning-worker')
-- ORDER BY start_time DESC LIMIT 10;
--
-- Manually trigger pruning:
-- SELECT prune_stale_events();
--
-- Check prunable event counts by age:
-- SELECT event_type, COUNT(*),
--        MIN(inserted_at) AS oldest,
--        MAX(inserted_at) AS newest
-- FROM events
-- WHERE event_type = ANY(ARRAY[
--   'map.update','map.local','map.region','map.knowledge',
--   'status.snapshot','status.update','sector.update','port.update',
--   'ship.definitions','ships.list','ports.list','path.region',
--   'movement.start','course.plot',
--   'combat.action_accepted','combat.round_waiting',
--   'task.start','task.finish','task.cancel','event.query'
-- ])
-- GROUP BY event_type ORDER BY COUNT(*) DESC;
-- ============================================================================
