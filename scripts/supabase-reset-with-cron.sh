#!/usr/bin/env bash
set -euo pipefail

# Reset the local Supabase stack and seed combat cron runtime config
# Usage: scripts/supabase-reset-with-cron.sh

WORKDIR="${WORKDIR:-deployment}"
ENV_FILE="${ENV_FILE:-.env.supabase}"
DB_CONTAINER="supabase_db_gb-world-server"
INTERNAL_URL_DEFAULT="http://host.docker.internal:54321"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Run 'supabase start --workdir $WORKDIR' first." >&2
  exit 1
fi

# Load env for EDGE_API_TOKEN and SUPABASE_URL
set -a
source "$ENV_FILE"
set +a

SUPABASE_INTERNAL_URL="${SUPABASE_INTERNAL_URL:-$INTERNAL_URL_DEFAULT}"
EDGE_API_TOKEN="${EDGE_API_TOKEN:-local-dev-token}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-$SUPABASE_ANON_KEY}"

SUPABASE_INTERNAL_URL_ESCAPED=${SUPABASE_INTERNAL_URL//\'/\'\'}
EDGE_API_TOKEN_ESCAPED=${EDGE_API_TOKEN//\'/\'\'}
SUPABASE_ANON_KEY_ESCAPED=${SUPABASE_ANON_KEY//\'/\'\'}

echo "[reset] Running supabase db reset --workdir $WORKDIR ..."
npx supabase db reset --workdir "$WORKDIR"

echo "[reset] Seeding combat cron config in $DB_CONTAINER ..."
docker exec -e PGPASSWORD=postgres "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c "INSERT INTO app_runtime_config (key, value, description) VALUES \
    ('supabase_url', '${SUPABASE_INTERNAL_URL_ESCAPED}', 'Base Supabase URL reachable from the DB container'), \
    ('edge_api_token', '${EDGE_API_TOKEN_ESCAPED}', 'Edge token for combat_tick auth'), \
    ('supabase_anon_key', '${SUPABASE_ANON_KEY_ESCAPED}', 'Anon key for Supabase auth headers') \
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"

echo "[reset] Done."
