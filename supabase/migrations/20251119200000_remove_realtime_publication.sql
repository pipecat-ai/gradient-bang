-- Remove events table from Realtime publication
-- Context: HTTP polling via events_since endpoint replaced Realtime
-- Note: DROP TABLE from publication doesn't support IF EXISTS clause

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'events'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.events;
  END IF;
END;
$$;

COMMENT ON TABLE public.events IS
'Game events log with RLS-based visibility. Event delivery via HTTP polling (events_since endpoint).';
