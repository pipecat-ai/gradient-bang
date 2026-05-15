-- ============================================================================
-- Subagent Bus Queue Cleanup
-- ============================================================================
-- The PGMQ subagent bus uses per-session gb_<uuid> channels and per-peer
-- q_<uuid> queues registered in public.bus_peers. Clean shutdown calls
-- public.bus_leave(), which drops the peer queue immediately. If a bot or BYOA
-- process crashes before leave, the channel is dead because future sessions get
-- fresh UUID channels, but the orphan queue/table can remain in pgmq.
--
-- Sessions are expected to last only a few hours. This janitor conservatively
-- drops bus peer queues older than 48 hours in bounded batches.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE INDEX IF NOT EXISTS bus_peers_created_at_idx
  ON public.bus_peers(created_at);

CREATE OR REPLACE FUNCTION public.subagent_bus_cleanup(
  p_max_age interval DEFAULT INTERVAL '48 hours',
  p_batch_size integer DEFAULT 100
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq, extensions, pg_temp
AS $$
DECLARE
  v_peer record;
  v_cleaned integer := 0;
  v_limit integer := GREATEST(1, COALESCE(p_batch_size, 100));
  v_max_age interval := COALESCE(p_max_age, INTERVAL '48 hours');
  v_cutoff timestamptz;
  v_locked boolean;
BEGIN
  IF v_max_age <= INTERVAL '0 seconds' THEN
    v_max_age := INTERVAL '48 hours';
  END IF;
  v_cutoff := now() - v_max_age;

  v_locked := pg_try_advisory_lock(hashtext('subagent_bus_cleanup'));
  IF NOT v_locked THEN
    RETURN 0;
  END IF;

  BEGIN
    FOR v_peer IN
      SELECT queue_name
      FROM public.bus_peers
      WHERE created_at < v_cutoff
      ORDER BY created_at ASC
      LIMIT v_limit
      FOR UPDATE SKIP LOCKED
    LOOP
      BEGIN
        PERFORM pgmq.drop_queue(v_peer.queue_name);
      EXCEPTION
        WHEN undefined_table THEN NULL;
        WHEN OTHERS THEN
          RAISE WARNING 'subagent_bus_cleanup drop_queue failed for %: %',
            v_peer.queue_name, SQLERRM;
          CONTINUE;
      END;

      DELETE FROM public.bus_peers
       WHERE queue_name = v_peer.queue_name;
      v_cleaned := v_cleaned + 1;
    END LOOP;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM pg_advisory_unlock(hashtext('subagent_bus_cleanup'));
      RAISE;
  END;

  PERFORM pg_advisory_unlock(hashtext('subagent_bus_cleanup'));
  RETURN v_cleaned;
END;
$$;

COMMENT ON FUNCTION public.subagent_bus_cleanup(interval, integer) IS
  'Drops orphaned PGMQ subagent bus peer queues older than p_max_age and deletes their bus_peers rows in a bounded SKIP LOCKED batch. Safe to run from pg_cron.';

REVOKE ALL ON FUNCTION public.subagent_bus_cleanup(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subagent_bus_cleanup(interval, integer) TO service_role;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'subagent-bus-cleanup'
  ) THEN
    PERFORM cron.schedule(
      'subagent-bus-cleanup',
      '17 * * * *',
      $$SELECT public.subagent_bus_cleanup(INTERVAL '48 hours', 100);$$
    );
  END IF;
END;
$do$;
