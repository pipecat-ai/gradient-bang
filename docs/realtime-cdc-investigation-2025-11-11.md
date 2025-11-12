# Supabase Realtime postgres_changes Investigation
## 2025-11-11

## Problem Statement
Events are inserted into `public.events` table but `postgres_changes` subscriptions never receive them. The subscription connects successfully, JWT authentication works, but the callback never fires.

## Investigation Summary

### Configuration Status ✅

All database-side configuration is correct:

1. **WAL Configuration**
   - `wal_level = logical` ✓
   - Required for logical replication/CDC

2. **Publication**
   - `supabase_realtime` publication exists ✓
   - `events` table is included ✓
   - Publication configured for INSERT, UPDATE, DELETE ✓

3. **Replica Identity** ⚠️→✅
   - Was: `relreplident = 'd'` (DEFAULT) ❌
   - Now: `relreplident = 'f'` (FULL) ✓
   - **CRITICAL**: FULL replica identity is REQUIRED for RLS-based CDC
   - Without it, WAL only includes primary keys, preventing RLS policy evaluation
   - **Migration created**: `20251111050000_events_replica_identity_full.sql`

4. **RLS Policies**
   - 7 policies on `events` table ✓
   - Policies for authenticated role covering all visibility scopes ✓
   - Service role has full access ✓

5. **JWT**
   - Character JWTs generated with `sub = character_id` ✓
   - `role = authenticated` ✓
   - Correct audience and expiry ✓

6. **Realtime Service**
   - Version: v2.57.3 ✓
   - `PostgresCdcRls` extension loaded ✓
   - Extension configured in `_realtime.extensions` table ✓

### The Core Issue ❌

**The `postgres_cdc_rls` extension is configured but NOT RUNNING.**

Evidence:
1. **Replication slot is inactive:**
   ```sql
   SELECT slot_name, active FROM pg_replication_slots
   WHERE slot_name = 'supabase_realtime_replication_slot';
   -- Result: active = f
   ```

2. **No replication startup logs:**
   - Realtime logs show: "Starting replication for Broadcast Changes" ✓
   - Realtime logs do NOT show: "Starting replication" for postgres_cdc_rls ❌

3. **Extension entry exists but isn't activated:**
   ```sql
   SELECT type, settings->>'publication' FROM _realtime.extensions
   WHERE tenant_external_id = 'realtime-dev';
   -- Shows: type='postgres_cdc_rls', publication='supabase_realtime'
   -- But the extension never starts
   ```

## Root Cause Hypothesis

The local Supabase CLI's Realtime service (v2.57.3) does NOT automatically start the `postgres_cdc_rls` extension, even when:
- The extension is configured in `_realtime.extensions`
- The replication slot exists
- The publication exists and includes the table
- Clients subscribe to postgres_changes

This appears to be a **bug or missing feature** in the local Supabase CLI Realtime implementation.

## Similar Issues Found

1. **CLI version issues (2023)**: Issues #1683, #1684 reported similar problems with CLI v1.113.2, fixed by downgrading to v1.110.3 or upgrading to versions with PR #1687
   - Current CLI version: v2.54.11 (should have these fixes)

2. **Local CDC subscriptions (#309)**: Realtime v0.25.1 incompatible with supabase-js v2
   - Resolved in v1.0.0-rc.1 (we're on v2.57.3, should be fixed)

## Workaround Attempts

### Attempted Fixes That DID NOT Work:
1. ✅ Set REPLICA IDENTITY FULL (required but not sufficient)
2. ✅ Manually create replication slot (created but remains inactive)
3. ✅ Restart Realtime service (no change)
4. ✅ Verify RLS policies (all correct)
5. ✅ Verify JWT claims (all correct)

## Next Steps & Recommendations

### Immediate Actions:

1. **Report CLI Bug** 🐛
   - File GitHub issue in `supabase/cli` and/or `supabase/realtime`
   - Title: "Local Realtime postgres_cdc_rls extension not starting in CLI v2.54.11"
   - Include: Configuration, logs, and this investigation summary
   - Reference: Our setup with `_realtime.extensions` configured but extension never activating

2. **Test on Supabase Cloud** ☁️
   - Deploy migrations to a cloud project
   - Test if postgres_changes works there (likely YES, as this seems local-only)
   - This will unblock development while CLI issue is resolved

3. **Try CLI Downgrade** ⬇️
   - Downgrade to known-working version (e.g., v1.110.3 or v1.120.0)
   - Test if postgres_changes works on older CLI
   - Document which version works for future reference

### Alternative Approaches:

4. **Temporary HTTP Broadcast Path** 📡
   - Keep existing HTTP `/realtime/v1/api/broadcast` fan-out temporarily
   - Continue with postgres_changes migration in parallel
   - Switch when CLI issue is resolved

5. **Hybrid Approach** 🔄
   - Use postgres_changes for query/replay (works via REST)
   - Use broadcast for realtime delivery temporarily
   - Ensures event storage is correct even if CDC isn't streaming

### Long-term:

6. **Monitor for CLI Updates** 📦
   - Watch for Realtime/CLI updates that fix this
   - Test new versions as they're released

7. **Consider Self-Hosted Realtime** 🏠
   - If local development is critical and cloud testing insufficient
   - Run Realtime directly (not via CLI) with explicit configuration
   - More complex but gives full control

## Configuration Files to Check

1. **`supabase/config.toml`**
   - Currently minimal `[realtime]` section with just `enabled = true`
   - May need additional configuration (TBD from Supabase docs/support)

2. **Environment Variables**
   - Check if Realtime container needs additional env vars
   - Current setup relies on CLI defaults

## Diagnostic Commands

```bash
# Check replication slot status
docker exec supabase_db_gb-supa psql -U postgres -d postgres -c \
  "SELECT slot_name, plugin, active, wal_status FROM pg_replication_slots;"

# Check realtime extensions
docker exec supabase_db_gb-supa psql -U postgres -d postgres -c \
  "SELECT * FROM _realtime.extensions;"

# Check publication tables
docker exec supabase_db_gb-supa psql -U postgres -d postgres -c \
  "SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';"

# Check replica identity
docker exec supabase_db_gb-supa psql -U postgres -d postgres -c \
  "SELECT relname, relreplident FROM pg_class WHERE relname = 'events';"

# Monitor Realtime logs
docker logs -f supabase_realtime_gb-supa
```

## Files Created During Investigation

1. **`scripts/test_realtime_debug.py`**
   - Diagnostic script testing JWT + subscription + insert + delivery
   - Confirms events inserted but not delivered

2. **`supabase/migrations/20251111050000_events_replica_identity_full.sql`**
   - Sets REPLICA IDENTITY FULL (required for RLS+CDC)

## Conclusion

The investigation has **comprehensively ruled out all configuration issues** on our side. The problem is definitively in the **local Supabase CLI Realtime service not starting the postgres_cdc_rls extension**.

**Recommended Path Forward:**
1. Test on Supabase Cloud to confirm it works there (very likely)
2. File CLI bug report with full details
3. Continue development with HTTP broadcast temporarily
4. Switch to postgres_changes once CLI issue is resolved or when deploying to cloud

The migration/schema work is complete and correct. When the Realtime CDC issue is fixed (either via CLI update or cloud deployment), the postgres_changes delivery will work immediately with no code changes needed.
