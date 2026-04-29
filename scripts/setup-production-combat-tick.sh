#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Setup combat tick runtime config
#
# Upserts combat cron runtime config in a Supabase database.
# Reads connection details from an env file (required).
#
# Usage:
#   scripts/setup-production-combat-tick.sh --env .env.cloud.dev
#   scripts/setup-production-combat-tick.sh --env .env.cloud --allow-production
#
# Required env vars (loaded from --env file):
#   DATABASE_URL or POSTGRES_POOLER_URL  -- service-role connection string
#   SUPABASE_URL
#   EDGE_API_TOKEN
#   SUPABASE_ANON_KEY
# =============================================================================

ENV_FILE=""
ALLOW_PRODUCTION=false
CONFIRM_REF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-production)
      ALLOW_PRODUCTION=true
      shift
      ;;
    --env)
      ENV_FILE="$2"
      shift 2
      ;;
    --env=*)
      ENV_FILE="${1#--env=}"
      shift
      ;;
    --confirm-ref)
      CONFIRM_REF="$2"
      shift 2
      ;;
    --confirm-ref=*)
      CONFIRM_REF="${1#--confirm-ref=}"
      shift
      ;;
    *)
      echo "[combat-tick-config] Unknown argument: $1" >&2
      echo "Usage: scripts/setup-production-combat-tick.sh --env <env-file> [--confirm-ref REF] [--allow-production]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$ENV_FILE" ]]; then
  echo "[combat-tick-config] --env <env-file> is required." >&2
  echo "  Example: scripts/setup-production-combat-tick.sh --env .env.cloud.dev" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[combat-tick-config] Missing $ENV_FILE." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Production guard: .env.cloud (no suffix) = production
# Require --allow-production flag to proceed
# ---------------------------------------------------------------------------

IS_PRODUCTION=false
BASENAME=$(basename "$ENV_FILE")
if [[ "$BASENAME" == ".env.cloud" ]]; then
  IS_PRODUCTION=true
fi

if [[ "$IS_PRODUCTION" == true && "$ALLOW_PRODUCTION" != true ]]; then
  echo "" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo "  BLOCKED: This env file targets PRODUCTION." >&2
  echo "" >&2
  echo "  Env file : $ENV_FILE" >&2
  echo "" >&2
  echo "  To run against production, pass --allow-production:" >&2
  echo "" >&2
  echo "    scripts/setup-production-combat-tick.sh --env $ENV_FILE --allow-production" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo "" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Load environment variables
# ---------------------------------------------------------------------------

set -a
source "$ENV_FILE"
set +a

DB_URL=${DATABASE_URL:-${POSTGRES_POOLER_URL:-}}
SUPA_URL=${SUPABASE_URL:-}
TOKEN=${EDGE_API_TOKEN:-}
ANON=${SUPABASE_ANON_KEY:-}

if [[ -z "$DB_URL" ]]; then
  echo "[combat-tick-config] DATABASE_URL or POSTGRES_POOLER_URL is required (service-role connection string)" >&2
  exit 1
fi
if [[ -z "$SUPA_URL" ]]; then
  echo "[combat-tick-config] SUPABASE_URL is required" >&2
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  echo "[combat-tick-config] EDGE_API_TOKEN is required" >&2
  exit 1
fi
if [[ -z "$ANON" ]]; then
  echo "[combat-tick-config] SUPABASE_ANON_KEY is required" >&2
  exit 1
fi

SUPA_URL=${SUPA_URL%%/}
PROJECT_REF=$(echo "$SUPA_URL" | sed -n 's|https://\([^.]*\)\.supabase\.co.*|\1|p')

# ---------------------------------------------------------------------------
# Summary + interactive confirmation
# ---------------------------------------------------------------------------

echo ""
echo "============================================================"
echo "[combat-tick-config] Upsert combat cron runtime config"
echo "============================================================"
echo "  Env file     : $ENV_FILE"
echo "  Supabase URL : $SUPA_URL"
echo "  Project ref  : ${PROJECT_REF:-<unknown>}"
echo "  Production   : $IS_PRODUCTION"
echo "============================================================"
echo ""

if [[ "$IS_PRODUCTION" == true ]]; then
  # Production NEVER honors --confirm-ref. Always interactive.
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  WARNING: YOU ARE ABOUT TO MODIFY PRODUCTION RUNTIME CONFIG"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  echo "  Misconfiguring these values can silently break combat tick"
  echo "  auth in production until manually corrected."
  echo ""
  if [[ -n "$CONFIRM_REF" ]]; then
    echo "[combat-tick-config] --confirm-ref is NOT honored for production." >&2
    echo "[combat-tick-config] Production confirmation must be typed interactively." >&2
  fi
  read -r -p "[combat-tick-config] Type 'MODIFY PRODUCTION' to confirm: " confirm
  if [[ "$confirm" != "MODIFY PRODUCTION" ]]; then
    echo "[combat-tick-config] Aborted. (expected 'MODIFY PRODUCTION')"
    exit 0
  fi
  echo ""
else
  if [[ -n "$CONFIRM_REF" ]]; then
    if [[ "$CONFIRM_REF" != "$PROJECT_REF" ]]; then
      echo "[combat-tick-config] --confirm-ref mismatch. Aborting." >&2
      echo "  expected : $PROJECT_REF" >&2
      echo "  received : $CONFIRM_REF" >&2
      exit 1
    fi
    echo "[combat-tick-config] --confirm-ref matches project ref ($PROJECT_REF). Proceeding."
  else
    read -r -p "[combat-tick-config] Type the project ref to confirm: " confirm
    if [[ "$confirm" != "$PROJECT_REF" ]]; then
      echo "[combat-tick-config] Aborted. (expected '$PROJECT_REF', got '$confirm')"
      exit 0
    fi
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Upsert config
# ---------------------------------------------------------------------------

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

echo ""
echo "[combat-tick-config] Done."
