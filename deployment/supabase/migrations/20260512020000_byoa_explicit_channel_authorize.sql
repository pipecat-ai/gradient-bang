-- Channel-as-capability bus wrappers for the byoa_bus_client role.
--
-- BYOA operators connect with a restricted DB role and can only execute the
-- public.bus_* SECURITY DEFINER wrappers in this file. Each wrapper takes both
-- a queue name and a channel and verifies the pair against the bus_peers
-- registry. Queue names are server-allocated opaque UUIDs and are enumerable
-- via pg_class; knowledge of the channel is the bus capability.

-- Drop the prior token-authorized surface and its registry.
DROP FUNCTION IF EXISTS public.byoa_bus_authorize(text, text);
DROP FUNCTION IF EXISTS public.byoa_bus_authorize(text, text, uuid);
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
DROP FUNCTION IF EXISTS public._byoa_verify_or_raise(text);
DROP FUNCTION IF EXISTS public._byoa_bus_authorize_or_raise(text, text, uuid);
DROP FUNCTION IF EXISTS public._byoa_queue_in_channel(text, text);
DROP TABLE IF EXISTS public.byoa_owned_queues;

-- Restricted login role. Migrations do not bake a password; create a per-env
-- login role and grant this role to it, e.g.
--   GRANT byoa_bus_client TO byoa_bus_client_login;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byoa_bus_client') THEN
    CREATE ROLE byoa_bus_client NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO byoa_bus_client;

-- Close the pgmq enumeration door for both the BYOA role and PUBLIC. Bot-side
-- bus traffic goes through the same SECURITY DEFINER wrappers, so this does
-- not affect privileged callers (service_role + ad-hoc psql).
REVOKE ALL ON SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM byoa_bus_client;
REVOKE ALL ON SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq FROM PUBLIC;

-- Peer registry. Bus layer is identity-free; channel→ship/character binding
-- happens at channel-issuance time (wake_agent), not here.
CREATE TABLE public.bus_peers (
  queue_name text PRIMARY KEY,
  channel    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX bus_peers_channel_idx ON public.bus_peers(channel);
REVOKE ALL ON TABLE public.bus_peers FROM PUBLIC;
COMMENT ON TABLE public.bus_peers IS
  'Channel/queue registry for the public.bus_* SECURITY DEFINER wrappers. Not exposed to byoa_bus_client.';

-- Server-side channel format validator. Channels are 'gb_' followed by 32 hex
-- chars (UUID-128 hex). Wrappers reject anything else so a malformed channel
-- can never enter bus_peers.
CREATE OR REPLACE FUNCTION public._bus_validate_channel(p_channel text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_channel IS NULL OR p_channel !~ '^gb_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'channel_invalid' USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._bus_validate_channel(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.bus_join(p_channel text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_queue_name text;
BEGIN
  PERFORM public._bus_validate_channel(p_channel);
  v_queue_name := 'q_' || replace(gen_random_uuid()::text, '-', '');
  PERFORM pgmq.create(v_queue_name);
  INSERT INTO public.bus_peers (queue_name, channel)
    VALUES (v_queue_name, p_channel);
  RETURN v_queue_name;
END;
$$;
REVOKE ALL ON FUNCTION public.bus_join(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_join(text) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_publish(
  p_channel  text,
  p_my_queue text,
  p_message  jsonb
) RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_peer record;
  v_msg_ids bigint[] := ARRAY[]::bigint[];
  v_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  -- Fan out to every registered peer on the channel. A crashed peer that
  -- failed to call bus_leave can leave a stale bus_peers row pointing at a
  -- dropped pgmq queue; catch undefined_table, prune the row, and keep going
  -- so one dead peer doesn't take down the publish.
  FOR v_peer IN
    SELECT queue_name FROM public.bus_peers WHERE channel = p_channel
  LOOP
    BEGIN
      v_id := pgmq.send(v_peer.queue_name, p_message);
      v_msg_ids := array_append(v_msg_ids, v_id);
    EXCEPTION
      WHEN undefined_table THEN
        DELETE FROM public.bus_peers WHERE queue_name = v_peer.queue_name;
    END;
  END LOOP;

  RETURN v_msg_ids;
END;
$$;
REVOKE ALL ON FUNCTION public.bus_publish(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_publish(text, text, jsonb) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_subscribe(
  p_my_queue    text,
  p_channel     text,
  p_vt          integer DEFAULT 30,
  p_qty         integer DEFAULT 10,
  p_max_seconds integer DEFAULT 5
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT * FROM pgmq.read_with_poll(
      queue_name       => p_my_queue,
      vt               => p_vt,
      qty              => p_qty,
      max_poll_seconds => p_max_seconds
    );
END;
$$;
REVOKE ALL ON FUNCTION public.bus_subscribe(text, text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_subscribe(text, text, integer, integer, integer) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_archive(
  p_my_queue text,
  p_channel  text,
  p_msg_id   bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN pgmq.delete(p_my_queue, p_msg_id);
END;
$$;
REVOKE ALL ON FUNCTION public.bus_archive(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_archive(text, text, bigint) TO byoa_bus_client, service_role;

CREATE OR REPLACE FUNCTION public.bus_leave(
  p_my_queue text,
  p_channel  text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bus_peers
     WHERE queue_name = p_my_queue
       AND channel = p_channel
  ) THEN
    RAISE EXCEPTION 'channel_not_authorized' USING ERRCODE = '42501';
  END IF;

  BEGIN
    PERFORM pgmq.drop_queue(p_my_queue);
  EXCEPTION
    WHEN undefined_table THEN NULL;
  END;
  DELETE FROM public.bus_peers
    WHERE queue_name = p_my_queue
      AND channel = p_channel;
END;
$$;
REVOKE ALL ON FUNCTION public.bus_leave(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bus_leave(text, text) TO byoa_bus_client, service_role;
