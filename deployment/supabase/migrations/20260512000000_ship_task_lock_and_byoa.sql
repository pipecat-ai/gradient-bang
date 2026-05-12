-- Server-side ship-task lock + BYOA columns on ship_instances.
--
-- Today the "only one task per ship" invariant is enforced purely in the
-- VoiceAgent process (a local `_locked_ships` Python set). Nothing prevents
-- two corp members on different processes from starting concurrent tasks
-- on the same corp ship. This migration adds the columns + atomic RPCs
-- that make the lock real, plus the BYOA ownership columns that unlock the
-- broader BYOA work (see docs/setup-byoa.md).
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
  ADD COLUMN current_task_id            UUID NULL,
  ADD COLUMN task_started_at            TIMESTAMPTZ NULL,
  ADD COLUMN task_actor_character_id    UUID NULL,
  ADD COLUMN task_last_heartbeat_at     TIMESTAMPTZ NULL,
  ADD COLUMN byoa_owner_character_id    UUID NULL,
  ADD COLUMN byoa_mode                  TEXT NOT NULL DEFAULT 'private'
    CHECK (byoa_mode = 'private'),
  ADD COLUMN byoa_session_channel       TEXT NULL,
  ADD COLUMN byoa_session_allocated_at  TIMESTAMPTZ NULL;

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
  'BYOA-only: currently always ''private''. BYOA ships are owner-only in this phase; the column is retained for forward-compatible UI/API shape.';
COMMENT ON COLUMN ship_instances.byoa_session_channel IS
  'Per-session PGMQ channel for the active BYOA task. Set by wake_agent at allocation; cleared on lock release. NULL outside an active BYOA task.';
COMMENT ON COLUMN ship_instances.byoa_session_allocated_at IS
  'When byoa_session_channel was allocated. Used for diagnostics and stale-session detection.';

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

-- Used by byoa_bus_authorize to resolve a channel back to the BYOA ship it
-- was allocated for. Partial because only BYOA ships in an active session
-- have a non-NULL value.
CREATE UNIQUE INDEX ship_instances_byoa_session_channel_uniq
  ON ship_instances(byoa_session_channel)
  WHERE byoa_session_channel IS NOT NULL;

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
    SET current_task_id            = p_task_id,
        task_started_at            = NOW(),
        task_last_heartbeat_at     = NOW(),
        task_actor_character_id    = p_actor_character_id,
        byoa_session_channel       = NULL,
        byoa_session_allocated_at  = NULL
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
  SET current_task_id            = NULL,
      task_started_at            = NULL,
      task_actor_character_id    = NULL,
      task_last_heartbeat_at     = NULL,
      byoa_session_channel       = NULL,
      byoa_session_allocated_at  = NULL
  WHERE ship_id = p_ship_id AND current_task_id = p_task_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

COMMENT ON FUNCTION release_ship_task_lock(UUID, UUID) IS
  'Atomic ship-task lock release keyed on the (ship_id, task_id) pair. Clears any BYOA session channel allocated for the task. Returns true if a row was updated.';

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
  SET current_task_id            = NULL,
      task_started_at            = NULL,
      task_actor_character_id    = NULL,
      task_last_heartbeat_at     = NULL,
      byoa_session_channel       = NULL,
      byoa_session_allocated_at  = NULL
  WHERE ship_id = p_ship_id;

  RETURN jsonb_build_object(
    'released', TRUE,
    'released_task_id', v_previous_task,
    'released_actor_character_id', v_previous_actor
  );
END;
$$;

COMMENT ON FUNCTION force_release_ship_task_lock(UUID) IS
  'Unconditional lock release; returns the displaced task/actor so the caller can emit task.cancel. Clears any BYOA session channel allocated for the task. Trusts caller for authorization.';

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

-- =============================================================================
-- BYOA tokens
--
-- `byoa_tokens` — long-lived HS256 token records bound to a character_id.
-- An operator mints one via the `byoa_token_mint` edge function
-- (Supabase-JWT-authed), receives the plaintext JWT exactly once, and stores
-- it on their machine. The DB stores only a SHA-256 hash so the plaintext is
-- never recoverable. Revocation flips `revoked_at`; the bus wrappers check
-- both signature validity AND the stored row's revocation/expiry on every
-- call.
--
-- Reuses the HS256 signing primitive provisioned by the 0.4.1 pubsub
-- migration (`pubsub_internal_secret`). Rotation: UPDATE the app_runtime_config
-- row, restart any sessions. BYOA tokens issued under the old secret stop
-- verifying on rotation — the desired post-rotation behaviour.
-- =============================================================================

-- pgcrypto provides `digest()` used by verify_byoa_token to hash the
-- inbound JWT for table lookup. Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- byoa_tokens
-- -----------------------------------------------------------------------------

CREATE TABLE public.byoa_tokens (
  token_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  uuid NOT NULL REFERENCES public.characters(character_id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NULL,
  revoked_at    timestamptz NULL,
  CONSTRAINT byoa_tokens_label_nonblank CHECK (length(trim(label)) > 0)
);

-- Owner lookup for the future "list my tokens" UI (Phase 4) and the
-- mint-then-revoke-old rotation flow.
CREATE INDEX byoa_tokens_character_idx
  ON public.byoa_tokens(character_id)
  WHERE revoked_at IS NULL;

-- Hash lookup is the gateway hot path; UNIQUE already gives us the index.

COMMENT ON TABLE public.byoa_tokens IS
  'Long-lived HS256 BYOA tokens bound to a character_id. The plaintext JWT is returned once at mint time and never stored; only SHA-256 hash persists. Revocation flips revoked_at; gateway rejects on hash miss, revoked_at NOT NULL, or expires_at < NOW().';

-- -----------------------------------------------------------------------------
-- verify_byoa_token: signature + revocation + last-used touch
--
-- Called by the BYOA gateway (Phase 3 (3/N) edge functions). Returns the
-- token's bound character_id on success, NULL on any auth failure (invalid
-- sig, wrong token_type claim, missing/revoked/expired row). On success,
-- updates last_used_at lazily so operators can see token activity from the
-- Phase 4 management UI.
--
-- SECURITY DEFINER + REVOKE FROM PUBLIC keeps the underlying table writes
-- privileged; only the gateway edge functions (service_role) can call this.
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.verify_byoa_token(p_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_payload     json;
  v_valid       boolean;
  v_character   uuid;
  v_token_hash  text;
  v_token_row   public.byoa_tokens%ROWTYPE;
BEGIN
  -- Verify HS256 signature + standard exp claim via pgjwt. pgjwt's verify
  -- can raise on malformed JWTs (e.g. missing dots, non-base64 payload),
  -- so any exception is treated as "invalid token" rather than propagating.
  BEGIN
    SELECT payload, valid
      INTO v_payload, v_valid
      FROM extensions.verify(
        p_token,
        public.pubsub_internal_secret(),
        'HS256'
      );
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  IF v_valid IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  -- Defense against cross-token-type reuse (e.g. an internal pubsub token
  -- being passed off as a BYOA token).
  IF v_payload->>'token_type' IS DISTINCT FROM 'byoa' THEN
    RETURN NULL;
  END IF;
  IF v_payload->>'iss' IS DISTINCT FROM 'byoa_token_mint' THEN
    RETURN NULL;
  END IF;

  v_character := NULLIF(v_payload->>'character_id', '')::uuid;
  IF v_character IS NULL THEN
    RETURN NULL;
  END IF;

  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  SELECT *
    INTO v_token_row
    FROM public.byoa_tokens
    WHERE token_hash = v_token_hash;

  IF NOT FOUND
     OR v_token_row.revoked_at IS NOT NULL
     OR v_token_row.expires_at < NOW()
     OR v_token_row.character_id <> v_character
  THEN
    RETURN NULL;
  END IF;

  UPDATE public.byoa_tokens
     SET last_used_at = NOW()
   WHERE token_id = v_token_row.token_id;

  RETURN v_character;
END;
$$;

COMMENT ON FUNCTION public.verify_byoa_token IS
  'Verifies an HS256 BYOA token: pgjwt signature check, token_type/iss claim guards, byoa_tokens row lookup (hash, not revoked, not expired, matching character). Updates last_used_at on success. Returns bound character_id on success or NULL on any failure.';

REVOKE ALL ON FUNCTION public.verify_byoa_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_byoa_token(text) TO service_role;

-- =============================================================================
-- BYOA bus authorization: per-session channel binding check
--
-- Legacy one-shot channel binding check. This is superseded by the
-- restricted wrapper migration, which authorizes every PGMQ operation with
-- token + channel + ship_id. It remains here only for migration ordering in
-- environments that applied this migration before the wrapper migration.
-- =============================================================================

CREATE FUNCTION public.byoa_bus_authorize(
  p_token   text,
  p_channel text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_character uuid;
  v_ship      record;
BEGIN
  v_character := public.verify_byoa_token(p_token);
  IF v_character IS NULL THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  IF p_channel IS NULL OR length(trim(p_channel)) = 0 THEN
    RAISE EXCEPTION 'channel_required' USING ERRCODE = '22023';
  END IF;

  -- Locate the BYOA ship the token's character owns which has the requested
  -- channel currently allocated. BYOA ships are owner-only in this phase.
  SELECT s.ship_id,
         s.current_task_id,
         s.byoa_owner_character_id,
         s.byoa_mode,
         s.owner_corporation_id
    INTO v_ship
    FROM public.ship_instances s
   WHERE s.owner_type = 'corporation'
     AND s.byoa_session_channel = p_channel
     AND s.byoa_owner_character_id IS NOT NULL
   LIMIT 1;

  IF v_ship.ship_id IS NULL THEN
    RAISE EXCEPTION 'channel_not_allocated' USING ERRCODE = '42501';
  END IF;

  IF v_ship.byoa_owner_character_id <> v_character THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'character_id',     v_character,
    'ship_id',          v_ship.ship_id,
    'current_task_id',  v_ship.current_task_id,
    'channel',          p_channel
  );
END;
$$;

COMMENT ON FUNCTION public.byoa_bus_authorize(text, text) IS
  'One-shot gate called when an operator''s subagent bus initializes. Verifies the HS256 BYOA token and confirms a session is currently allocated on the requested channel for an authorized ship. Returns the resolved {character_id, ship_id, current_task_id, channel}. Raises on any failure.';

REVOKE ALL ON FUNCTION public.byoa_bus_authorize(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_authorize(text, text) TO service_role;
