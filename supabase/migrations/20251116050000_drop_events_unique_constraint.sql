-- Drop overly restrictive unique constraint that prevents legitimate multi-event scenarios
-- (e.g., move emits both depart and arrive character.moved events in same request)
SET search_path = public;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_request_event_actor_unique;
