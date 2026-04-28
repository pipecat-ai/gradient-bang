# Reset World

Resets the game database, generates a fresh universe, loads quest definitions, and seeds combat cron config.

## Production safety

**This skill MUST NEVER run against production (`.env.cloud`).** If the user asks for `/reset-world prod` or `/reset-world production`, REFUSE. Tell them:

> Production resets cannot be run through this skill. To reset production, run the script manually where you get interactive confirmation prompts:
>
> ```bash
> scripts/reset-world.sh --env .env.cloud --allow-production [sector_count] [seed]
> ```

Do NOT offer to proceed, do NOT ask for confirmation, do NOT accept "I'm sure" — just refuse and show the manual command.

## Parameters

The user specifies the environment as an argument: `/reset-world local` or `/reset-world dev`. If not provided, ask which environment.

- `local` → env file: `.env.supabase`
- `dev` → env file: `.env.cloud.dev`

Additional optional parameters (ask if not provided, or use defaults):
- **Sector count**: number of sectors to generate (default: `5000`)
- **Seed**: optional universe seed for reproducibility

## Steps

### 1. Derive the project ref (cloud only)

For **dev**, extract the Supabase project ref from `SUPABASE_URL` in the env file. This value is passed to both scripts via `--confirm-ref` so confirmation prompts can run non-interactively, while still aborting on any mismatch:

```bash
ref=$(grep '^SUPABASE_URL=' .env.cloud.dev | sed 's|.*//||;s|\..*||')
```

Skip for **local**.

### 2. Source environment variables (optional)

The scripts source the env file themselves via `--env`. Pre-sourcing is only needed if you want the env vars in your shell for follow-up commands.

```bash
set -a && source <env-file> && set +a
```

### 3. Run the world reset script

This truncates all game data tables (preserving auth.users), generates a new universe, loads it into Supabase, and loads quest definitions.

For **local**:
```bash
scripts/reset-world.sh --yes <sector_count> [seed]
```

For **dev**:
```bash
scripts/reset-world.sh --env .env.cloud.dev --confirm-ref "$ref" <sector_count> [seed]
```

Production is never run from this skill. The script enforces this independently — `.env.cloud` requires `--allow-production` AND will refuse to honor `--confirm-ref` for production (forces interactive `DESTROY PRODUCTION` typing).

### 4. Seed combat cron config

After the world reset, seed the combat cron runtime config into `app_runtime_config`.

For **local**, run this docker exec command (env vars should already be sourced from step 2):

```bash
docker exec -e PGPASSWORD=postgres supabase_db_gb-world-server \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO app_runtime_config (key, value, description) VALUES
    ('supabase_url', '${SUPABASE_INTERNAL_URL:-http://host.docker.internal:54321}', 'Base Supabase URL reachable from the DB container'),
    ('edge_api_token', '${EDGE_API_TOKEN:-local-dev-token}', 'Edge token for combat_tick auth'),
    ('supabase_anon_key', '${SUPABASE_ANON_KEY}', 'Anon key for Supabase auth headers')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"
```

For **dev**, run:
```bash
scripts/setup-production-combat-tick.sh --env .env.cloud.dev --confirm-ref "$ref"
```

For **prod** (manual only — never invoke through this skill):
```bash
scripts/setup-production-combat-tick.sh --env .env.cloud --allow-production
```

### 5. Verify

Confirm the reset completed by checking the script output for the "Complete!" message and that no errors occurred.

## Important notes

- The `reset-world.sh` script handles: truncating tables, generating universe (`universe-bang`), loading universe data, and loading quest definitions.
- For cloud resets, `--confirm-ref` answers the project-ref prompt non-interactively. The script still aborts if the ref doesn't match what it derives from `SUPABASE_URL` in the env file — so you can't accidentally pass a stale ref from a different project.
- Combat cron config is NOT modified by `reset-world.sh` -- you must run the cron script separately.
