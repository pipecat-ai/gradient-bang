# Reset World

Resets the game database, generates a fresh universe, loads quest definitions, and seeds combat cron config.

## Production safety

Production (`.env.cloud`) is destructive and irreversible. It is **only** allowed when ALL of these are true:

1. The user invoked this skill with `prod` or `production` explicitly (e.g. `/reset-world prod`). Do NOT route to prod from a generic `/reset-world` invocation, even if context suggests it.
2. Claude has surfaced the env file, project ref, and a plain-English warning, then asked the user to confirm in this chat.
3. The user has replied with an explicit, unambiguous confirmation in this same conversation (e.g. "yes, destroy production"). A prior "sure go ahead" from earlier in the session does NOT count — re-confirm every time.

If any of those is missing, do NOT run prod. Show the manual command instead:

```bash
scripts/reset-world.sh --env .env.cloud --allow-production [sector_count] [seed]
```

The underlying script has its own independent safeguard: it ignores `--yes` / `--confirm-ref` for production and requires the literal string `DESTROY PRODUCTION` on stdin. The skill pipes that string in (see step 3 below) — so the chat-level confirmation above is the real gate.

## Parameters

The user specifies the environment as an argument: `/reset-world local`, `/reset-world dev`, or `/reset-world prod`. If not provided, ask which environment.

- `local` → env file: `.env.supabase`
- `dev` → env file: `.env.cloud.dev`
- `prod` / `production` → env file: `.env.cloud` (requires explicit chat confirmation, see above)

Additional optional parameters (ask if not provided, or use defaults):
- **Sector count**: number of sectors to generate (default: `5000`)
- **Seed**: optional universe seed for reproducibility

## Steps

### 1. Derive the project ref (cloud only)

For **dev** and **prod**, extract the Supabase project ref from `SUPABASE_URL` in the env file. For **dev** this is passed to both scripts via `--confirm-ref` so confirmation prompts can run non-interactively, while still aborting on any mismatch. For **prod**, derive it anyway and display it to the user as part of the chat-level confirmation (the script ignores `--confirm-ref` for prod).

```bash
# dev
ref=$(grep '^SUPABASE_URL=' .env.cloud.dev | sed 's|.*//||;s|\..*||')
# prod
ref=$(grep '^SUPABASE_URL=' .env.cloud | sed 's|.*//||;s|\..*||')
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

For **prod** — only after the user has explicitly confirmed in chat (see Production safety):
```bash
echo "DESTROY PRODUCTION" | scripts/reset-world.sh --env .env.cloud --allow-production <sector_count> [seed]
```

`--confirm-ref` and `--yes` are intentionally NOT passed for prod — the script ignores them and requires `DESTROY PRODUCTION` on stdin, which the pipe supplies.

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

For **prod** — only after the same chat-level confirmation from Production safety (reuse it; don't re-prompt if step 3 just succeeded):
```bash
scripts/setup-production-combat-tick.sh --env .env.cloud --allow-production
```

If this script also has an interactive prompt, pipe the expected confirmation string the same way step 3 does. Inspect the script before running if unsure.

### 5. Verify

Confirm the reset completed by checking the script output for the "Complete!" message and that no errors occurred.

## Important notes

- The `reset-world.sh` script handles: truncating tables, generating universe (`universe-bang`), loading universe data, and loading quest definitions.
- For cloud resets, `--confirm-ref` answers the project-ref prompt non-interactively. The script still aborts if the ref doesn't match what it derives from `SUPABASE_URL` in the env file — so you can't accidentally pass a stale ref from a different project.
- Combat cron config is NOT modified by `reset-world.sh` -- you must run the cron script separately.
