-- Server-side ship-task lock + BYOA columns on ship_instances.
--
-- Today the "only one task per ship" invariant is enforced purely in the
-- VoiceAgent process (a local `_locked_ships` Python set). Nothing prevents
-- two corp members on different processes from starting concurrent tasks
-- on the same corp ship. This migration adds the columns + atomic RPCs
-- that make the lock real, plus the BYOA ownership columns that unlock the
-- broader BYOA roadmap (see docs/byoa.md).
--
-- Stale-lock recovery is layered: a lock with no heartbeat for
-- TASK_LOCK_HEARTBEAT_STALE_SECONDS (default 180s) is steal-eligible, as is
-- a lock older than TASK_LOCK_HARD_TTL_MINUTES (default 30 min) regardless
-- of heartbeats. Both numbers are passed as RPC parameters by the edge
-- functions so the windows are operator-tunable per deploy.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE ship_instances
  ADD COLUMN current_task_id          UUID NULL,
  ADD COLUMN task_started_at          TIMESTAMPTZ NULL,
  ADD COLUMN task_actor_character_id  UUID NULL,
  ADD COLUMN task_last_heartbeat_at   TIMESTAMPTZ NULL,
  ADD COLUMN byoa_owner_character_id  UUID NULL,
  ADD COLUMN byoa_mode                TEXT NOT NULL DEFAULT 'private'
    CHECK (byoa_mode IN ('private', 'shared'));

COMMENT ON COLUMN ship_instances.current_task_id IS
  'Active task UUID. NULL = ship is idle. Atomic mutex for task starts.';
COMMENT ON COLUMN ship_instances.task_started_at IS
  'When current_task_id was first acquired. Floor for hard-TTL staleness.';
COMMENT ON COLUMN ship_instances.task_actor_character_id IS
  'Character running the active task. Surfaced (truncated) in 409 responses and ship-list payloads.';
COMMENT ON COLUMN ship_instances.task_last_heartbeat_at IS
  'Most recent heartbeat from the lock holder. NULL means no heartbeat yet; staleness then falls back to task_started_at.';
COMMENT ON COLUMN ship_instances.byoa_owner_character_id IS
  'For BYOA corp ships: the player whose external agent controls this ship. NULL = not a BYOA ship.';
COMMENT ON COLUMN ship_instances.byoa_mode IS
  'BYOA-only: ''private'' (only owner can issue tasks) or ''shared'' (any corp member can). Inert when byoa_owner_character_id IS NULL.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- One task UUID never spans two ships. Partial unique index lets idle
-- (current_task_id IS NULL) rows coexist.
CREATE UNIQUE INDEX ship_instances_current_task_id_uniq
  ON ship_instances(current_task_id)
  WHERE current_task_id IS NOT NULL;

-- Used by the acquire RPC's staleness predicate.
CREATE INDEX ship_instances_task_last_heartbeat_idx
  ON ship_instances(task_last_heartbeat_at)
  WHERE task_last_heartbeat_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill from recent task.start events.
--
-- A ship's most recent task.start within the backfill window is treated as
-- still-active if no task.finish or task.cancel has been emitted for that
-- task_id since the start. Heartbeat is set to NOW() so existing in-flight
-- tasks at deploy time get a fresh window before being deemed stale.
--
-- Window: 60 minutes by default. Lifted from runtime env so this is purely
-- compile-time SQL, but keep in sync with TASK_LOCK_BACKFILL_WINDOW_MINUTES
-- when adjusting the migration.
-- ---------------------------------------------------------------------------

WITH latest_starts AS (
  SELECT DISTINCT ON (ship_id)
    ship_id,
    task_id,
    actor_character_id,
    inserted_at
  FROM events
  WHERE event_type = 'task.start'
    AND direction = 'event_out'
    AND inserted_at > NOW() - INTERVAL '60 minutes'
    AND ship_id IS NOT NULL
    AND task_id IS NOT NULL
  ORDER BY ship_id, inserted_at DESC
),
unfinished AS (
  SELECT ls.*
  FROM latest_starts ls
  WHERE NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.task_id = ls.task_id
      AND e.event_type IN ('task.finish', 'task.cancel')
      AND e.inserted_at >= ls.inserted_at
  )
)
UPDATE ship_instances si
SET current_task_id        = u.task_id,
    task_started_at        = u.inserted_at,
    task_actor_character_id = u.actor_character_id,
    task_last_heartbeat_at = NOW()
FROM unfinished u
WHERE si.ship_id = u.ship_id;

-- ---------------------------------------------------------------------------
-- RPC: acquire_ship_task_lock
--
-- Atomically transitions a ship from idle (or stale-held) to held-by-task.
-- Returns:
--   { acquired: true,
--     stolen_task_id: <uuid or null>,
--     stolen_actor_character_id: <uuid or null> }
-- on success. `stolen_task_id` is non-null when the prior holder was stale
-- and got displaced — the edge function should emit a task.cancel event
-- so the displaced actor's session reflects the loss.
--
-- Returns:
--   { acquired: false,
--     current_task_id, current_actor_character_id, current_task_started_at }
-- when the lock is held by a non-stale holder.
--
-- Returns:
--   { acquired: false, error: 'ship_not_found' }
-- when the ship row doesn't exist.
--
-- SELECT FOR UPDATE serializes concurrent acquires on the same ship_id row
-- without blocking acquires against different ships.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION acquire_ship_task_lock(
  p_ship_id UUID,
  p_task_id UUID,
  p_actor_character_id UUID,
  p_stale_seconds INTEGER DEFAULT 180,
  p_hard_ttl_minutes INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_stale_cutoff      TIMESTAMPTZ := NOW() - (p_stale_seconds || ' seconds')::INTERVAL;
  v_hard_ttl_cutoff   TIMESTAMPTZ := NOW() - (p_hard_ttl_minutes || ' minutes')::INTERVAL;
  v_current_task_id   UUID;
  v_current_actor     UUID;
  v_current_started   TIMESTAMPTZ;
  v_current_heartbeat TIMESTAMPTZ;
  v_stolen_task_id    UUID;
  v_stolen_actor      UUID;
BEGIN
  SELECT current_task_id, task_actor_character_id, task_started_at, task_last_heartbeat_at
    INTO v_current_task_id, v_current_actor, v_current_started, v_current_heartbeat
  FROM ship_instances
  WHERE ship_id = p_ship_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('acquired', FALSE, 'error', 'ship_not_found');
  END IF;

  -- Steal-eligible when idle, heartbeat-stale, no-heartbeat-but-started-stale,
  -- or past hard TTL regardless of heartbeats.
  IF v_current_task_id IS NULL
     OR (v_current_heartbeat IS NOT NULL AND v_current_heartbeat < v_stale_cutoff)
     OR (v_current_heartbeat IS NULL    AND v_current_started   < v_stale_cutoff)
     OR (v_current_started   < v_hard_ttl_cutoff)
  THEN
    v_stolen_task_id := v_current_task_id;
    v_stolen_actor   := v_current_actor;

    UPDATE ship_instances
    SET current_task_id        = p_task_id,
        task_started_at        = NOW(),
        task_last_heartbeat_at = NOW(),
        task_actor_character_id = p_actor_character_id
    WHERE ship_id = p_ship_id;

    RETURN jsonb_build_object(
      'acquired', TRUE,
      'stolen_task_id', v_stolen_task_id,
      'stolen_actor_character_id', v_stolen_actor
    );
  END IF;

  RETURN jsonb_build_object(
    'acquired', FALSE,
    'current_task_id', v_current_task_id,
    'current_actor_character_id', v_current_actor,
    'current_task_started_at', v_current_started
  );
END;
$$;

COMMENT ON FUNCTION acquire_ship_task_lock(UUID, UUID, UUID, INTEGER, INTEGER) IS
  'Atomic ship-task lock acquire with layered stale-eligibility. Returns JSON describing acquire outcome and any displaced lock.';

GRANT EXECUTE ON FUNCTION acquire_ship_task_lock(UUID, UUID, UUID, INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC: release_ship_task_lock
--
-- Releases the lock IFF the (ship_id, task_id) pair currently matches.
-- 0 rows affected is silently fine — the lock was already released, stolen
-- by a stale-acquire, or never held by this task. Returns the count so
-- callers can log if they care.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION release_ship_task_lock(
  p_ship_id UUID,
  p_task_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE ship_instances
  SET current_task_id        = NULL,
      task_started_at        = NULL,
      task_actor_character_id = NULL,
      task_last_heartbeat_at = NULL
  WHERE ship_id = p_ship_id AND current_task_id = p_task_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

COMMENT ON FUNCTION release_ship_task_lock(UUID, UUID) IS
  'Atomic ship-task lock release keyed on the (ship_id, task_id) pair. Returns true if a row was updated.';

GRANT EXECUTE ON FUNCTION release_ship_task_lock(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC: force_release_ship_task_lock
--
-- Force-release: clears the lock unconditionally and returns whatever was
-- there (so the edge function can emit task.cancel for the displaced actor).
-- Authorization (corp membership) is enforced in the edge function — this
-- RPC trusts its caller.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION force_release_ship_task_lock(
  p_ship_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous_task  UUID;
  v_previous_actor UUID;
BEGIN
  SELECT current_task_id, task_actor_character_id
    INTO v_previous_task, v_previous_actor
  FROM ship_instances
  WHERE ship_id = p_ship_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', FALSE, 'error', 'ship_not_found');
  END IF;

  UPDATE ship_instances
  SET current_task_id        = NULL,
      task_started_at        = NULL,
      task_actor_character_id = NULL,
      task_last_heartbeat_at = NULL
  WHERE ship_id = p_ship_id;

  RETURN jsonb_build_object(
    'released', TRUE,
    'released_task_id', v_previous_task,
    'released_actor_character_id', v_previous_actor
  );
END;
$$;

COMMENT ON FUNCTION force_release_ship_task_lock(UUID) IS
  'Unconditional lock release; returns the displaced task/actor so the caller can emit task.cancel. Trusts caller for authorization.';

GRANT EXECUTE ON FUNCTION force_release_ship_task_lock(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC: refresh_ship_task_heartbeats
--
-- Bulk-updates task_last_heartbeat_at for every (ship_id, task_id) pair
-- in the input array whose current lock matches. Mismatched pairs are
-- silently no-op (the lock was released or stolen).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_ship_task_heartbeats(pairs JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_refreshed INTEGER;
BEGIN
  WITH input AS (
    SELECT (elem->>'ship_id')::uuid AS ship_id,
           (elem->>'task_id')::uuid AS task_id
    FROM jsonb_array_elements(pairs) elem
  )
  UPDATE ship_instances si
  SET task_last_heartbeat_at = NOW()
  FROM input i
  WHERE si.ship_id = i.ship_id AND si.current_task_id = i.task_id;
  GET DIAGNOSTICS v_refreshed = ROW_COUNT;
  RETURN jsonb_build_object('refreshed', v_refreshed);
END;
$$;

COMMENT ON FUNCTION refresh_ship_task_heartbeats(JSONB) IS
  'Bulk refresh task_last_heartbeat_at for an array of {ship_id, task_id} pairs. Mismatched pairs are silently skipped.';

GRANT EXECUTE ON FUNCTION refresh_ship_task_heartbeats(JSONB) TO service_role;
