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
-- BYOA bus wrappers: token-gated SECURITY DEFINER pgmq access
--
-- The BYOA agent's only interface to the game is the subagent bus. The bot
-- already uses a per-character HS256 token + SECURITY DEFINER pattern for
-- pgmq game-event subscription (see `subscribe_my_events` in the 0.4.1
-- pubsub migration). This migration extends the same pattern to BYOA: the
-- operator's CLI calls these wrappers instead of raw `pgmq.*`, every call
-- carries an HS256 BYOA token, and the wrapper:
--
--   1. Calls `verify_byoa_token` to extract and authorize the bound
--      `character_id`.
--   2. For owned-queue operations (subscribe/archive/drop), checks the queue
--      is registered in `byoa_owned_queues` under the token's character.
--   3. For publish, verifies the bus envelope's `source` belongs to a
--      BYOA ship currently claimed by the token character. The wrapper
--      does not rewrite `source` because the bus uses it for response
--      routing.
--
-- Defense-in-depth note: while operators run our `uv run byoa` CLI in the
-- common case, until we create a restricted Postgres role (hardening,
-- deferred), an admin DSN can still bypass these wrappers by calling raw
-- `pgmq.*`. The wrappers are the policy layer; the restricted role is the
-- enforcement layer. The combination matches the bot's existing model.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- byoa_owned_queues: per-character ownership ledger
-- -----------------------------------------------------------------------------
--
-- The BYOA agent's CLI creates a uuid-suffixed queue at startup (matching
-- upstream PgmqBus's `{channel}_{uuid}` shape, with a `byoa_` infix so
-- the bot's standard peer-discovery filter still picks it up). The ledger
-- row binds the queue to the token's character_id at creation time so the
-- read/archive wrappers can refuse cross-character access cheaply.

CREATE TABLE public.byoa_owned_queues (
  queue_name   text PRIMARY KEY,
  character_id uuid NOT NULL REFERENCES public.characters(character_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX byoa_owned_queues_character_idx
  ON public.byoa_owned_queues(character_id);

COMMENT ON TABLE public.byoa_owned_queues IS
  'Per-character ownership ledger for BYOA-managed pgmq queues. byoa_bus_create_queue inserts; byoa_bus_drop_queue deletes; byoa_bus_subscribe / byoa_bus_archive use it to enforce ownership.';

-- -----------------------------------------------------------------------------
-- Helper: verify token or raise. Used by every wrapper below.
-- -----------------------------------------------------------------------------

CREATE FUNCTION public._byoa_verify_or_raise(p_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_character uuid;
BEGIN
  v_character := public.verify_byoa_token(p_token);
  IF v_character IS NULL THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;
  RETURN v_character;
END;
$$;

REVOKE ALL ON FUNCTION public._byoa_verify_or_raise(text) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Helpers: channel and source authorization
-- -----------------------------------------------------------------------------

CREATE FUNCTION public._byoa_channel_prefix(p_channel text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_channel text := COALESCE(NULLIF(trim(p_channel), ''), 'pipecat_bus');
BEGIN
  IF v_channel !~ '^[A-Za-z_][A-Za-z0-9_]{0,29}$' THEN
    RAISE EXCEPTION 'invalid_channel' USING ERRCODE = '22023';
  END IF;
  RETURN v_channel || '_';
END;
$$;

REVOKE ALL ON FUNCTION public._byoa_channel_prefix(text) FROM PUBLIC;

CREATE FUNCTION public._byoa_queue_in_channel(
  p_queue_name text,
  p_channel    text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  RETURN left(COALESCE(p_queue_name, ''), length(public._byoa_channel_prefix(p_channel)))
    = public._byoa_channel_prefix(p_channel);
END;
$$;

REVOKE ALL ON FUNCTION public._byoa_queue_in_channel(text, text) FROM PUBLIC;

CREATE FUNCTION public._byoa_source_authorized(
  p_character_id uuid,
  p_source       text,
  p_message      jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ship_id_text text;
  v_ship_id      uuid;
  v_is_runner    boolean := false;
BEGIN
  IF p_source IS NULL OR p_source = '' THEN
    RETURN false;
  END IF;

  IF left(p_source, length('byoa_runner_')) = 'byoa_runner_' THEN
    v_ship_id_text := substring(p_source from length('byoa_runner_') + 1);
    v_is_runner := true;
  ELSIF left(p_source, length('byoa_')) = 'byoa_' THEN
    v_ship_id_text := substring(p_source from length('byoa_') + 1);
  ELSE
    RETURN false;
  END IF;

  BEGIN
    v_ship_id := v_ship_id_text::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;

  IF NOT EXISTS (
    SELECT 1
      FROM public.ship_instances s
     WHERE s.ship_id = v_ship_id
       AND s.owner_type = 'corporation'
       AND s.byoa_owner_character_id = p_character_id
  ) THEN
    RETURN false;
  END IF;

  IF v_is_runner THEN
    IF p_message->>'__type__' IS DISTINCT FROM 'pipecat_subagents.bus.messages.BusAgentRegistryMessage' THEN
      RETURN false;
    END IF;
    IF p_message #>> '{__data__,runner}' IS DISTINCT FROM p_source THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(p_message #> '{__data__,agents}') IS DISTINCT FROM 'array' THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(p_message #> '{__data__,agents}') = 0 THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_message #> '{__data__,agents}') AS agent
       WHERE COALESCE(agent #>> '{__data__,name}', agent->>'name')
         IS DISTINCT FROM ('byoa_' || v_ship_id_text)
    ) THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public._byoa_source_authorized(uuid, text, jsonb) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- byoa_bus_create_queue: register + create a per-character pgmq queue
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_create_queue(
  p_token      text,
  p_queue_name text,
  p_channel    text DEFAULT 'pipecat_bus'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_character uuid;
  v_existing  uuid;
BEGIN
  v_character := public._byoa_verify_or_raise(p_token);
  IF NOT public._byoa_queue_in_channel(p_queue_name, p_channel) THEN
    RAISE EXCEPTION 'queue_outside_channel' USING ERRCODE = '42501';
  END IF;

  -- Reserve the queue name. If another character already owns it, fail
  -- visibly so a misconfigured CLI doesn't silently piggyback on someone
  -- else's queue. Idempotent for the same owner.
  SELECT character_id INTO v_existing
    FROM public.byoa_owned_queues
    WHERE queue_name = p_queue_name;

  IF v_existing IS NOT NULL THEN
    IF v_existing <> v_character THEN
      RAISE EXCEPTION 'queue_name_taken' USING ERRCODE = '42501';
    END IF;
  ELSE
    INSERT INTO public.byoa_owned_queues (queue_name, character_id)
      VALUES (p_queue_name, v_character);
  END IF;

  -- Idempotent at the pgmq layer too — re-running the agent on the same
  -- queue should be safe.
  BEGIN
    PERFORM pgmq.create(p_queue_name);
  EXCEPTION
    WHEN duplicate_table THEN NULL;
  END;
END;
$$;

COMMENT ON FUNCTION public.byoa_bus_create_queue IS
  'Token-gated pgmq.create. Reserves the queue name in byoa_owned_queues under the token bound character_id. Raises queue_name_taken if another character already owns it.';

REVOKE ALL ON FUNCTION public.byoa_bus_create_queue(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_create_queue(text, text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_drop_queue: drop + unregister
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_drop_queue(
  p_token      text,
  p_queue_name text,
  p_channel    text DEFAULT 'pipecat_bus'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_character uuid;
  v_owner     uuid;
BEGIN
  v_character := public._byoa_verify_or_raise(p_token);
  IF NOT public._byoa_queue_in_channel(p_queue_name, p_channel) THEN
    RAISE EXCEPTION 'queue_outside_channel' USING ERRCODE = '42501';
  END IF;

  SELECT character_id INTO v_owner
    FROM public.byoa_owned_queues
    WHERE queue_name = p_queue_name;

  -- Silent success on unknown queue so a double-stop is idempotent.
  IF v_owner IS NULL THEN
    RETURN;
  END IF;

  IF v_owner <> v_character THEN
    RAISE EXCEPTION 'queue_not_owned' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM pgmq.drop_queue(p_queue_name);
  EXCEPTION
    WHEN undefined_table THEN NULL;
  END;

  DELETE FROM public.byoa_owned_queues WHERE queue_name = p_queue_name;
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_drop_queue(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_drop_queue(text, text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_subscribe: token-gated read_with_poll on an owned queue
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_subscribe(
  p_token       text,
  p_queue_name  text,
  p_vt          integer DEFAULT 30,
  p_qty         integer DEFAULT 10,
  p_max_seconds integer DEFAULT 5,
  p_channel     text DEFAULT 'pipecat_bus'
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_character uuid;
  v_owner     uuid;
BEGIN
  v_character := public._byoa_verify_or_raise(p_token);
  IF NOT public._byoa_queue_in_channel(p_queue_name, p_channel) THEN
    RETURN;
  END IF;

  SELECT character_id INTO v_owner
    FROM public.byoa_owned_queues
    WHERE queue_name = p_queue_name;

  -- Unknown / unowned queue: return zero rows. Don't leak existence to
  -- a probing operator; the cross-character read attempt looks the same
  -- as an empty queue.
  IF v_owner IS NULL OR v_owner <> v_character THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT * FROM pgmq.read_with_poll(
      queue_name      => p_queue_name,
      vt              => p_vt,
      qty             => p_qty,
      max_poll_seconds=> p_max_seconds
    );
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_subscribe(text, text, integer, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_subscribe(text, text, integer, integer, integer, text) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_archive: token-gated delete on an owned queue
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_archive(
  p_token      text,
  p_queue_name text,
  p_msg_id     bigint,
  p_channel    text DEFAULT 'pipecat_bus'
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_character uuid;
  v_owner     uuid;
BEGIN
  v_character := public._byoa_verify_or_raise(p_token);
  IF NOT public._byoa_queue_in_channel(p_queue_name, p_channel) THEN
    RETURN false;
  END IF;

  SELECT character_id INTO v_owner
    FROM public.byoa_owned_queues
    WHERE queue_name = p_queue_name;

  IF v_owner IS NULL OR v_owner <> v_character THEN
    RETURN false;
  END IF;

  RETURN pgmq.delete(p_queue_name, p_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_archive(text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_archive(text, text, bigint, text) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_publish: token-gated send with source authorization
-- -----------------------------------------------------------------------------
--
-- The upstream JSONMessageSerializer wraps dataclass bus messages as
-- {"__type__": "<fqn>", "__data__": {"source": "...", ...}}. We do not
-- rewrite `__data__.source`: the bus uses it as the reply target. Instead,
-- source must be `byoa_<ship_id>` or `byoa_runner_<ship_id>` for a BYOA ship
-- currently claimed by the token character.

CREATE FUNCTION public.byoa_bus_publish(
  p_token        text,
  p_channel      text,
  p_target_queue text,
  p_message      jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_character     uuid;
  v_source        text;
BEGIN
  v_character := public._byoa_verify_or_raise(p_token);
  IF NOT public._byoa_queue_in_channel(p_target_queue, p_channel) THEN
    RAISE EXCEPTION 'queue_outside_channel' USING ERRCODE = '42501';
  END IF;

  v_source := p_message #>> '{__data__,source}';
  IF NOT public._byoa_source_authorized(v_character, v_source, p_message) THEN
    RAISE EXCEPTION 'unauthorized_source' USING ERRCODE = '42501';
  END IF;

  RETURN pgmq.send(p_target_queue, p_message);
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_publish(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_publish(text, text, text, jsonb) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_list_queues: token-gated list, used for peer discovery
-- -----------------------------------------------------------------------------
--
-- Returns queue names visible under the pgmq schema for the requested channel.
-- The caller still applies the normal upstream peer-discovery filter. The list
-- itself doesn't expose message contents, so we don't restrict to the caller's
-- owned queues here.

CREATE FUNCTION public.byoa_bus_list_queues(
  p_token   text,
  p_channel text
)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
BEGIN
  PERFORM public._byoa_verify_or_raise(p_token);
  -- pgmq.list_queues() returns SETOF pgmq.queue_record; pull the
  -- queue_name column and cast to text so the return type matches.
  RETURN QUERY
    SELECT (q.queue_name)::text
     FROM pgmq.list_queues() AS q
     WHERE left((q.queue_name)::text, length(public._byoa_channel_prefix(p_channel)))
       = public._byoa_channel_prefix(p_channel);
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_list_queues(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_list_queues(text, text) TO service_role;
