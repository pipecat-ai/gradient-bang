#!/usr/bin/env bash
set -euo pipefail
LOG_FILE=${1:-/tmp/supabase-functions.log}
PID_FILE=${2:-/tmp/supabase-functions.pid}
if [[ -f "$PID_FILE" ]]; then
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "supabase functions serve already running (PID $(cat "$PID_FILE"))"
    echo "Logs: $LOG_FILE"
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi
nohup npx supabase functions serve --env-file .env.supabase --no-verify-jwt >"$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"
echo "Started supabase functions serve (PID $PID). Logs: $LOG_FILE"
