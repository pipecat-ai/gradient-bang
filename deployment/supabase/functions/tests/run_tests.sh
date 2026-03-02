#!/usr/bin/env bash
#
# Integration test runner for Gradient Bang edge functions.
#
# Creates an isolated Supabase instance (separate project_id + ports),
# launches the unified server.ts, runs Deno integration tests, and
# tears everything down.
#
# Usage:
#   bash deployment/supabase/functions/tests/run_tests.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTIONS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENT_DIR="$(cd "$FUNCTIONS_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$DEPLOYMENT_DIR/.." && pwd)"

# ── Ensure npx is available (nix-shell may be needed) ───────────────────
if ! command -v npx &>/dev/null; then
  if [ -f "$REPO_ROOT/shell.nix" ]; then
    echo "==> npx not found, re-launching inside nix-shell..."
    exec nix-shell "$REPO_ROOT/shell.nix" --run "bash $0 $*"
  else
    echo "ERROR: npx not found and no shell.nix available."
    exit 1
  fi
fi

PROJECT_ID="gb-test-runner"
SERVER_PORT=54390
SERVER_LOG="/tmp/gb-test-server.log"
SERVER_PID=""

# Ports for the isolated test instance (offset from dev ports to avoid conflicts)
TEST_API_PORT=54331
TEST_DB_PORT=54332
TEST_STUDIO_PORT=54333
TEST_INBUCKET_PORT=54334
TEST_ANALYTICS_PORT=54337
TEST_DB_SHADOW_PORT=54330
TEST_POOLER_PORT=54339

# Temp workdir for isolated Supabase instance
TEST_WORKDIR=""

# ── Cleanup ─────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "==> Cleaning up..."

  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null && echo "    Stopped server.ts (PID $SERVER_PID)" || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [ -n "$TEST_WORKDIR" ] && [ -d "$TEST_WORKDIR" ]; then
    echo "    Stopping Supabase (project: $PROJECT_ID)..."
    npx supabase stop --workdir "$TEST_WORKDIR" 2>/dev/null || true
    echo "    Removing temp workdir: $TEST_WORKDIR"
    rm -rf "$TEST_WORKDIR"
  fi

  echo "    Done."
}
trap cleanup EXIT

# ── 1. Create isolated Supabase workdir ─────────────────────────────────
echo "==> Creating isolated Supabase workdir..."
TEST_WORKDIR=$(mktemp -d /tmp/gb-test-supabase.XXXXXX)
mkdir -p "$TEST_WORKDIR/supabase"

# Symlink migrations so they get applied
ln -s "$DEPLOYMENT_DIR/supabase/migrations" "$TEST_WORKDIR/supabase/migrations"

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
  "$DEPLOYMENT_DIR/supabase/config.toml" > "$TEST_WORKDIR/supabase/config.toml"

echo "    Workdir: $TEST_WORKDIR"
echo "    Ports: API=$TEST_API_PORT DB=$TEST_DB_PORT"

# ── 2. Start isolated Supabase ──────────────────────────────────────────
echo ""
echo "==> Starting isolated Supabase instance (project: $PROJECT_ID)..."
npx supabase start --workdir "$TEST_WORKDIR" 2>&1

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

# ── 3. Export environment ───────────────────────────────────────────────
export SUPABASE_URL
export SUPABASE_ANON_KEY
export SUPABASE_SERVICE_ROLE_KEY
export POSTGRES_POOLER_URL="$DB_URL"
export POSTGRES_URL="$DB_URL"
export LOCAL_API_PORT="$SERVER_PORT"
export TEST_BASE_URL="http://localhost:$SERVER_PORT"
export SUPABASE_ALLOW_LEGACY_IDS=1
export MOVE_DELAY_SCALE=0
# No EDGE_API_TOKEN — auth bypassed in local dev mode

# ── 4. Start server.ts ─────────────────────────────────────────────────
echo ""
echo "==> Starting server.ts on port $SERVER_PORT..."
deno run -A "$FUNCTIONS_DIR/server.ts" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

echo "    PID: $SERVER_PID"
echo "    Log: $SERVER_LOG"

# Wait for server health
echo "==> Waiting for server health..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$SERVER_PORT/health" > /dev/null 2>&1; then
    echo "    Server is healthy."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: Server failed to start within 60 seconds."
    echo "--- server.ts log (last 50 lines) ---"
    tail -50 "$SERVER_LOG"
    exit 1
  fi
  sleep 1
done

# ── 5. Run tests ────────────────────────────────────────────────────────
echo ""
echo "==> Running integration tests..."
echo ""

set +e
deno test \
  --config "$FUNCTIONS_DIR/deno.json" \
  --allow-net --allow-env --allow-read \
  "$SCRIPT_DIR/" \
  2>&1
TEST_EXIT=$?
set -e

echo ""
if [ "$TEST_EXIT" -eq 0 ]; then
  echo "==> All tests passed."
else
  echo "==> Tests failed (exit code: $TEST_EXIT)."
  echo ""
  echo "--- server.ts log (last 30 lines) ---"
  tail -30 "$SERVER_LOG"
fi

exit $TEST_EXIT
