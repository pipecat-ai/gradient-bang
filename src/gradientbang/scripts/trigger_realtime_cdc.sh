#!/bin/bash
# Script to manually trigger postgres_cdc_rls extension activation

set -e

source .env.supabase

REALTIME_URL="http://127.0.0.1:54321/realtime/v1"
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"

echo "🔧 Attempting to trigger postgres_cdc_rls extension via Realtime API..."
echo "   Realtime URL: $REALTIME_URL"

# Try to update/reconfigure the tenant to force extension activation
curl -v -X PUT \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $JWT_SECRET" \
  -d '{
    "tenant": {
      "name": "realtime-dev",
      "external_id": "realtime-dev",
      "jwt_secret": "'"$JWT_SECRET"'",
      "extensions": [
        {
          "type": "postgres_cdc_rls",
          "settings": {
            "db_name": "postgres",
            "db_host": "supabase_db_gb-supa",
            "db_user": "supabase_admin",
            "db_password": "postgres",
            "db_port": "5432",
            "region": "us-east-1",
            "poll_interval_ms": 100,
            "poll_max_record_bytes": 1048576,
            "publication": "supabase_realtime",
            "slot_name": "supabase_realtime_replication_slot",
            "ssl_enforced": false
          }
        }
      ]
    }
  }' \
  "$REALTIME_URL/api/tenants/realtime-dev" 2>&1

echo ""
echo "✅ Request sent. Check docker logs for activation:"
echo "   docker logs supabase_realtime_gb-supa 2>&1 | tail -50"
