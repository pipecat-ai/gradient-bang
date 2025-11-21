# Supabase Logging Cheatsheet

## Enable Verbose Realtime Frames

- Export `SUPABASE_REALTIME_LOG_LEVEL=info` (default baked into the repo). The
  Supabase realtime client now forwards this setting to
  `options.realtime.params.log_level`, so every per-client connection (join,
  subscribe, reconnect, error) is persisted in `realtime_logs`.
- When pytest spins up `EventListener` or the Supabase `AsyncGameClient`, that
  log level automatically travels with the WebSocket handshake. No code changes
  are needed per test—just ensure the env var is set before running.

## Use Polling Instead of Realtime

- Set `SUPABASE_USE_POLLING=1` (already on in `.env.supabase`) to route
  `utils.supabase_client.AsyncGameClient` through the new `events_since` edge
  function. The client polls every
  `SUPABASE_POLL_INTERVAL_SECONDS` (default 1 s, clamped to ≥0.25) and requests
  batches of `SUPABASE_POLL_LIMIT` events (default 100, max 250).
- `tests/helpers/event_capture.py` now uses the same edge function, so payload
  parity captures will continue to match game-client behavior without relying
  on Supabase Realtime being healthy.

## Stream Edge Function Logs

- Use the Supabase CLI to tail whichever function the test hit. Example for the
  `move` RPC:

  ```bash
  npx supabase functions logs move --project-ref pqmccexihlpnljcjfght --tail
  ```

- The output shows request IDs, response status, and any `console.*` output.
  Copy the `request_id` so you can correlate with realtime logs.

## Correlate With Realtime Logs

1. Open the Supabase Dashboard → Project → Logs → Explorer.
2. Select the `realtime_logs` source.
3. Filter by timestamp (or `request_id` if present) copied from the CLI logs.
4. Look for entries with `metadata.event_message` mentioning
   `ChannelRateLimitReached`, `ConnectionRateLimitReached`, or the literal
   "Unknown Error on Channel" payload. These entries now include channel/topic
   metadata thanks to the `log_level=info` setting.

## Example Workflow After a Test Failure

1. Export logging vars and rerun the failing test (e.g.
   `SUPABASE_USE_POLLING=1 SUPABASE_REALTIME_LOG_LEVEL=info USE_SUPABASE_TESTS=1 uv run pytest ...`).
2. Tail the relevant function logs via the CLI command above while the test is
   running to capture the `request_id` that produced the failure.
3. Use that `request_id` (or timestamp) in the Supabase Dashboard’s Logs
   Explorer. First inspect `function_edge_logs` for server errors, then switch to
   `realtime_logs` to confirm whether the channel rejected the subscription.
4. Share both log excerpts in the incident record so it’s clear whether the bug
   lives in the edge handler or Supabase Realtime.

This workflow implements Supabase’s recommended troubleshooting path for
tracking down "Unknown Error on Channel" failures.
