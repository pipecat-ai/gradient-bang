# Testing the Combat Tick Worker

Quick reference for testing the pg_cron-based combat tick worker.

## Setup (One-Time)

```bash
# 1. Reset database to apply migration
supabase db reset

# 2. Verify extensions are enabled
supabase db psql -c "SELECT * FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');"

# 3. Check job is scheduled
supabase db psql -c "SELECT * FROM cron.job WHERE jobname = 'combat-tick-worker';"
```

Expected output:
```
 jobid | schedule      | command                      | nodename  | nodeport | database | username
-------+---------------+------------------------------+-----------+----------+----------+----------
     1 | */5 * * * * * | SELECT invoke_combat_tick(); | localhost |     5432 | postgres | postgres
```

## Quick Verification Tests

### 1. Manual Trigger Test

```sql
-- Call the function directly
SELECT invoke_combat_tick();

-- Check HTTP response
SELECT
  id,
  created,
  status_code,
  content::text as response
FROM net._http_response
ORDER BY created DESC
LIMIT 1;
```

Expected `status_code`: `200`
Expected `content`: `{"status":"ok","checked":0,"resolved":0,"timestamp":"..."}`

### 2. Watch Job Execution

```sql
-- View last 10 job runs
SELECT
  runid,
  start_time,
  status,
  return_message
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker')
ORDER BY start_time DESC
LIMIT 10;
```

Should see new entries every 5 seconds.

### 3. Integration Test with Actual Combat

```bash
# Run combat timeout test (depends on worker)
uv run pytest tests/integration/test_combat.py::test_action_timeout_uses_default_action -xvs
```

## Troubleshooting

### Job Not Showing Up

```sql
-- Re-create the job
SELECT cron.schedule(
  'combat-tick-worker',
  '*/5 * * * * *',
  $$SELECT invoke_combat_tick();$$
);
```

### HTTP 404 Errors

Check edge function URL:

```sql
-- View current settings
SELECT name, setting FROM pg_settings WHERE name LIKE 'app.%';

-- Update if wrong
ALTER DATABASE postgres SET app.supabase_url = 'http://host.docker.internal:54321';
```

### HTTP 401 Errors

Check API token:

```sql
-- View current token
SELECT current_setting('app.edge_api_token', true);

-- Update if wrong
ALTER DATABASE postgres SET app.edge_api_token = 'test-token-12345';

-- Must match your .env.supabase EDGE_API_TOKEN
```

### Worker Running But Combat Not Resolving

Check combat_tick endpoint logs:

```bash
# Tail edge function logs
tail -f logs/supabase-functions.log | grep combat_tick
```

Look for:
- `"checked": N` (how many combats were scanned)
- `"resolved": N` (how many rounds were resolved)

## Performance Monitoring

```sql
-- Average execution time over last hour
SELECT
  AVG(EXTRACT(EPOCH FROM (end_time - start_time))) as avg_seconds,
  COUNT(*) as total_runs,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failures
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker')
  AND start_time > NOW() - INTERVAL '1 hour'
GROUP BY jobid;
```

## Cleanup (When Debugging)

```sql
-- Stop the worker
SELECT cron.unschedule('combat-tick-worker');

-- Clear job history
DELETE FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker');

-- Clear HTTP response log
TRUNCATE TABLE net._http_response;

-- Re-enable worker
SELECT cron.schedule(
  'combat-tick-worker',
  '*/5 * * * * *',
  $$SELECT invoke_combat_tick();$$
);
```

## Comparison: Before vs After

### Before (Pytest Fixture)

```python
# tests/conftest.py
@pytest.fixture(scope="session", autouse=True)
async def combat_tick_worker(supabase_environment):
    """Background worker using asyncio + aiohttp."""
    # Complex event loop management
    # Only works during test runs
    # Prone to initialization issues
```

**Problems:**
- ❌ Event loop scope mismatch
- ❌ pytest-asyncio version conflicts
- ❌ Only works during tests
- ❌ Complex async debugging

### After (pg_cron Worker)

```sql
-- supabase/migrations/20251117040000_enable_combat_tick_cron.sql
SELECT cron.schedule(
  'combat-tick-worker',
  '*/5 * * * * *',
  $$SELECT invoke_combat_tick();$$
);
```

**Benefits:**
- ✅ Starts with Supabase stack
- ✅ Works in dev/test/prod
- ✅ No event loop issues
- ✅ Simple SQL debugging
- ✅ Production-grade reliability

## Next Steps

Once you verify the worker is functioning:

1. **Remove pytest fixture** from `tests/conftest.py` (lines 867-938)
2. **Run full test suite** to ensure all combat tests pass
3. **Monitor production** using the SQL queries above
4. **Tune schedule** based on combat pacing needs (2s, 5s, or 10s)
