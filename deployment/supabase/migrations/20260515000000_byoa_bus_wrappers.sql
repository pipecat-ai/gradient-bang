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
--   1. Calls `verify_byoa_token` (shipped in the prior migration) to extract
--      and authorize the bound `character_id`.
--   2. For owned-queue operations (subscribe/archive/drop), checks the queue
--      is registered in `byoa_owned_queues` under the token's character.
--   3. For publish, rewrites the bus envelope's `source` to a deterministic
--      `byoa_<character_id>` value so the operator can't impersonate the
--      bot or another character on the bus.
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
-- byoa_bus_create_queue: register + create a per-character pgmq queue
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_create_queue(
  p_token      text,
  p_queue_name text
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

REVOKE ALL ON FUNCTION public.byoa_bus_create_queue(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_create_queue(text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_drop_queue: drop + unregister
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_drop_queue(
  p_token      text,
  p_queue_name text
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

REVOKE ALL ON FUNCTION public.byoa_bus_drop_queue(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_drop_queue(text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_subscribe: token-gated read_with_poll on an owned queue
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_subscribe(
  p_token       text,
  p_queue_name  text,
  p_vt          integer DEFAULT 30,
  p_qty         integer DEFAULT 10,
  p_max_seconds integer DEFAULT 5
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

REVOKE ALL ON FUNCTION public.byoa_bus_subscribe(text, text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_subscribe(text, text, integer, integer, integer) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_archive: token-gated delete on an owned queue
-- -----------------------------------------------------------------------------

CREATE FUNCTION public.byoa_bus_archive(
  p_token      text,
  p_queue_name text,
  p_msg_id     bigint
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

  SELECT character_id INTO v_owner
    FROM public.byoa_owned_queues
    WHERE queue_name = p_queue_name;

  IF v_owner IS NULL OR v_owner <> v_character THEN
    RETURN false;
  END IF;

  RETURN pgmq.delete(p_queue_name, p_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_archive(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_archive(text, text, bigint) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_publish: token-gated send with envelope-source rewrite
-- -----------------------------------------------------------------------------
--
-- The upstream JSONMessageSerializer wraps dataclass bus messages as
-- {"__type__": "<fqn>", "__data__": {"source": "...", ...}}. We force
-- `__data__.source` to `byoa_<character_id>` regardless of what the
-- caller passed in, so a malicious or buggy CLI can't impersonate the
-- bot or another character on the bus.

CREATE FUNCTION public.byoa_bus_publish(
  p_token        text,
  p_target_queue text,
  p_message      jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_character     uuid;
  v_expected_src  text;
  v_rewritten     jsonb;
BEGIN
  v_character := public._byoa_verify_or_raise(p_token);
  v_expected_src := 'byoa_' || v_character::text;

  -- Always force the envelope source, regardless of caller input. If
  -- __data__ is missing entirely (some non-dataclass message types may
  -- not have it), jsonb_set with create_if_missing=true will materialize
  -- it; the receiver tolerates either shape.
  v_rewritten := jsonb_set(
    p_message,
    '{__data__,source}',
    to_jsonb(v_expected_src),
    true
  );

  RETURN pgmq.send(p_target_queue, v_rewritten);
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_publish(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_publish(text, text, jsonb) TO service_role;

-- -----------------------------------------------------------------------------
-- byoa_bus_list_queues: token-gated list, used for peer discovery
-- -----------------------------------------------------------------------------
--
-- Returns queue names visible under the pgmq schema. The caller filters by
-- channel prefix client-side (mirrors upstream PgmqBus._peer_queues). The
-- list itself doesn't expose message contents, so we don't restrict to the
-- caller's owned queues here.

CREATE FUNCTION public.byoa_bus_list_queues(p_token text)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
BEGIN
  PERFORM public._byoa_verify_or_raise(p_token);
  -- pgmq.list_queues() returns SETOF pgmq.queue_record; pull the
  -- queue_name column and cast to text so the return type matches.
  RETURN QUERY SELECT (q.queue_name)::text FROM pgmq.list_queues() AS q;
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_list_queues(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_list_queues(text) TO service_role;
