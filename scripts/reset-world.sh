#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Reset World Data
#
# Truncates all game data tables (preserving auth.users, app_runtime_config,
# and static config),
# generates a fresh universe, and loads it into Supabase.
#
# Usage:
#   scripts/reset-world.sh                        # local, 5000 sectors, random seed
#   scripts/reset-world.sh 1000                   # local, custom sector count
#   scripts/reset-world.sh 1000 42                # local, custom sector count + seed
#   scripts/reset-world.sh --env .env.cloud       # cloud, 5000 sectors
#   scripts/reset-world.sh --env .env.cloud 1000  # cloud, custom sector count
# =============================================================================

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

ENV_FILE=".env.supabase"
SECTOR_COUNT="5000"
SEED=""
ALLOW_PRODUCTION=false

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
    *)
      # First positional arg is sector count, second is seed
      if [[ "$SECTOR_COUNT" == "5000" && "$1" =~ ^[0-9]+$ ]]; then
        SECTOR_COUNT="$1"
      elif [[ -n "$1" && "$1" =~ ^[0-9]+$ ]]; then
        SEED="$1"
      else
        echo "[reset-world] Unknown argument: $1" >&2
        echo "Usage: scripts/reset-world.sh [--env FILE] [sector_count] [seed]" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

WORKDIR="${WORKDIR:-deployment}"
DB_CONTAINER="supabase_db_gb-world-server"

# ---------------------------------------------------------------------------
# Detect local vs cloud mode
# ---------------------------------------------------------------------------

# Cloud mode: env file has a POSTGRES_POOLER_URL pointing to a remote host
# Local mode: uses docker exec to talk to the local Supabase container
IS_CLOUD=false

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[reset-world] Missing $ENV_FILE." >&2
  exit 1
fi

# Load environment variables
set -a
source "$ENV_FILE"
set +a

# Detect cloud by checking if POSTGRES_POOLER_URL points to a remote host
if [[ "${POSTGRES_POOLER_URL:-}" == *"supabase.co"* || "${POSTGRES_POOLER_URL:-}" == *"supabase.com"* ]]; then
  IS_CLOUD=true
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
  echo "  URL      : ${SUPABASE_URL:-<not set>}" >&2
  echo "" >&2
  echo "  To run against production, pass --allow-production:" >&2
  echo "" >&2
  echo "    scripts/reset-world.sh --env $ENV_FILE --allow-production" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo "" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# SQL helper: run a SQL command against the database
# ---------------------------------------------------------------------------

run_sql() {
  local sql="$1"
  if [[ "$IS_CLOUD" == true ]]; then
    psql "${POSTGRES_POOLER_URL}" -v ON_ERROR_STOP=1 -c "$sql"
  else
    docker exec -e PGPASSWORD=postgres "$DB_CONTAINER" \
      psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c "$sql"
  fi
}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

if [[ "$IS_CLOUD" == true ]]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "[reset-world] psql is required for cloud mode but not found in PATH." >&2
    exit 1
  fi
  echo "[reset-world] Cloud mode detected (env: $ENV_FILE)"
else
  if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    echo "[reset-world] Docker container '$DB_CONTAINER' is not running." >&2
    echo "              Start Supabase first: npx supabase start --workdir $WORKDIR" >&2
    exit 1
  fi
  echo "[reset-world] Local mode detected (container: $DB_CONTAINER)"
fi

echo ""
echo "============================================================"
echo "[reset-world] World Reset"
echo "============================================================"
echo "  Mode         : $(if [[ "$IS_CLOUD" == true ]]; then echo "CLOUD"; else echo "local"; fi)"
echo "  Env file     : $ENV_FILE"
echo "  Supabase URL : ${SUPABASE_URL:-<not set>}"
echo "  Sector count : $SECTOR_COUNT"
echo "  Seed         : ${SEED:-<random>}"
echo "============================================================"
echo ""

# Safety prompt — always confirm before wiping data
if [[ "$IS_CLOUD" == true ]]; then
  # Extract project ref from URL for easy visual confirmation
  PROJECT_REF=$(echo "${SUPABASE_URL:-}" | sed -n 's|https://\([^.]*\)\.supabase\.co.*|\1|p')

  if [[ "$IS_PRODUCTION" == true ]]; then
    echo ""
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "  WARNING: YOU ARE ABOUT TO WIPE PRODUCTION"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo ""
    echo "    Project ref : ${PROJECT_REF:-<unknown>}"
    echo "    URL         : ${SUPABASE_URL:-<not set>}"
    echo "    Env file    : $ENV_FILE"
    echo ""
    echo "  This will PERMANENTLY DELETE all game data including:"
    echo "    - All player ships, inventories, and progress"
    echo "    - All sectors, stations, and universe data"
    echo "    - All combat logs and quest progress"
    echo ""
    read -r -p "[reset-world] Type 'DESTROY PRODUCTION' to confirm: " confirm
    if [[ "$confirm" != "DESTROY PRODUCTION" ]]; then
      echo "[reset-world] Aborted. (expected 'DESTROY PRODUCTION')"
      exit 0
    fi
    echo ""
  else
    echo "[reset-world] WARNING: This will wipe all game data on cloud project:"
    echo ""
    echo "    Project ref : ${PROJECT_REF:-<unknown>}"
    echo "    URL         : ${SUPABASE_URL:-<not set>}"
    echo ""
    read -r -p "[reset-world] Type the project ref to confirm: " confirm
    if [[ "$confirm" != "$PROJECT_REF" ]]; then
      echo "[reset-world] Aborted. (expected '$PROJECT_REF', got '$confirm')"
      exit 0
    fi
    echo ""
  fi
else
  read -r -p "[reset-world] This will wipe all local game data. Type 'yes' to continue: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "[reset-world] Aborted."
    exit 0
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Step 1: Truncate all game data tables
# ---------------------------------------------------------------------------

echo "[reset-world] Step 1/4 -- Truncating all public tables (preserving auth + config) ..."

# Dynamically find and truncate all public tables except preserved ones
run_sql "
  DO \$\$
  DECLARE
    tbl TEXT;
    preserved TEXT[] := ARRAY['app_runtime_config', 'ship_definitions'];
  BEGIN
    FOR tbl IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename != ALL(preserved)
      ORDER BY tablename
    LOOP
      EXECUTE format('TRUNCATE TABLE public.%I CASCADE', tbl);
      RAISE NOTICE 'Truncated: %', tbl;
    END LOOP;
  END \$\$;
"

echo "[reset-world] All public tables truncated. auth.users and app_runtime_config preserved."
echo ""

# ---------------------------------------------------------------------------
# Step 2: Generate new universe
# ---------------------------------------------------------------------------

echo "[reset-world] Step 2/4 -- Generating universe ($SECTOR_COUNT sectors) ..."

BANG_ARGS=("$SECTOR_COUNT")
if [[ -n "$SEED" ]]; then
  BANG_ARGS+=("$SEED")
fi
BANG_ARGS+=("--force")

uv run universe-bang "${BANG_ARGS[@]}"

echo "[reset-world] Universe generated."
echo ""

# ---------------------------------------------------------------------------
# Step 3: Load universe into Supabase
# ---------------------------------------------------------------------------

echo "[reset-world] Step 3/4 -- Loading universe into Supabase ..."

uv run -m gradientbang.scripts.load_universe_to_supabase \
  --from-json world-data/ --force

echo "[reset-world] Universe loaded."
echo ""

# ---------------------------------------------------------------------------
# Step 4: Load quest definitions
# ---------------------------------------------------------------------------

echo "[reset-world] Step 4/4 -- Loading quest definitions ..."

uv run -m gradientbang.scripts.load_quests_to_supabase \
  --from-json quest-data/ --force

echo "[reset-world] Quests loaded."
echo ""

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo "============================================================"
echo "[reset-world] Complete!"
echo "============================================================"
echo ""
printf '\033[31m[reset-world] Runtime combat cron config was not modified.\033[0m\n'
printf '\033[31m[reset-world] If combat rounds stop auto-resolving, run:\033[0m\n'
printf '\033[31m  - local: scripts/supabase-reset-with-cron.sh\033[0m\n'
printf '\033[31m  - cloud: scripts/setup-production-combat-tick.sh\033[0m\n'
