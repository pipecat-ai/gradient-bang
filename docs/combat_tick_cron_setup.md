# Combat Tick Cron Setup

The combat cron helper (`invoke_combat_tick`) now reads its target URL and API token from `app_runtime_config` instead of Postgres GUCs. Seed the two keys (`supabase_url`, `edge_api_token`) per environment.

## Local development

1. Start Supabase: `npx supabase start --workdir deployment/` (or ensure it is running).
2. Seed the config (does a reset too):
   ```bash
   scripts/supabase-reset-with-cron.sh
   ```
   - Reads `.env.supabase` for `EDGE_API_TOKEN` and `SUPABASE_URL`.
   - Uses `SUPABASE_INTERNAL_URL` override for Linux bridge IPs (default `http://host.docker.internal:54321`).

   Or seed without resetting:
   ```bash
   psql "$(npx supabase status -o json --workdir deployment | jq -r .db.url)" \
     -f scripts/setup-local-combat-tick.sql \
     -v url="$SUPABASE_INTERNAL_URL" -v token="$EDGE_API_TOKEN"
   ```
   The `-v` args are optional; defaults are host.docker.internal + `local-dev-token`.

3. Verify:
   ```sql
   SELECT key, value, updated_at FROM app_runtime_config
   WHERE key IN ('supabase_url', 'edge_api_token');
   ```

## Production / staging (Supabase Cloud)

1. Set env vars in your shell (do **not** commit them):
- `DATABASE_URL` **or** `SUPABASE_DB_URL` (service-role connection string from Supabase dashboard)
- `SUPABASE_URL` (e.g., `https://your-project.supabase.co`)
- `EDGE_API_TOKEN` (same token edge functions expect in `x-api-token`)
- `SUPABASE_ANON_KEY` (used by cron auth headers)
2. Upsert the config:
   ```bash
   scripts/setup-production-combat-tick.sh
   ```
3. Verify:
   ```sql
   SELECT key, updated_at FROM app_runtime_config
   WHERE key IN ('supabase_url', 'edge_api_token');
   ```

## Notes
- `invoke_combat_tick()` raises a clear error if either key is missing (no silent fallback in production). Use the dev scripts above after any DB reset.
- The cron job defined in `20251117040000_enable_combat_tick_cron.sql` keeps working; the helper function now reads from `app_runtime_config`.
