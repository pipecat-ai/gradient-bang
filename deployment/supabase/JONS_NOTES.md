# Supabase - Jon's Setup Notes

## Things to check with khk:

- Should we be gitignoring `supabase/config.toml`? If we do, we should bypass running `supabase init` 
- Regarding running tests against a live DB - supabase supports test schema, do you don't have to create and swap between projects e.g: **Test**: `gradient-bang-test` **Prod**: `gradient-bang-prod`. This approach is probably safer, but it does meaning having two projects setup which may be configured differently. Sesame has an example of using pytest against a test schema.
- "Specifying decorator through flags is no longer supported. Please use deno.json instead." when deploying functions

## Local to prod steps

```bash
# Sync all Python dependencies
uv sync --all-groups

# NOTE: DO NOT DO THIS - installs old version, use npx instead!
# Install Supabase CLI
# brew install supabase
# or
# npm install supabase -g

# Init the project (no need to do this if using existing config)
npx supabase init --workdir deployment/ 

# Start (creates database, runs migrations etc)
npx supabase start --workdir deployment/ 

# Note - to stop, you need to stop everything, or processes dangle:
# npx supabase stop --workdir deployment/ --all --no-backup

# Open Studio URL to verify all is working
> http://127.0.0.1:54323

# Reset DB, just to check CLI linked correctly
npx supabase db reset --workdir deployment/

```


## Create local env and run functions

Set env for local dev:

```bash
# .env.supabase
EDGE_API_TOKEN=local-dev-token
EDGE_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1
EDGE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long
```

Server functions locally:

```bash
npx supabase functions serve --env-file .env.supabase --no-verify-jwt --workdir deployment
```

### Quick test to make sure all is configured correctly

```bash
# Note: ensure previous container is shut down: npx supabase stop --workdir deployment/ --all --no-backup

# Note: tests should load env.supabase, but I'm not sure, so set anyway
set -a && source .env.supabase && set +a

# Run all tests
USE_SUPABASE_TESTS=1 uv run pytest tests/integration/ -v -x --supabase-dir deployment

# Run last failed
# USE_SUPABASE_TESTS=1 uv run pytest tests/integration/ -v -x --lf  --supabase-dir deployment

# Note: check /logs in root for any errors
```

## Create a new universe

```bash
uv run universe-bang 100 123

# Dry-run validation
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/ --dry-run

uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/

# Force reload (dangerous!)
# uv run -m gradientbang.scriptsload_universe_to_supabase.py --from-json world-data/ --force

# Compare to supabase 
uv run -m gradientbang.scripts.compare_universe_data --from-json world-data/
```

## Deploy to Cloud

Create Supabase project and link:

```bash
# Use CLI to select project
npx supabase link --workdir deployment

# Drop any existing tables
npx supabase db reset --workdir deployment --linked

# Migrate DB
npx supabase db push --workdir deployment

# Deploy functions
npx supabase functions deploy --no-verify-jwt --workdir deployment
```

Create `.env.cloud`

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
```

```bash
set -a && source .env.cloud && set +a

# Load universe data from local world-data
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data --force  # --dry-run 

# Create new character
uv run character-create Test --supabase 
```

Test bot locally again cloud

```bash
uv run gb-bot
```