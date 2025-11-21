# Supabase Manual Stack Runbook

These steps keep the edge test harness happy when you opt into `SUPABASE_MANUAL_STACK=1` (for example, when you already have `supabase start` running in another terminal). The new `tests/edge/conftest.py` gatekeepers expect the deterministic fixtures to exist **and** the edge runtime to enforce the shared `EDGE_API_TOKEN`, so follow this exact order before running tests.

## 1. Load local credentials

Make sure `.env.supabase` exists (the Supabase CLI writes one the first time you run `npx supabase start`; otherwise copy `env.example` and fill in the Supabase values), then load it:

```bash
source .env.supabase
export SUPABASE_MANUAL_STACK=1
```

Key requirements:
- `EDGE_API_TOKEN` (default `local-dev-token`) must be present in your environment.
- `SUPABASE_ANON_KEY` should match the value emitted by `npx supabase start` (the default file already does).

## 2. Start the containers

```bash
npx supabase start
```

Leave this process running in its own terminal. It brings up PostgreSQL, Kong, realtime, etc.

## 3. Seed deterministic fixtures via `test_reset`

With the stack running, seed the database using the edge `test_reset` RPC. This guarantees all 600+ canonical characters, ships, and universe data exist before the first test calls `join`.

```bash
curl \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-token: ${EDGE_API_TOKEN}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -d '{}' \
  "${SUPABASE_URL:-http://127.0.0.1:54321}/functions/v1/test_reset"
```

You should see a JSON response similar to:

```json
{"success":true,"inserted_characters":605,"inserted_ships":605,"sectors_seeded":10}
```

The edge tests now expect this RPC to have run; if it fails the fixture will raise instead of emitting dozens of cascading 404s.

## 4. Serve all edge functions with the shared token

```bash
npx supabase functions serve --env-file .env.supabase --no-verify-jwt
```

This command ensures the Deno runtime loads `EDGE_API_TOKEN=local-dev-token`, so `validateApiToken` rejects unauthorized calls. Keep this process running in a second terminal while tests execute.

## 5. Verify health before running pytest

```bash
curl \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-token: ${EDGE_API_TOKEN}" \
  -d '{"healthcheck": true}' \
  "${SUPABASE_URL:-http://127.0.0.1:54321}/functions/v1/join"
```

The JSON payload must report `"token_present": true`. If it is false, restart `supabase functions serve` with the `--env-file` flag so the edge runtime reloads the token.

## 6. Run the edge suite against the manual stack

```bash
USE_SUPABASE_TESTS=1 \
SUPABASE_MANUAL_STACK=1 \
uv run pytest tests/edge -q
```

Because the fixture now calls `test_reset` automatically, you do not need to re-run the curl command between test sessions unless you manually mutate the database outside pytest.

## Troubleshooting

- **`Edge functions are running without EDGE_API_TOKEN`** – Restart `supabase functions serve` with `--env-file .env.supabase --no-verify-jwt` so Deno sees the token. The health check inside `tests/edge/conftest.py` will refuse to run without it.
- **`Supabase join function is not reachable`** – Make sure both `npx supabase start` and `npx supabase functions serve …` are running, then re-run the `test_reset` curl command. The fixture will give this error if the HTTP health check fails.
- **`test_reset edge function is missing`** – Verify you launched `functions serve` from the repository root so it can find `supabase/functions/`.
