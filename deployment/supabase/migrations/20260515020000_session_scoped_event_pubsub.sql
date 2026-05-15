-- Session-scoped gameplay event queues. Durable public.events writes remain
-- unchanged; PGMQ fanout targets active event_sessions rows.

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE TABLE IF NOT EXISTS public.event_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text UNIQUE NOT NULL,
  actor_character_id uuid NOT NULL,
  scope_character_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  corp_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  hard_expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_sessions_expires_at
  ON public.event_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_event_sessions_corp_id
  ON public.event_sessions (corp_id);

CREATE INDEX IF NOT EXISTS idx_event_sessions_scope_character_ids
  ON public.event_sessions USING gin (scope_character_ids);

COMMENT ON TABLE public.event_sessions IS
  'Online-only gameplay event pubsub sessions. Each row owns one temporary pgmq queue and expires when heartbeat stops.';

DROP TRIGGER IF EXISTS trg_ensure_character_queue ON public.characters;
DROP FUNCTION IF EXISTS public._tg_ensure_character_queue();

CREATE OR REPLACE FUNCTION public._validate_event_session_scope(
  p_actor_character_id uuid,
  p_scope_character_ids uuid[]
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_character_id uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_clean uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_actor_character_id IS NULL THEN
    RAISE EXCEPTION 'actor_character_id required' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(array_length(p_scope_character_ids, 1), 0) = 0 THEN
    p_scope_character_ids := ARRAY[p_actor_character_id]::uuid[];
  END IF;

  FOREACH v_character_id IN ARRAY p_scope_character_ids LOOP
    IF v_character_id IS NULL OR v_character_id = ANY(v_seen) THEN
      CONTINUE;
    END IF;
    IF NOT public.can_actor_access_character(p_actor_character_id, v_character_id) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    v_seen := array_append(v_seen, v_character_id);
    v_clean := array_append(v_clean, v_character_id);
  END LOOP;

  IF NOT p_actor_character_id = ANY(v_clean) THEN
    v_clean := array_prepend(p_actor_character_id, v_clean);
  END IF;

  RETURN v_clean;
END;
$$;

REVOKE ALL ON FUNCTION public._validate_event_session_scope(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._validate_event_session_scope(uuid, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public._validate_event_session_corp(
  p_actor_character_id uuid,
  p_corp_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_corp_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.corporation_members cm
    WHERE cm.character_id = p_actor_character_id
      AND cm.corp_id = p_corp_id
      AND cm.left_at IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.ship_instances si
    WHERE si.ship_id = p_actor_character_id
      AND si.owner_type = 'corporation'
      AND si.owner_corporation_id = p_corp_id
  ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public._validate_event_session_corp(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._validate_event_session_corp(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_cleanup(
  p_batch_size integer DEFAULT 100
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_session record;
  v_cleaned integer := 0;
  v_limit integer := GREATEST(1, COALESCE(p_batch_size, 100));
  v_locked boolean;
BEGIN
  v_locked := pg_try_advisory_lock(hashtext('event_session_cleanup'));
  IF NOT v_locked THEN
    RETURN 0;
  END IF;

  BEGIN
    FOR v_session IN
      SELECT session_id, queue_name
      FROM public.event_sessions
      WHERE expires_at <= now()
         OR hard_expires_at <= now()
      ORDER BY expires_at ASC
      LIMIT v_limit
      FOR UPDATE SKIP LOCKED
    LOOP
      BEGIN
        PERFORM pgmq.drop_queue(v_session.queue_name);
      EXCEPTION
        WHEN undefined_table THEN NULL;
        WHEN OTHERS THEN
          RAISE WARNING 'event_session_cleanup drop_queue failed for %: %',
            v_session.queue_name, SQLERRM;
          CONTINUE;
      END;

      DELETE FROM public.event_sessions
       WHERE session_id = v_session.session_id;
      v_cleaned := v_cleaned + 1;
    END LOOP;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM pg_advisory_unlock(hashtext('event_session_cleanup'));
      RAISE;
  END;

  PERFORM pg_advisory_unlock(hashtext('event_session_cleanup'));
  RETURN v_cleaned;
END;
$$;

COMMENT ON FUNCTION public.event_session_cleanup(integer) IS
  'Drops expired gameplay event session queues and deletes their rows in a bounded SKIP LOCKED batch. Safe to run from pg_cron.';

REVOKE ALL ON FUNCTION public.event_session_cleanup(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_cleanup(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_register(
  p_actor_character_id uuid,
  p_edge_token text,
  p_scope_character_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_corp_id uuid DEFAULT NULL,
  p_ttl_seconds integer DEFAULT 60,
  p_hard_ttl_seconds integer DEFAULT 21600
) RETURNS TABLE (
  session_id uuid,
  queue_name text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_session_id uuid := gen_random_uuid();
  v_queue_name text := 'evs_' || replace(v_session_id::text, '-', '');
  v_scope uuid[];
  v_ttl integer := GREATEST(5, COALESCE(p_ttl_seconds, 60));
  v_hard_ttl integer := GREATEST(v_ttl, COALESCE(p_hard_ttl_seconds, 21600));
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);
  v_scope := public._validate_event_session_scope(
    p_actor_character_id,
    COALESCE(p_scope_character_ids, ARRAY[]::uuid[])
  );
  PERFORM public._validate_event_session_corp(p_actor_character_id, p_corp_id);

  PERFORM public.event_session_cleanup(25);
  PERFORM pgmq.create(v_queue_name);

  INSERT INTO public.event_sessions (
    session_id,
    queue_name,
    actor_character_id,
    scope_character_ids,
    corp_id,
    expires_at,
    hard_expires_at
  ) VALUES (
    v_session_id,
    v_queue_name,
    p_actor_character_id,
    v_scope,
    p_corp_id,
    now() + make_interval(secs => v_ttl),
    now() + make_interval(secs => v_hard_ttl)
  );

  RETURN QUERY
    SELECT es.session_id, es.queue_name, es.expires_at
    FROM public.event_sessions es
    WHERE es.session_id = v_session_id;
END;
$$;

COMMENT ON FUNCTION public.event_session_register(uuid, text, uuid[], uuid, integer, integer) IS
  'Creates a temporary pgmq queue for one online gameplay event session and returns only after the queue exists.';

REVOKE ALL ON FUNCTION public.event_session_register(uuid, text, uuid[], uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_register(uuid, text, uuid[], uuid, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_heartbeat(
  p_session_id uuid,
  p_edge_token text,
  p_ttl_seconds integer DEFAULT 60
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expires_at timestamptz;
  v_ttl integer := GREATEST(5, COALESCE(p_ttl_seconds, 60));
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);

  UPDATE public.event_sessions
     SET last_heartbeat_at = now(),
         expires_at = LEAST(now() + make_interval(secs => v_ttl), hard_expires_at)
   WHERE session_id = p_session_id
     AND hard_expires_at > now()
   RETURNING expires_at INTO v_expires_at;

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION 'event_session_not_found' USING ERRCODE = '02000';
  END IF;

  RETURN v_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.event_session_heartbeat(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_heartbeat(uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_update_scope(
  p_session_id uuid,
  p_edge_token text,
  p_scope_character_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_corp_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_character_id uuid;
  v_scope uuid[];
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);

  SELECT actor_character_id
    INTO v_actor_character_id
    FROM public.event_sessions
   WHERE session_id = p_session_id
     AND expires_at > now()
     AND hard_expires_at > now();

  IF v_actor_character_id IS NULL THEN
    RAISE EXCEPTION 'event_session_not_found' USING ERRCODE = '02000';
  END IF;

  v_scope := public._validate_event_session_scope(
    v_actor_character_id,
    COALESCE(p_scope_character_ids, ARRAY[]::uuid[])
  );
  PERFORM public._validate_event_session_corp(v_actor_character_id, p_corp_id);

  UPDATE public.event_sessions
     SET scope_character_ids = v_scope,
         corp_id = p_corp_id
   WHERE session_id = p_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.event_session_update_scope(uuid, text, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_update_scope(uuid, text, uuid[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_subscribe(
  p_session_id uuid,
  p_edge_token text,
  p_vt integer DEFAULT 10,
  p_qty integer DEFAULT 100
) RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_queue_name text;
  v_vt integer := GREATEST(1, COALESCE(p_vt, 10));
  v_qty integer := GREATEST(1, COALESCE(p_qty, 100));
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);

  SELECT queue_name
    INTO v_queue_name
    FROM public.event_sessions
   WHERE session_id = p_session_id
     AND expires_at > now()
     AND hard_expires_at > now();

  IF v_queue_name IS NULL THEN
    RAISE EXCEPTION 'event_session_not_found' USING ERRCODE = '02000';
  END IF;

  RETURN QUERY
    SELECT * FROM pgmq.read(v_queue_name, v_vt, v_qty);
END;
$$;

REVOKE ALL ON FUNCTION public.event_session_subscribe(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_subscribe(uuid, text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_archive(
  p_session_id uuid,
  p_edge_token text,
  p_msg_ids bigint[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_queue_name text;
  v_msg_id bigint;
  v_archived integer := 0;
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);

  SELECT queue_name
    INTO v_queue_name
    FROM public.event_sessions
   WHERE session_id = p_session_id
     AND expires_at > now()
     AND hard_expires_at > now();

  IF v_queue_name IS NULL THEN
    RAISE EXCEPTION 'event_session_not_found' USING ERRCODE = '02000';
  END IF;

  FOREACH v_msg_id IN ARRAY COALESCE(p_msg_ids, ARRAY[]::bigint[]) LOOP
    IF pgmq.archive(v_queue_name, v_msg_id) THEN
      v_archived := v_archived + 1;
    END IF;
  END LOOP;

  RETURN v_archived;
END;
$$;

REVOKE ALL ON FUNCTION public.event_session_archive(uuid, text, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_archive(uuid, text, bigint[]) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_unregister(
  p_session_id uuid,
  p_edge_token text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_queue_name text;
BEGIN
  PERFORM public._assert_valid_edge_token(p_edge_token);

  SELECT queue_name
    INTO v_queue_name
    FROM public.event_sessions
   WHERE session_id = p_session_id;

  IF v_queue_name IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM pgmq.drop_queue(v_queue_name);
  EXCEPTION
    WHEN undefined_table THEN NULL;
  END;

  DELETE FROM public.event_sessions
   WHERE session_id = p_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.event_session_unregister(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_unregister(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.event_session_publish(
  p_msg jsonb,
  p_recipient_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_corp_id uuid DEFAULT NULL,
  p_is_broadcast boolean DEFAULT false
) RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_session record;
  v_msg_ids bigint[] := ARRAY[]::bigint[];
  v_msg_id bigint;
BEGIN
  FOR v_session IN
    SELECT DISTINCT session_id, queue_name
    FROM public.event_sessions
    WHERE expires_at > now()
      AND hard_expires_at > now()
      AND (
        COALESCE(p_is_broadcast, false)
        OR (p_corp_id IS NOT NULL AND corp_id = p_corp_id)
        OR scope_character_ids && COALESCE(p_recipient_ids, ARRAY[]::uuid[])
      )
  LOOP
    BEGIN
      v_msg_id := pgmq.send(v_session.queue_name, p_msg);
      v_msg_ids := array_append(v_msg_ids, v_msg_id);
    EXCEPTION
      WHEN undefined_table THEN
        DELETE FROM public.event_sessions
         WHERE session_id = v_session.session_id;
    END;
  END LOOP;

  RETURN v_msg_ids;
END;
$$;

COMMENT ON FUNCTION public.event_session_publish(jsonb, uuid[], uuid, boolean) IS
  'Internal gameplay event fanout. Publishes only to non-expired online event_sessions; missing stale queues are pruned.';

REVOKE ALL ON FUNCTION public.event_session_publish(jsonb, uuid[], uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_session_publish(jsonb, uuid[], uuid, boolean) TO service_role;

DO $$
DECLARE
  v_fn regprocedure :=
    'public.record_event_with_recipients(text,text,text,uuid,uuid,integer,uuid,uuid,uuid,jsonb,jsonb,text,uuid[],text[],boolean,uuid)'::regprocedure;
  v_def text := pg_get_functiondef(v_fn);
  v_new text;
BEGIN
  v_new := replace(
    v_def,
    $old$
    PERFORM public.ensure_character_queue(v_id);
    PERFORM public.pgmq_publish('chr_' || v_id::TEXT, v_msg);
$old$,
    $new$
    PERFORM public.event_session_publish(
      v_msg,
      ARRAY[v_id]::uuid[],
      NULL::uuid,
      FALSE
    );
$new$
  );

  v_new := replace(
    v_new,
    $old$
    PERFORM public.pgmq_publish('chr_' || v_id::TEXT, v_msg);
$old$,
    $new$
    PERFORM public.event_session_publish(
      v_msg,
      ARRAY[v_id]::uuid[],
      NULL::uuid,
      FALSE
    );
$new$
  );

  v_new := replace(
    v_new,
    $old$
    END;
  END IF;

  IF COALESCE(array_length(v_publish_recipient_ids, 1), 0) = 0 THEN
$old$,
    $new$
    END;

    PERFORM public.event_session_publish(
      v_msg,
      ARRAY[]::uuid[],
      p_corp_id,
      TRUE
    );
  END IF;

  IF COALESCE(array_length(v_publish_recipient_ids, 1), 0) = 0 THEN
$new$
  );

  IF v_new = v_def
     OR position('pgmq_publish(''chr_''' in v_new) > 0
     OR position('event_session_publish' in v_new) = 0 THEN
    RAISE EXCEPTION 'Could not patch record_event_with_recipients for session-scoped pubsub';
  END IF;

  EXECUTE v_new;
END;
$$;

COMMENT ON FUNCTION public.record_event_with_recipients(
  TEXT, TEXT, TEXT, UUID, UUID, INTEGER, UUID, UUID, UUID, JSONB, JSONB, TEXT, UUID[], TEXT[], BOOLEAN, UUID
) IS 'Inserts denormalized event rows and publishes the same event to active session-scoped gameplay pgmq queues. Offline characters do not receive pgmq copies.';

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'event-session-cleanup'
  ) THEN
    PERFORM cron.schedule(
      'event-session-cleanup',
      '* * * * *',
      $$SELECT public.event_session_cleanup(100);$$
    );
  END IF;
END;
$do$;
