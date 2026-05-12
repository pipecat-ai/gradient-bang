-- BYOA restricted PGMQ wrappers.
--
-- The voice agent owns a per-session PGMQ channel and passes it to BYOA via
-- wake (remote) or --channel (local dev). BYOA uses a restricted DB role that
-- cannot call raw pgmq; it can only execute these SECURITY DEFINER wrappers.
-- Every wrapper validates BYOA_TOKEN + channel + ship_id before touching PGMQ.

-- Old one-shot/raw-PGMQ surface.
DROP FUNCTION IF EXISTS public.byoa_bus_authorize(text, text);
DROP FUNCTION IF EXISTS public.byoa_bus_authorize(text, text, uuid);

-- Older wrapper experiments.
DROP FUNCTION IF EXISTS public.byoa_bus_create_queue(text, text);
DROP FUNCTION IF EXISTS public.byoa_bus_create_queue(text, text, text);
DROP FUNCTION IF EXISTS public.byoa_bus_create_queue(text, text, uuid, text);
DROP FUNCTION IF EXISTS public.byoa_bus_drop_queue(text, text);
DROP FUNCTION IF EXISTS public.byoa_bus_drop_queue(text, text, text);
DROP FUNCTION IF EXISTS public.byoa_bus_drop_queue(text, text, uuid, text);
DROP FUNCTION IF EXISTS public.byoa_bus_list_queues(text);
DROP FUNCTION IF EXISTS public.byoa_bus_list_queues(text, text);
DROP FUNCTION IF EXISTS public.byoa_bus_list_queues(text, text, uuid);
DROP FUNCTION IF EXISTS public.byoa_bus_publish(text, text, jsonb);
DROP FUNCTION IF EXISTS public.byoa_bus_publish(text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.byoa_bus_publish(text, text, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.byoa_bus_subscribe(text, text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.byoa_bus_subscribe(text, text, integer, integer, integer, text);
DROP FUNCTION IF EXISTS public.byoa_bus_subscribe(text, text, uuid, text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.byoa_bus_archive(text, text, bigint);
DROP FUNCTION IF EXISTS public.byoa_bus_archive(text, text, bigint, text);
DROP FUNCTION IF EXISTS public.byoa_bus_archive(text, text, uuid, text, bigint);
DROP FUNCTION IF EXISTS public.byoa_bus_drop_queue(text, text, text);
DROP FUNCTION IF EXISTS public._byoa_verify_or_raise(text);
DROP FUNCTION IF EXISTS public._byoa_bus_authorize_or_raise(text, text, uuid);
DROP FUNCTION IF EXISTS public._byoa_queue_in_channel(text, text);

-- Grant target for deployment-managed login roles. Migrations intentionally do
-- not bake a password; create a login role per environment and grant it this
-- role, e.g. GRANT byoa_bus_client TO byoa_bus_client_login.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byoa_bus_client') THEN
    CREATE ROLE byoa_bus_client NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO byoa_bus_client;
REVOKE ALL ON SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM byoa_bus_client;

-- If pgmq was installed with broad PUBLIC execute grants, a restricted BYOA
-- login would inherit those. Existing bot/event pubsub paths call public
-- SECURITY DEFINER wrappers or use privileged DB credentials, so this does not
-- affect AsyncGameClient pubsub.
REVOKE ALL ON SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.byoa_owned_queues (
  queue_name   text PRIMARY KEY,
  channel      text NOT NULL,
  ship_id      uuid NOT NULL REFERENCES public.ship_instances(ship_id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES public.characters(character_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

-- Queue names are ephemeral process state. Clear rows from older wrapper
-- experiments before enforcing the current channel + ship shape.
TRUNCATE TABLE public.byoa_owned_queues;

ALTER TABLE public.byoa_owned_queues
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS ship_id uuid REFERENCES public.ship_instances(ship_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS character_id uuid REFERENCES public.characters(character_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT NOW();

ALTER TABLE public.byoa_owned_queues
  ALTER COLUMN channel SET NOT NULL,
  ALTER COLUMN ship_id SET NOT NULL,
  ALTER COLUMN character_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS byoa_owned_queues_channel_idx
  ON public.byoa_owned_queues(channel);

CREATE INDEX IF NOT EXISTS byoa_owned_queues_ship_idx
  ON public.byoa_owned_queues(ship_id);

COMMENT ON TABLE public.byoa_owned_queues IS
  'Ephemeral queue ownership ledger for BYOA-managed PGMQ queues. BYOA can only read/archive/drop queues it created for an authorized ship+channel.';

CREATE FUNCTION public._byoa_queue_in_channel(
  p_channel text,
  p_queue_name text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_channel ~ '^[A-Za-z_][A-Za-z0-9_]{0,29}$'
     AND p_queue_name LIKE p_channel || '\_%' ESCAPE '\';
$$;

REVOKE ALL ON FUNCTION public._byoa_queue_in_channel(text, text) FROM PUBLIC;

CREATE FUNCTION public._byoa_bus_authorize_or_raise(
  p_token text,
  p_channel text,
  p_ship_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_character uuid;
  v_ship record;
  v_authorized boolean := false;
BEGIN
  IF p_channel IS NULL OR length(trim(p_channel)) = 0 THEN
    RAISE EXCEPTION 'channel_required' USING ERRCODE = '22023';
  END IF;
  IF p_channel !~ '^[A-Za-z_][A-Za-z0-9_]{0,29}$' THEN
    RAISE EXCEPTION 'channel_invalid' USING ERRCODE = '22023';
  END IF;

  v_character := public.verify_byoa_token(p_token);
  IF v_character IS NULL THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '42501';
  END IF;

  SELECT s.ship_id,
         s.byoa_owner_character_id,
         s.byoa_mode,
         s.owner_corporation_id
    INTO v_ship
    FROM public.ship_instances s
   WHERE s.ship_id = p_ship_id
     AND s.owner_type = 'corporation'
     AND s.byoa_owner_character_id IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ship_not_byoa' USING ERRCODE = '42501';
  END IF;

  IF v_ship.byoa_owner_character_id = v_character THEN
    v_authorized := true;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN v_character;
END;
$$;

REVOKE ALL ON FUNCTION public._byoa_bus_authorize_or_raise(text, text, uuid) FROM PUBLIC;

CREATE FUNCTION public.byoa_bus_authorize(
  p_token text,
  p_channel text,
  p_ship_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_character uuid;
BEGIN
  v_character := public._byoa_bus_authorize_or_raise(
    p_token,
    p_channel,
    p_ship_id
  );

  RETURN jsonb_build_object(
    'character_id', v_character,
    'ship_id', p_ship_id,
    'channel', p_channel
  );
END;
$$;

COMMENT ON FUNCTION public.byoa_bus_authorize(text, text, uuid) IS
  'Token-gated BYOA channel authorization check. This is diagnostic; active bus operations call the same authorization helper on every wrapper invocation.';

REVOKE ALL ON FUNCTION public.byoa_bus_authorize(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_authorize(text, text, uuid) TO byoa_bus_client;
GRANT EXECUTE ON FUNCTION public.byoa_bus_authorize(text, text, uuid) TO service_role;

CREATE FUNCTION public.byoa_bus_create_queue(
  p_token text,
  p_channel text,
  p_ship_id uuid,
  p_queue_name text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_character uuid;
  v_existing public.byoa_owned_queues%ROWTYPE;
BEGIN
  v_character := public._byoa_bus_authorize_or_raise(
    p_token,
    p_channel,
    p_ship_id
  );

  IF NOT public._byoa_queue_in_channel(p_channel, p_queue_name) THEN
    RAISE EXCEPTION 'queue_not_in_channel' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.byoa_owned_queues
   WHERE queue_name = p_queue_name;

  IF FOUND THEN
    IF v_existing.ship_id <> p_ship_id
       OR v_existing.character_id <> v_character
       OR v_existing.channel <> p_channel THEN
      RAISE EXCEPTION 'queue_name_taken' USING ERRCODE = '42501';
    END IF;
  ELSE
    INSERT INTO public.byoa_owned_queues (
      queue_name,
      channel,
      ship_id,
      character_id
    ) VALUES (
      p_queue_name,
      p_channel,
      p_ship_id,
      v_character
    );
  END IF;

  BEGIN
    PERFORM pgmq.create(p_queue_name);
  EXCEPTION
    WHEN duplicate_table THEN NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_create_queue(text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_create_queue(text, text, uuid, text) TO byoa_bus_client;
GRANT EXECUTE ON FUNCTION public.byoa_bus_create_queue(text, text, uuid, text) TO service_role;

CREATE FUNCTION public.byoa_bus_drop_queue(
  p_token text,
  p_channel text,
  p_ship_id uuid,
  p_queue_name text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_owner public.byoa_owned_queues%ROWTYPE;
BEGIN
  PERFORM public._byoa_bus_authorize_or_raise(p_token, p_channel, p_ship_id);

  SELECT *
    INTO v_owner
    FROM public.byoa_owned_queues
   WHERE queue_name = p_queue_name;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_owner.ship_id <> p_ship_id OR v_owner.channel <> p_channel THEN
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

REVOKE ALL ON FUNCTION public.byoa_bus_drop_queue(text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_drop_queue(text, text, uuid, text) TO byoa_bus_client;
GRANT EXECUTE ON FUNCTION public.byoa_bus_drop_queue(text, text, uuid, text) TO service_role;

CREATE FUNCTION public.byoa_bus_list_queues(
  p_token text,
  p_channel text,
  p_ship_id uuid
) RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
BEGIN
  PERFORM public._byoa_bus_authorize_or_raise(p_token, p_channel, p_ship_id);

  RETURN QUERY
    SELECT (q.queue_name)::text
      FROM pgmq.list_queues() AS q
     WHERE (q.queue_name)::text LIKE p_channel || '\_%' ESCAPE '\';
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_list_queues(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_list_queues(text, text, uuid) TO byoa_bus_client;
GRANT EXECUTE ON FUNCTION public.byoa_bus_list_queues(text, text, uuid) TO service_role;

CREATE FUNCTION public.byoa_bus_publish(
  p_token text,
  p_channel text,
  p_ship_id uuid,
  p_target_queue text,
  p_message jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_expected_src text;
  v_rewritten jsonb;
BEGIN
  PERFORM public._byoa_bus_authorize_or_raise(p_token, p_channel, p_ship_id);

  IF NOT public._byoa_queue_in_channel(p_channel, p_target_queue) THEN
    RAISE EXCEPTION 'queue_not_in_channel' USING ERRCODE = '42501';
  END IF;

  v_expected_src := 'byoa_' || p_ship_id::text;
  v_rewritten := jsonb_set(
    p_message,
    '{__data__,source}',
    to_jsonb(v_expected_src),
    true
  );

  RETURN pgmq.send(p_target_queue, v_rewritten);
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_publish(text, text, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_publish(text, text, uuid, text, jsonb) TO byoa_bus_client;
GRANT EXECUTE ON FUNCTION public.byoa_bus_publish(text, text, uuid, text, jsonb) TO service_role;

CREATE FUNCTION public.byoa_bus_subscribe(
  p_token text,
  p_channel text,
  p_ship_id uuid,
  p_queue_name text,
  p_vt integer DEFAULT 30,
  p_qty integer DEFAULT 10,
  p_max_seconds integer DEFAULT 5
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_owner public.byoa_owned_queues%ROWTYPE;
BEGIN
  PERFORM public._byoa_bus_authorize_or_raise(p_token, p_channel, p_ship_id);

  SELECT *
    INTO v_owner
    FROM public.byoa_owned_queues
   WHERE queue_name = p_queue_name;

  IF NOT FOUND OR v_owner.ship_id <> p_ship_id OR v_owner.channel <> p_channel THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT * FROM pgmq.read_with_poll(
      queue_name       => p_queue_name,
      vt               => p_vt,
      qty              => p_qty,
      max_poll_seconds => p_max_seconds
    );
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_subscribe(text, text, uuid, text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_subscribe(text, text, uuid, text, integer, integer, integer) TO byoa_bus_client;
GRANT EXECUTE ON FUNCTION public.byoa_bus_subscribe(text, text, uuid, text, integer, integer, integer) TO service_role;

CREATE FUNCTION public.byoa_bus_archive(
  p_token text,
  p_channel text,
  p_ship_id uuid,
  p_queue_name text,
  p_msg_id bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_owner public.byoa_owned_queues%ROWTYPE;
BEGIN
  PERFORM public._byoa_bus_authorize_or_raise(p_token, p_channel, p_ship_id);

  SELECT *
    INTO v_owner
    FROM public.byoa_owned_queues
   WHERE queue_name = p_queue_name;

  IF NOT FOUND OR v_owner.ship_id <> p_ship_id OR v_owner.channel <> p_channel THEN
    RETURN false;
  END IF;

  RETURN pgmq.delete(p_queue_name, p_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.byoa_bus_archive(text, text, uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.byoa_bus_archive(text, text, uuid, text, bigint) TO byoa_bus_client;
GRANT EXECUTE ON FUNCTION public.byoa_bus_archive(text, text, uuid, text, bigint) TO service_role;
