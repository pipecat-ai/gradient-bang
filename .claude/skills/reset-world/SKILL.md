# Reset World

Resets the game database, generates a fresh universe, loads quest definitions, and seeds combat cron config.

## Parameters

Ask the user for:
- **Environment**: `local` (default) or `cloud` (uses `.env.cloud`)
- **Sector count**: number of sectors to generate (default: `5000`)
- **Seed**: optional universe seed for reproducibility

## Steps

### 1. Source environment variables

```bash
set -a && source .env.supabase && set +a
```

For cloud, use `.env.cloud` instead.

### 2. Run the world reset script

This truncates all game data tables (preserving auth.users), generates a new universe, loads it into Supabase, and loads quest definitions.

For local:
```bash
scripts/reset-world.sh <sector_count> [seed]
```

For cloud:
```bash
scripts/reset-world.sh --env .env.cloud <sector_count> [seed]
```

Redirect output to a file and monitor with `tail`:
```bash
scripts/reset-world.sh <args> > /tmp/reset-world.log 2>&1
```

### 3. Seed combat cron config

After the world reset, seed the combat cron runtime config into `app_runtime_config`.

For local dev, run this docker exec command (env vars should already be sourced from step 1):

```bash
docker exec -e PGPASSWORD=postgres supabase_db_gb-world-server \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO app_runtime_config (key, value, description) VALUES
    ('supabase_url', '${SUPABASE_INTERNAL_URL:-http://host.docker.internal:54321}', 'Base Supabase URL reachable from the DB container'),
    ('edge_api_token', '${EDGE_API_TOKEN:-local-dev-token}', 'Edge token for combat_tick auth'),
    ('supabase_anon_key', '${SUPABASE_ANON_KEY}', 'Anon key for Supabase auth headers')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"
```

For cloud, run:
```bash
scripts/setup-production-combat-tick.sh
```

### 4. Verify

Confirm the reset completed by checking the log output for the "Complete!" message and that no errors occurred.

## Important notes

- The `reset-world.sh` script handles: truncating tables, generating universe (`universe-bang`), loading universe data, and loading quest definitions.
- All output from scripts should be redirected to files. Do NOT use `tee`.
- For cloud resets, the script will prompt for confirmation before wiping data.
- Combat cron config is NOT modified by `reset-world.sh` -- you must run the cron script separately.
