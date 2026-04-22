#!/usr/bin/env bash
# Generates TypeScript seed files from the canonical SQL sources.
# Usage: bash scripts/sync-eval-seeds.sh
#
# Source:  tests/eval/webhook_server/seeds/*.sql
# Target:  deployment/supabase/functions/eval_webhook/seeds/*.ts
#
# Each .ts file exports `const sql` containing the full SQL text.
# The SQL files remain the source of truth — edit them, then re-run this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL_DIR="$REPO_ROOT/tests/eval/webhook_server/seeds"
TS_DIR="$REPO_ROOT/deployment/supabase/functions/eval_webhook/seeds"

mkdir -p "$TS_DIR"

count=0
for sql_file in "$SQL_DIR"/*.sql; do
  base="$(basename "$sql_file" .sql)"
  ts_file="$TS_DIR/${base}.ts"

  # Read SQL content and escape backticks + ${} for template literal safety
  sql_content="$(sed 's/`/\\`/g; s/\${/\\${/g' "$sql_file")"

  cat > "$ts_file" <<TSEOF
// Generated from tests/eval/webhook_server/seeds/${base}.sql
// Do not edit directly — run: bash scripts/sync-eval-seeds.sh
export const sql = \`
${sql_content}
\`;
TSEOF

  count=$((count + 1))
  echo "  ${base}.sql -> ${base}.ts"
done

echo "Synced ${count} seed files to ${TS_DIR}"
