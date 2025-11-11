-- Add unique constraint for event idempotency
SET search_path = public;

ALTER TABLE public.events
  ADD CONSTRAINT events_request_event_actor_unique
  UNIQUE (request_id, event_type, actor_character_id);
