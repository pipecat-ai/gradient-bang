-- Revert to DEFAULT replica identity (only primary key in WAL)
-- REPLICA IDENTITY FULL was needed for Realtime RLS evaluation
-- Reverting reduces WAL size and improves replication performance
ALTER TABLE public.events REPLICA IDENTITY DEFAULT;

COMMENT ON TABLE public.events IS
'Game events log with RLS-based visibility. Event delivery via HTTP polling (events_since endpoint).';
