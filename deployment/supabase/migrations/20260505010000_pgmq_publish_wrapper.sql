-- =============================================================================
-- pgmq_publish: thin wrapper for service-role server-side enqueue
-- =============================================================================
--
-- Edge functions (running as `service_role`) need to publish to per-character
-- pgmq queues alongside writing to the `events` table. Supabase's RPC API
-- only exposes the `public` schema, so we wrap `pgmq.send` here.
--
-- This is server-only: granted to `service_role`. Subscribers still go
-- through `subscribe_my_events` / `archive_my_events` from the prior
-- migration, with full per-character JWT auth.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pgmq_publish(
  p_queue_name text,
  p_msg jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_msg_id bigint;
BEGIN
  v_msg_id := pgmq.send(p_queue_name, p_msg);
  RETURN v_msg_id;
END;
$$;

COMMENT ON FUNCTION public.pgmq_publish IS
  'Server-side publish wrapper for pgmq.send. Granted to service_role only. Subscribers must use subscribe_my_events.';

-- Grant to service_role only — pubsub_client must NOT have publish access.
REVOKE ALL ON FUNCTION public.pgmq_publish(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pgmq_publish(text, jsonb) TO service_role;
