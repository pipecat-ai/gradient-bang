# Supabase Polling Migration Plan

## 1. Edge Function: `events_since`

- Implement a Supabase edge function that accepts `character_id`, optional
  `since_event_id` (or timestamp), and `limit`.
- Canonicalize IDs, reuse the existing recipient lookup helpers, and return all
  rows from `public.events` the caller is entitled to see where
  `event_id > since_event_id`, ordered ascending with a reasonable limit.
- Include metadata like `last_event_id` / `has_more` so clients can advance their
  checkpoints and handle backfill when batches exceed the limit.

## 2. AsyncGameClient Poller

- Replace `_ensure_realtime_listener` with a background polling task that calls
  `events_since` every ~1 s (interval configurable via env).
- Track `self._last_event_id` per client; initialize from the first poll and
  update after each batch.
- Feed returned events through the existing `_process_event` pipeline so
  downstream handlers/tests remain unchanged.
- Add retry/backoff and graceful shutdown so transient failures don’t drop
  events.

## 3. Tests & Helpers

- Update `tests/helpers/event_capture.py` so `create_firehose_listener` wraps the
  polling-driven `AsyncGameClient` instead of managing its own Realtime
  connection.
- Ensure payload-parity fixtures, NPC runners, and any tooling that relied on
  the old listener reuse the same poller; there should be a single transport
  implementation.

## 4. Configuration & Feature Flag

- Introduce `SUPABASE_USE_POLLING=1` (default off) so we can toggle between
  Realtime and polling during development/CI until the new path stabilizes.
- Document the new env knobs (poll interval, batch size) and update
  `docs/supabase-logging.md` / AGENTS with the polling troubleshooting flow.

## 5. Validation & Rollout

- Add unit/integration tests for `events_since` to confirm RLS/recipient scopes
  are honored.
- Run the integration + payload-parity suites with polling enabled to ensure
  behavior matches the realtime path.
- Once green, flip the default to polling, remove the Realtime listener code,
  and keep the Postgres RLS policies in place for defense in depth.
