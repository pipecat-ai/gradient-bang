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
PROJECT_ROOT="$(cd "$DEPLOYMENT_DIR/.." && pwd)"

# ── Ensure npx is available (nix-shell may be needed) ───────────────────
if ! command -v npx &>/dev/null; then
  if [ -f "$PROJECT_ROOT/shell.nix" ]; then
    echo "==> npx not found, re-launching inside nix-shell..."
    exec nix-shell "$PROJECT_ROOT/shell.nix" --run "bash $0 $*"
  else
    echo "ERROR: npx not found and no shell.nix available."
    exit 1
  fi
fi

PROJECT_ID="gb-test-runner"
SERVER_PORT=54390
COVERAGE_DIR="/tmp/gb-test-coverage"

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

  if [ -n "$TEST_WORKDIR" ] && [ -d "$TEST_WORKDIR" ]; then
    echo "    Stopping Supabase (project: $PROJECT_ID)..."
    npx supabase stop --workdir "$TEST_WORKDIR" --no-backup 2>/dev/null || true
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

# ── 2b. Reload PostgREST schema cache ────────────────────────────────
# After migrations, PostgREST may not have reloaded its schema cache.
# Send a NOTIFY on the pgrst channel to trigger a reload, then wait.
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
# No EDGE_API_TOKEN — auth bypassed in local dev mode (gated behind
# ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1 since the per-character auth migration).
# Production never sets either env var.
export ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1

# ── 4. Run tests (server starts in-process for coverage) ──────────────
# server.ts is imported inside the test process so that deno test --coverage
# can measure coverage of all edge function code.
#
# record_event_with_recipients writes the events table and, for active online
# sessions, SQL-owned session-queue pubsub delivery. The default run exercises
# pubsub; pass `TRANSPORT=polling` to run the polling pass instead.
echo ""
echo "==> Running integration tests (with coverage)..."
echo ""

rm -rf "$COVERAGE_DIR"

# Optional file/dir args after "--" let callers run a targeted subset
# (e.g. `bash run_tests.sh -- combat_test.ts combat_destruction_test.ts`).
TEST_TARGETS=("$SCRIPT_DIR/")
if [ "$#" -gt 0 ]; then
  TEST_TARGETS=()
  for t in "$@"; do
    if [[ "$t" = /* ]]; then
      TEST_TARGETS+=("$t")
    else
      TEST_TARGETS+=("$SCRIPT_DIR/$t")
    fi
  done
fi

if [ -n "${TRANSPORT:-}" ]; then
  TRANSPORTS=("$TRANSPORT")
else
  TRANSPORTS=("pubsub")
fi

OVERALL_EXIT=0
# bash 3.2 compat (stock macOS): no `declare -A`. Logs live at a
# deterministic path, so look them up by reconstruction below.
FAILED_TRANSPORTS=()

LOG_DIR=$(mktemp -d /tmp/gb-test-logs.XXXXXX)

for transport in "${TRANSPORTS[@]}"; do
  case "$transport" in
    polling|pubsub) ;;
    *)
      echo "ERROR: unknown TRANSPORT='$transport' (expected polling|pubsub)"
      exit 2
      ;;
  esac

  echo ""
  echo "==> Pass: transport=$transport"
  echo ""

  LOG_FILE="$LOG_DIR/$transport.log"

  set +e
  deno test \
    --config "$FUNCTIONS_DIR/deno.json" \
    --allow-all \
    --coverage="$COVERAGE_DIR/$transport" \
    "${TEST_TARGETS[@]}" \
    2>&1 | tee "$LOG_FILE"
  PASS_EXIT=${PIPESTATUS[0]}
  set -e

  if [ "$PASS_EXIT" -eq 0 ]; then
    echo ""
    echo "==> Pass $transport: PASSED"
  else
    echo ""
    echo "==> Pass $transport: FAILED (exit $PASS_EXIT)"
    FAILED_TRANSPORTS+=("$transport")
    OVERALL_EXIT=$PASS_EXIT
  fi
done

TEST_EXIT=$OVERALL_EXIT

echo ""
if [ "$TEST_EXIT" -eq 0 ]; then
  echo "==> All passes succeeded (${#TRANSPORTS[@]}/${#TRANSPORTS[@]})."
else
  echo "==> Failed transports: ${FAILED_TRANSPORTS[*]}"
  echo ""
  echo "==> Failed tests:"
  for transport in "${FAILED_TRANSPORTS[@]}"; do
    log="$LOG_DIR/$transport.log"
    [ -f "$log" ] || continue
    # Deno emits a "FAILURES" block before the summary line, with one line
    # per failed test of the form "name => path:line:col".
    failures=$(awk '
      /FAILURES/      { flag=1; next }
      /^FAILED \|/    { flag=0 }
      flag && / => / { print }
    ' "$log")
    echo ""
    echo "  [$transport]"
    if [ -n "$failures" ]; then
      echo "$failures" | sed 's/^/    /'
    else
      echo "    (no FAILURES block parsed; see $log)"
    fi
  done
  echo ""
  echo "==> Full logs: $LOG_DIR"
fi

# ── 5. Coverage report ────────────────────────────────────────────────
# deno test --coverage writes V8 coverage profiles on exit. We point
# `deno coverage` at the parent dir so it unions the per-transport profiles
# into a single report (filtered to the edge function code).
if [ -d "$COVERAGE_DIR" ]; then
  echo ""
  echo "==> Code coverage report (edge functions, all transports)"
  echo ""
  deno coverage "$COVERAGE_DIR" \
    --include="^file://.*/deployment/supabase/functions/" \
    --exclude="(tests/|server\.ts)" \
    2>&1 || true
fi

exit $TEST_EXIT
