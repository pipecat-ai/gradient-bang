#!/usr/bin/env bash
set -euo pipefail

# Upsert combat cron runtime config in a production Supabase database.
# Requires: DATABASE_URL (or POSTGRES_POOLER_URL) Postgres connection string, SUPABASE_URL, EDGE_API_TOKEN, SUPABASE_ANON_KEY

DB_URL=${DATABASE_URL:-${POSTGRES_POOLER_URL:-}}
SUPA_URL=${SUPABASE_URL:-}
TOKEN=${EDGE_API_TOKEN:-}
ANON=${SUPABASE_ANON_KEY:-}

if [[ -z "$DB_URL" ]]; then
  echo "DATABASE_URL or POSTGRES_POOLER_URL is required (service-role connection string)" >&2
  exit 1
fi
if [[ -z "$SUPA_URL" ]]; then
  echo "SUPABASE_URL is required" >&2
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  echo "EDGE_API_TOKEN is required" >&2
  exit 1
fi
if [[ -z "$ANON" ]]; then
  echo "SUPABASE_ANON_KEY is required" >&2
  exit 1
fi

SUPA_URL=${SUPA_URL%%/}
SUPA_URL_ESCAPED=${SUPA_URL//\'/\'\'}
TOKEN_ESCAPED=${TOKEN//\'/\'\'}
ANON_ESCAPED=${ANON//\'/\'\'}

psql "$DB_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO app_runtime_config (key, value, description) VALUES
    ('supabase_url', '${SUPA_URL_ESCAPED}', 'Base Supabase URL reachable from the DB instance'),
    ('edge_api_token', '${TOKEN_ESCAPED}', 'Edge token for combat_tick auth'),
    ('supabase_anon_key', '${ANON_ESCAPED}', 'Anon key for Supabase auth headers')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  SELECT key, updated_at FROM app_runtime_config WHERE key IN ('supabase_url', 'edge_api_token');
"
