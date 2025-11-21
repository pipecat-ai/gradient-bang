-- Set REPLICA IDENTITY FULL for events table
-- This is REQUIRED for Supabase Realtime postgres_changes to deliver events with RLS.
-- Without FULL replica identity, the WAL only includes primary keys, preventing RLS
-- policy evaluation on the Realtime service side.
ALTER TABLE public.events REPLICA IDENTITY FULL;

COMMENT ON TABLE public.events IS 'Game events log with RLS-based visibility and CDC streaming via postgres_changes. REPLICA IDENTITY FULL enables RLS evaluation in Realtime changefeed.';
