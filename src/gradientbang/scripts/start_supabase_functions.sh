#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.supabase"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/cli-functions.log"
PID_FILE="$LOG_DIR/cli-functions.pid"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Aborting." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

(
  cd "$ROOT_DIR"
  set -a
  source "$ENV_FILE"
  set +a
  nohup npx supabase functions serve --env-file "$ENV_FILE" --no-verify-jwt \
    >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
) &>/dev/null

sleep 1
if [[ -s "$PID_FILE" ]]; then
  echo "Supabase functions serve started (PID $(cat "$PID_FILE"))"
  echo "Logs: $LOG_FILE"
else
  echo "Failed to start supabase functions serve. Check $LOG_FILE for details." >&2
  exit 1
fi
