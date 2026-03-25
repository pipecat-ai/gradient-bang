#!/usr/bin/env bash
#
# Integration test runner for Gradient Bang Python tests.
#
# Creates an isolated Supabase instance (separate project_id + ports),
# launches the unified server.ts (same pattern as Deno tests),
# exports credentials, runs pytest -m integration, and tears everything down.
#
# Usage:
#   bash scripts/run-integration-tests.sh
#   bash scripts/run-integration-tests.sh -v -k "test_movement"
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENT_DIR="$REPO_ROOT/deployment"
FUNCTIONS_DIR="$DEPLOYMENT_DIR/supabase/functions"

# ── Ensure npx is available ─────────────────────────────────────────────
if ! command -v npx &>/dev/null; then
  echo "ERROR: npx not found. Install Node.js or add it to your PATH."
  exit 1
fi

PROJECT_ID="gb-pytest"

# Ports for the isolated test instance (offset from dev 543xx and Deno test 543xx)
TEST_API_PORT=54421
TEST_DB_PORT=54422
TEST_STUDIO_PORT=54423
TEST_INBUCKET_PORT=54424
TEST_ANALYTICS_PORT=54427
TEST_DB_SHADOW_PORT=54420
TEST_POOLER_PORT=54429
TEST_INSPECTOR_PORT=8084

# Edge function server port (matches Deno test pattern)
SERVER_PORT=54491

# Temp workdir for isolated Supabase instance
TEST_WORKDIR=""
SERVER_PID=""

# ── Cleanup ──────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "==> Cleaning up..."

  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "    Stopping edge function server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [ -n "$TEST_WORKDIR" ] && [ -d "$TEST_WORKDIR" ]; then
    echo "    Stopping Supabase (project: $PROJECT_ID)..."
    npx supabase stop --workdir "$TEST_WORKDIR" --no-backup 2>/dev/null || true
    echo "    Removing temp workdir: $TEST_WORKDIR"
    rm -rf "$TEST_WORKDIR"
  fi

  echo "    Done."
}
trap cleanup EXIT

# ── 1. Create isolated Supabase workdir ──────────────────────────────────
echo "==> Creating isolated Supabase workdir..."
TEST_WORKDIR=$(mktemp -d /tmp/gb-pytest-supabase.XXXXXX)
mkdir -p "$TEST_WORKDIR/supabase"

# Symlink migrations and functions so they get applied
ln -s "$DEPLOYMENT_DIR/supabase/migrations" "$TEST_WORKDIR/supabase/migrations"
ln -s "$DEPLOYMENT_DIR/supabase/functions" "$TEST_WORKDIR/supabase/functions"

# Create config.toml with different project_id and ports
sed \
  -e "s/project_id = \"gb-world-server\"/project_id = \"$PROJECT_ID\"/" \
  -e "s/^port = 54321$/port = $TEST_API_PORT/" \
  -e "s/^port = 54322$/port = $TEST_DB_PORT/" \
  -e "s/^shadow_port = 54320$/shadow_port = $TEST_DB_SHADOW_PORT/" \
  -e "s/^port = 54323$/port = $TEST_STUDIO_PORT/" \
  -e "s/^port = 54324$/port = $TEST_INBUCKET_PORT/" \
  -e "s/^port = 54327$/port = $TEST_ANALYTICS_PORT/" \
  -e "s/^port = 54329$/port = $TEST_POOLER_PORT/" \
  -e "s/^inspector_port = 8083$/inspector_port = $TEST_INSPECTOR_PORT/" \
  "$DEPLOYMENT_DIR/supabase/config.toml" > "$TEST_WORKDIR/supabase/config.toml"

echo "    Workdir: $TEST_WORKDIR"
echo "    Ports: API=$TEST_API_PORT DB=$TEST_DB_PORT Server=$SERVER_PORT"

# ── 2. Start isolated Supabase ───────────────────────────────────────────
echo ""
echo "==> Starting isolated Supabase instance (project: $PROJECT_ID)..."
npx supabase start --workdir "$TEST_WORKDIR" 2>&1

# Give PostgREST a moment to load its schema cache after migrations
sleep 2

echo ""
echo "==> Extracting credentials..."
# Use --output env for reliable machine-parseable output
STATUS_OUTPUT=$(npx supabase status --workdir "$TEST_WORKDIR" --output env 2>&1)

# Parse KEY="VALUE" lines from env output, stripping quotes
parse_env() {
  local key="$1"
  echo "$STATUS_OUTPUT" | grep "^${key}=" | sed "s/^${key}=//" | tr -d '"'
}

SUPABASE_URL=$(parse_env "API_URL")
SUPABASE_ANON_KEY=$(parse_env "ANON_KEY")
SUPABASE_SERVICE_ROLE_KEY=$(parse_env "SERVICE_ROLE_KEY")
DB_URL=$(parse_env "DB_URL")

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ] || [ -z "$DB_URL" ]; then
  echo "ERROR: Could not extract credentials from supabase status."
  echo "Status output:"
  echo "$STATUS_OUTPUT"
  exit 1
fi

echo "    SUPABASE_URL=$SUPABASE_URL"
echo "    DB_URL=$DB_URL"
echo "    (keys extracted successfully)"

# ── 2b. Reload PostgREST schema cache ────────────────────────────────────
echo ""
echo "==> Reloading PostgREST schema cache..."
psql "$DB_URL" -c "NOTIFY pgrst, 'reload schema'" 2>/dev/null || true
sleep 2

# Verify PostgREST can see the schema by probing a known table
for i in $(seq 1 10); do
  PROBE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    "$SUPABASE_URL/rest/v1/events?select=id&limit=1" 2>/dev/null || echo "000")
  if [ "$PROBE" = "200" ]; then
    echo "    PostgREST schema cache loaded (probe $i)"
    break
  fi
  if [ "$i" = "10" ]; then
    echo "    WARNING: PostgREST schema cache may not be ready (last probe: $PROBE)"
  fi
  sleep 1
done

# ── 2c. Start edge function server (same pattern as Deno tests) ──────────
echo ""
echo "==> Starting edge function server (server.ts on port $SERVER_PORT)..."
SERVER_LOG="$TEST_WORKDIR/server.log"
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
POSTGRES_POOLER_URL="$DB_URL" \
POSTGRES_URL="$DB_URL" \
MOVE_DELAY_SCALE=0 \
LOCAL_API_PORT="$SERVER_PORT" \
  deno run --allow-all "$FUNCTIONS_DIR/server.ts" \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for the server to be ready
EDGE_BASE="http://localhost:$SERVER_PORT"
for i in $(seq 1 60); do
  PROBE=$(curl -s -o /dev/null -w "%{http_code}" "$EDGE_BASE/health" 2>/dev/null || echo "000")
  if [ "$PROBE" = "200" ]; then
    echo "    Edge function server ready (probe $i)"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "    ERROR: Edge function server failed to start"
    echo "    Last 20 lines of server log:"
    tail -20 "$SERVER_LOG" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

# ── 3. Export environment ─────────────────────────────────────────────────
export SUPABASE_URL
export SUPABASE_ANON_KEY
export SUPABASE_SERVICE_ROLE_KEY
export POSTGRES_POOLER_URL="$DB_URL"
export POSTGRES_URL="$DB_URL"
export SUPABASE_ALLOW_LEGACY_IDS=1
export MOVE_DELAY_SCALE=0
# Point tests at the edge function server (not Supabase API gateway)
export EDGE_FUNCTIONS_URL="$EDGE_BASE"
# No EDGE_API_TOKEN — auth bypassed in local dev mode

# ── 4. Run pytest ─────────────────────────────────────────────────────────
echo ""
echo "==> Running Python integration tests..."
echo ""

set +e
uv run pytest -m integration "$@"
TEST_EXIT=$?
set -e

# Show server log on failure
if [ "$TEST_EXIT" -ne 0 ] && [ -f "$SERVER_LOG" ]; then
  echo ""
  echo "==> Edge function server log (last 50 lines):"
  tail -50 "$SERVER_LOG" 2>/dev/null || true
fi

echo ""
if [ "$TEST_EXIT" -eq 0 ]; then
  echo "==> All tests passed."
else
  echo "==> Tests failed (exit code: $TEST_EXIT)."
fi

exit $TEST_EXIT
