-- =============================================================================
-- Broadcast event delivery via Postgres LISTEN/NOTIFY
-- =============================================================================
--
-- Why not pgmq for broadcasts? pgmq.read+archive is competing-consumer: the
-- first reader to archive a message removes it for everyone else. That's the
-- opposite of what broadcasts need (every subscriber must receive every
-- broadcast). Postgres NOTIFY is the right primitive — every connection that
-- has issued LISTEN on the channel receives every notification.
--
-- Trust model: only the server publishes broadcasts. The publish path goes
-- through `notify_broadcast()`, a SECURITY DEFINER function granted only to
-- service_role. The pubsub_client role can issue LISTEN gb_broadcasts (LISTEN
-- has no privilege controls in Postgres), but cannot reach the publish
-- function. A misbehaving client could call NOTIFY directly from its session,
-- but the events table remains authoritative — a fake notification can't
-- forge an event row, only momentarily render in another live session before
-- divergence is detectable.
--
-- Payload limit: NOTIFY payloads are capped at 8000 bytes. Chat broadcasts
-- and gm/system messages fit comfortably; if we ever need larger payloads
-- we'll switch to an id-only nudge with an events-table fetch.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.notify_broadcast(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cap to a safe headroom under Postgres' 8000-byte NOTIFY limit. If the
  -- payload exceeds, drop the broadcast rather than raising — broadcasts
  -- are best-effort and a single oversize message must not break event
  -- recording (which already happened on the events table side).
  IF length(p_payload::text) > 7800 THEN
    RAISE WARNING 'notify_broadcast: payload too large (%). dropping', length(p_payload::text);
    RETURN;
  END IF;
  PERFORM pg_notify('gb_broadcasts', p_payload::text);
END;
$$;

COMMENT ON FUNCTION public.notify_broadcast IS
  'Server-only broadcast publish wrapper. Granted to service_role; pubsub_client cannot reach this. Subscribers consume via LISTEN gb_broadcasts.';

REVOKE ALL ON FUNCTION public.notify_broadcast(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_broadcast(jsonb) TO service_role;
