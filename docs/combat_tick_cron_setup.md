# Combat Tick Cron Worker Setup

## Overview

The combat tick worker uses **pg_cron** (PostgreSQL native scheduler) and **pg_net** (async HTTP client) to automatically resolve combat rounds every 5 seconds. This replaces the pytest fixture approach with a production-grade solution.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Supabase Stack                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PostgreSQL Database                                        │
│  ┌──────────────────────────────────────────────┐          │
│  │  pg_cron (scheduler)                         │          │
│  │  └─> Triggers every 5 seconds                │          │
│  │      └─> Calls invoke_combat_tick()          │          │
│  │          └─> Uses pg_net.http_post()         │          │
│  └──────────────────────────────────────────────┘          │
│                    │                                        │
│                    │ HTTP POST                              │
│                    ▼                                        │
│  ┌──────────────────────────────────────────────┐          │
│  │  Edge Function: combat_tick                  │          │
│  │  └─> Scans sector_contents.combat            │          │
│  │      └─> Finds combats where deadline < now  │          │
│  │          └─> Calls resolveEncounterRound()   │          │
│  └──────────────────────────────────────────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Benefits Over Pytest Fixture Approach

| Aspect | Pytest Fixture | pg_cron Worker |
|--------|---------------|----------------|
| **Lifecycle** | Test session only | Stack lifetime |
| **Reliability** | Event loop issues | Database-native |
| **Production Parity** | Test-only | Same code everywhere |
| **Debugging** | Complex async | SQL queries |
| **Dependencies** | pytest-asyncio, aiohttp | Built-in extensions |
| **Overhead** | Python async task | PostgreSQL background job |

## Local Development Setup

### 1. Apply Migration

```bash
# Apply the migration to your local stack
supabase db reset

# Or apply manually if stack is running
supabase db push
```

The migration `20251117040000_enable_combat_tick_cron.sql` will:
- ✅ Enable pg_cron and pg_net extensions
- ✅ Create `invoke_combat_tick()` helper function
- ✅ Schedule job to run every 5 seconds

### 2. Configure Edge Function URL (Local Development)

**Option A: Using PostgreSQL Settings (Recommended)**

Add to `supabase/config.toml`:

```toml
[db.settings]
app.supabase_url = "http://host.docker.internal:54321"
app.edge_api_token = "test-token-12345"
```

**Option B: Using ALTER DATABASE**

```sql
-- Run this in Supabase SQL Editor or via psql
ALTER DATABASE postgres SET app.supabase_url = 'http://host.docker.internal:54321';
ALTER DATABASE postgres SET app.edge_api_token = 'test-token-12345';
```

**Option C: Modify Migration (Hardcode for Local)**

Edit line 48-51 in the migration to use your local URL directly:

```sql
edge_url := 'http://host.docker.internal:54321/functions/v1/combat_tick';
api_token := 'test-token-12345';
```

### 3. Verify Worker is Running

```sql
-- Check if job is scheduled
SELECT * FROM cron.job WHERE jobname = 'combat-tick-worker';

-- Expected output:
--  jobid | schedule      | command                      | nodename  | ...
-- -------+---------------+------------------------------+-----------+-----
--      1 | */5 * * * * * | SELECT invoke_combat_tick(); | localhost | ...
```

### 4. Check Job Execution History

```sql
-- View recent job runs
SELECT
  runid,
  start_time,
  end_time,
  status,
  return_message
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker')
ORDER BY start_time DESC
LIMIT 10;
```

### 5. Monitor HTTP Requests

```sql
-- Check recent combat_tick requests
SELECT
  id,
  created,
  status_code,
  content::text as response
FROM net._http_response
ORDER BY created DESC
LIMIT 10;
```

### 6. Test Manually

```sql
-- Trigger combat tick immediately (testing)
SELECT invoke_combat_tick();

-- Check result in net._http_response table
SELECT * FROM net._http_response ORDER BY created DESC LIMIT 1;
```

## Production Setup

### 1. Set Secrets via Supabase Dashboard

1. Go to **Project Settings** → **Database** → **Settings**
2. Add custom settings:
   ```
   app.supabase_url = https://your-project.supabase.co
   app.edge_api_token = your-secure-token
   ```

Or use Supabase CLI:

```bash
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
supabase secrets set EDGE_API_TOKEN=your-secure-token
```

### 2. Verify Schedule

Production may need different timing:

```sql
-- Update schedule to every 2 seconds (more aggressive)
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker'),
  schedule := '*/2 * * * * *'
);

-- Or every 10 seconds (less overhead)
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker'),
  schedule := '*/10 * * * * *'
);
```

## Troubleshooting

### Worker Not Running

```sql
-- Check if extensions are enabled
SELECT * FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');

-- Re-create job if missing
SELECT cron.schedule(
  'combat-tick-worker',
  '*/5 * * * * *',
  $$SELECT invoke_combat_tick();$$
);
```

### HTTP Requests Failing

```sql
-- Check error details
SELECT
  created,
  status_code,
  content::text,
  error_msg
FROM net._http_response
WHERE status_code >= 400
ORDER BY created DESC
LIMIT 10;
```

Common issues:
- ❌ **404**: Edge function URL wrong (check `app.supabase_url`)
- ❌ **401**: API token wrong (check `app.edge_api_token`)
- ❌ **Connection refused**: Edge functions not running (`supabase functions serve`)

### Docker Networking Issues

If using Docker for local Supabase:
- Use `host.docker.internal` instead of `localhost`
- Ensure edge functions are exposed on port 54321
- Check Docker network configuration

### Job Not Executing on Schedule

```sql
-- Check cron configuration
SELECT * FROM cron.job;

-- Look for errors in job history
SELECT * FROM cron.job_run_details
WHERE status = 'failed'
ORDER BY start_time DESC;
```

## Testing Integration

### Test That Worker Resolves Combat Rounds

```python
# tests/integration/test_combat_tick_worker.py

import asyncio
import pytest
from utils.api_client import AsyncGameClient

@pytest.mark.asyncio
async def test_combat_tick_worker_auto_resolves(server_url):
    """Verify pg_cron worker automatically resolves combat rounds."""
    client = AsyncGameClient(base_url=server_url, character_id="test_tick_worker")

    try:
        await client.join(character_id="test_tick_worker")

        # Initiate combat that requires timeout
        # (setup combat scenario here)

        # Wait for deadline to pass (15 seconds)
        await asyncio.sleep(15.0)

        # Wait for pg_cron to trigger (up to 10 seconds)
        # Worker runs every 5 seconds, so max wait is 5s
        await asyncio.sleep(10.0)

        # Check that combat was resolved
        status = await client.my_status(character_id="test_tick_worker")
        # Assert combat state shows resolution happened

    finally:
        await client.close()
```

### Remove Pytest Fixture

Once pg_cron worker is confirmed working:

```python
# tests/conftest.py - DELETE lines 867-938

# Remove the entire combat_tick_worker fixture
# It's no longer needed!
```

## Performance Tuning

### Adjust Schedule Frequency

```sql
-- Every 2 seconds (high frequency, good for fast-paced combat)
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker'),
  schedule := '*/2 * * * * *'
);

-- Every 10 seconds (low frequency, reduce load)
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker'),
  schedule := '*/10 * * * * *'
);

-- Every 30 seconds (minimal overhead)
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker'),
  schedule := '*/30 * * * * *'
);
```

### Monitor Performance

```sql
-- Check average execution time
SELECT
  AVG(EXTRACT(EPOCH FROM (end_time - start_time))) as avg_seconds,
  COUNT(*) as total_runs
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'combat-tick-worker')
  AND start_time > NOW() - INTERVAL '1 hour';
```

## Cleanup (if needed)

To disable the worker:

```sql
-- Unschedule the job
SELECT cron.unschedule('combat-tick-worker');

-- Drop the helper function
DROP FUNCTION IF EXISTS invoke_combat_tick();
```

## References

- [Supabase Cron Documentation](https://supabase.com/docs/guides/cron)
- [pg_cron Extension](https://supabase.com/docs/guides/database/extensions/pg_cron)
- [pg_net Extension](https://supabase.com/docs/guides/database/extensions/pgnet)
- [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
