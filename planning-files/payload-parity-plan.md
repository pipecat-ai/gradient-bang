# Supabase Payload Parity Plan

## 1. Current Status
- Added `scripts/payload_capture_runner.py`, `scripts/compare_payloads.py`, and `scripts/double_run_payload_parity.py` so we can capture legacy vs Supabase events and diff JSONL dumps per test.
- `scripts/reset_test_state.py` and `tests/helpers/supabase_reset.py` now force Supabase to load `tests/test-world-data` fixtures directly (no edge RPC), so both transports share identical seeds.
- `supabase/functions/_shared/map.ts` re-emits sector snapshots in the legacy shape (null garrisons, fixture-driven ship names) to reduce diff noise.
- Latest double-run (`logs/payload-parity/tests_integration_test_game_server_api_py__test_move_to_adjacent_sector/20251111-003901/`) shows remaining diffs only come from canonical UUIDs/request IDs, as expected.

## 2. Running The Double-Run Harness
1. Source Supabase env vars (e.g., `set -a && source .env.supabase && set +a`).
2. Execute:  
   `uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::test_move_to_adjacent_sector`
3. Inspect `logs/payload-parity/<slug>/<timestamp>/` for step logs and `events.*.jsonl`. Re-run after any code/fixture change.

## 3. Planned Payload Comparison Helper
- Create `tests/helpers/payload_assertions.py` that exposes comparer functions per event type (starting with `status.snapshot`, `movement.*`, `map.local`).
- Each comparer accepts legacy payload, Supabase payload, and a fixture context; the helper handles canonical-vs-legacy IDs, null-vs-empty semantics, ship metadata, etc.
- Provide utilities like:
  - `assert_character_identity(event, legacy_id)` to verify canonical IDs map back to legacy strings.
  - `normalize_status_snapshot(event, fixture)` to strip transient fields and return a comparable dict.
  - `compare_status_snapshot(legacy_event, supabase_event, fixture)` to raise descriptive diffs.
- Tests (or the double-run harness) call these helpers instead of raw equality checks, letting us modernize Supabase IDs without breaking existing expectations.
- Grow the module organically: as we migrate more tests, add new comparator functions and fixture lookups (map knowledge, corp memberships, etc.).

- (Future) Consider wiring `payload_assertions` into pytest fixtures so tests can request legacy+Supabase runs inline. For example, a fixture could capture legacy events once, run Supabase under `USE_SUPABASE_TESTS=1`, and call the appropriate comparer automatically, reducing reliance on the shell harness.
