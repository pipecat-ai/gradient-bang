-- Ensure events table is included in the supabase_realtime publication so
-- Postgres CDC streams reach the Realtime service.
ALTER PUBLICATION supabase_realtime ADD TABLE events;
