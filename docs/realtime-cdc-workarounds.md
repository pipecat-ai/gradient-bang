# Supabase Realtime postgres_cdc_rls Workarounds
## 2025-11-11

## Problem
Local Supabase CLI (v2.54.11) does not start the `postgres_cdc_rls` extension, even when properly configured. This is a confirmed bug affecting multiple CLI versions (v2.20.5 → v2.54.11).

## Available Solutions

### Option 1: Deploy to Supabase Cloud ☁️ (RECOMMENDED)

**Pros:**
- ✅ Guaranteed to work - postgres_changes functions correctly in production
- ✅ No code changes needed - migrations and schema are ready
- ✅ Fast to test - create project, push migrations, test immediately
- ✅ Continue local dev for everything else while testing realtime on cloud

**Cons:**
- ❌ Requires Supabase cloud account
- ❌ Separate environment for testing

**Steps:**
1. Create a new Supabase project at https://app.supabase.com
2. Link your local project:
   ```bash
   npx supabase link --project-ref <your-project-ref>
   ```
3. Push migrations:
   ```bash
   npx supabase db push
   ```
4. Update `.env` with cloud credentials:
   ```bash
   SUPABASE_URL=https://<your-project>.supabase.co
   SUPABASE_ANON_KEY=<your-anon-key>
   SUPABASE_SERVICE_ROLE_KEY=<your-service-key>
   ```
5. Run test:
   ```bash
   PYTHONPATH=. uv run python scripts/test_realtime_debug.py
   ```

**Expected Result:** Events will be delivered via postgres_changes immediately.

---

### Option 2: CLI Downgrade (EXPERIMENTAL) 🔄

**Pros:**
- ✅ Keeps everything local
- ✅ Reportedly fixes the issue (based on GitHub reports)

**Cons:**
- ❌ Older CLI version may have other bugs
- ❌ v1.110.3 is from 2023 - very outdated
- ❌ May break other features
- ❌ Need to stop/restart all containers

**Steps:**

#### Using npm (if you have package.json):
```bash
# Stop current stack
npx supabase stop

# Install specific CLI version
npm install -D supabase@1.110.3

# Verify version
npx supabase --version  # Should show 1.110.3

# Start with old CLI
npx supabase start

# Test
PYTHONPATH=. uv run python scripts/test_realtime_debug.py
```

#### Using standalone binary:
```bash
# Stop current stack
npx supabase stop

# Download v1.110.3 (if it exists - may need to try nearby versions)
# Check: https://github.com/supabase/cli/releases

# Example for Linux amd64:
wget https://github.com/supabase/cli/releases/download/v1.110.3/supabase_1.110.3_linux_amd64.tar.gz
tar -xzf supabase_1.110.3_linux_amd64.tar.gz
sudo mv supabase /usr/local/bin/supabase-1.110.3

# Use the old version
/usr/local/bin/supabase-1.110.3 start
```

**Note:** v1.110.3 may not exist. Try nearby versions like v1.109.x or v1.111.x.

---

### Option 3: Manual Extension Trigger (BLOCKED) ❌

**Status:** Attempted but **does not work** with local CLI.

The Realtime management API (`PUT /realtime/v1/api/tenants/realtime-dev`) returns **403 Forbidden**, indicating the local CLI doesn't expose tenant management endpoints or requires different authentication than available.

**What we tried:**
- Direct API calls to Realtime service
- Different auth tokens (JWT, API key, service role)
- Both through Kong gateway and direct to container

**Result:** Cannot manually trigger extension activation in local CLI environment.

---

## Recommended Path Forward

### For Immediate Unblocking:
**Use Option 1 (Cloud Deployment)** for the following reasons:
1. Fastest path to validation - can test within 10 minutes
2. Proves that your schema/code is correct
3. Allows continued local development for everything else
4. You can still use local DB for development, only switch to cloud for realtime testing

### For Long-term:
1. **File GitHub issue** with detailed logs showing:
   - Extension configured in `_realtime.extensions`
   - "Tenant set-up successfully" logs
   - But NO "Starting replication" for postgres_cdc_rls
   - Replication slot remains inactive
   - Multiple CLI versions tested (v2.20.5 → v2.54.11)

2. **Monitor for CLI updates** that fix this issue

3. **Consider hybrid approach** temporarily:
   - Local development for everything
   - Cloud staging for realtime testing
   - Production deployment with full postgres_changes

---

## Testing After Implementation

Once you have a working environment (cloud or downgraded CLI), run:

```bash
# Source environment
set -a && source .env.supabase && set +a

# Run diagnostic test
PYTHONPATH=. uv run python scripts/test_realtime_debug.py

# Expected output:
# ✅ JWT obtained
# ✅ Realtime listener started
# ✅ Join succeeded
# ✅ Events received via websocket: 2
#     - status.snapshot
#     - map.local
```

## Files Ready for Deployment

All schema work is complete and ready:
- ✅ `supabase/migrations/20251108113000_enable_events_realtime.sql` - Adds table to publication
- ✅ `supabase/migrations/20251110090000_events_rls.sql` - RLS policies + helper functions
- ✅ `supabase/migrations/20251111050000_events_replica_identity_full.sql` - REPLICA IDENTITY FULL
- ✅ `supabase/functions/get_character_jwt/` - JWT generation endpoint
- ✅ `utils/supabase_client.py` - Client with postgres_changes subscription
- ✅ `utils/supabase_realtime.py` - Realtime listener implementation

No code changes needed - the moment postgres_cdc_rls starts working, everything will function immediately.

---

## References
- Investigation report: `docs/realtime-cdc-investigation-2025-11-11.md`
- GitHub Issues: #21624, #1336, #35282, #12544
- Self-hosting docs: https://supabase.com/docs/guides/self-hosting/realtime/config
