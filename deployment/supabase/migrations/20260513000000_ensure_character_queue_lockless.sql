-- =============================================================================
-- pubsub: lock-free fast path for ensure_character_queue
--
-- Previously: ensure_character_queue → pgmq.create → CREATE TABLE IF NOT EXISTS.
-- Even when the queue already exists, that statement grabs an
-- AccessExclusiveLock on the queue table. ensure_character_queue is called
-- from subscribe_my_events, whose surrounding txn then enters a 30s
-- pgmq.read_with_poll loop — so the lock is held for the entire poll, and
-- every concurrent pgmq.send to the same queue blocks behind it.
--
-- Fix: check pg_class first. The lookup is a cheap catalog SELECT that takes
-- no table-level locks. Only when the queue is genuinely missing do we fall
-- through to pgmq.create.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ensure_character_queue(p_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_qtable text := 'q_chr_' || p_character_id::text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgmq' AND c.relname = v_qtable
  ) THEN
    RETURN;
  END IF;
  PERFORM pgmq.create('chr_' || p_character_id::text);
EXCEPTION
  WHEN duplicate_table THEN
    NULL;
END;
$$;

COMMENT ON FUNCTION public.ensure_character_queue IS
  'Idempotent queue ensure for a character_id. Fast path checks pg_class to avoid the AccessExclusiveLock that CREATE TABLE IF NOT EXISTS takes on existing tables — required because the caller (subscribe_my_events) holds its txn open for a 30s read_with_poll.';
