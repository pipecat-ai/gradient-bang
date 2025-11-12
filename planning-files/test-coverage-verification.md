# Test Coverage Verification

## Overview

This document explains how payload parity tests verify that Supabase edge functions work identically to the legacy FastAPI game server, including when used through the Supabase AsyncGameClient.

## What Gets Tested

### Full Integration Stack
1. **Supabase AsyncGameClient** - HTTP POST requests to edge functions
2. **Edge Function Execution** - TypeScript functions running on Deno
3. **Database Operations** - Event logging to `public.events` table
4. **Postgres_changes Delivery** - Realtime event streaming via changefeed
5. **Event Payload Structure** - Exact match with legacy server events
6. **Timing & Sequencing** - Delayed operations (e.g., 2s movement completion)
7. **Final Game State** - Character position, stats, map knowledge

### How Test Switching Works

The test infrastructure uses **monkey-patching** to switch between legacy and Supabase implementations:

```python
# When USE_SUPABASE_TESTS=1 is set:
from utils.supabase_client import AsyncGameClient as _SupabaseAsyncGameClient
_api_client_module.AsyncGameClient = _SupabaseAsyncGameClient

# Tests import normally:
from utils.api_client import AsyncGameClient  # Actually gets Supabase version!
```

This means the **same test code** runs against both implementations, ensuring true behavioral equivalence.

## Running Payload Parity Tests

### Prerequisites

1. **Cloud deployment active** with edge functions deployed
2. **Environment configured** with cloud credentials in `.env.cloud`:
   ```bash
   SUPABASE_URL=https://PROJECT.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres
   ```
3. **Test characters seeded** in cloud database

### Running a Single Test

```bash
# 1. Load cloud environment
source .env.cloud

# 2. Run payload parity comparison
uv run python scripts/double_run_payload_parity.py \
  tests/integration/test_game_server_api.py::test_move_to_adjacent_sector
```

### What Happens During Test

The script runs the test **twice**:

1. **Step 1: Legacy Baseline** - Runs against local FastAPI server (port 8002)
   - Uses WebSocket RPC for communication
   - Events captured via HTTP broadcast and WebSocket frames
   - Events logged to `events.legacy.jsonl`

2. **Step 2: Supabase Run** - Runs against cloud Supabase deployment
   - Uses HTTP POST to edge functions
   - Events captured via postgres_changes realtime subscription
   - Events logged to `events.supabase.jsonl`

3. **Step 3: Comparison** - Compares the two event logs
   - Event count must match
   - Event sequence must match
   - Event payloads must match (with allowances for timestamps, UUIDs)
   - Reports "Payloads match" or detailed diff

## Example: Move Function Test

### Test Code
```python
async def test_move_to_adjacent_sector(server_url, payload_parity, check_server_available):
    char_id = "test_api_move"
    async with create_firehose_listener(server_url, char_id) as listener:
        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)
            listener.clear_events()

            # Move to adjacent sector 1
            result = await client.move(to_sector=1, character_id=char_id)
            assert result.get("success") is True

            # Wait for movement to complete (2 seconds)
            await asyncio.sleep(2.5)

            # Validate event emission
            events = listener.events
            assert_event_emitted(events, "movement.start")
            assert_event_emitted(events, "movement.complete")

            # Verify final position
            status = await get_status(client, char_id)
            assert status["sector"]["id"] == 1
```

### Events Captured

Both legacy and Supabase runs capture identical event sequences:

1. `status.snapshot` - From join operation
2. `map.local` - From join operation
3. `movement.start` - Immediate on move call
4. `movement.complete` - After 2 second delay
5. `map.local` - Post-movement map update
6. `status.snapshot` - From final get_status call

### Verification Output

```
Payloads match: 6 events compared between
  logs/payload-parity/.../events.legacy.jsonl and
  logs/payload-parity/.../events.supabase.jsonl
```

## Transport Details

### Legacy Server
- **Connection**: WebSocket to `ws://localhost:8002/ws`
- **Protocol**: JSON-RPC frames with `{id, type, endpoint, payload}`
- **Events**: Delivered via WebSocket frames with `frame_type: "event"`
- **Response**: Synchronous `{ok: true, result: {...}}` or `{ok: false, error: {...}}`

### Supabase Implementation
- **Connection**: HTTP POST to `https://PROJECT.supabase.co/functions/v1/ENDPOINT`
- **Protocol**: JSON body with `{character_id, ...params}`
- **Events**: Delivered via postgres_changes subscription with character JWT
- **Response**: JSON with `{success: true, ...}` or error status code

### AsyncGameClient Abstraction

The Supabase `AsyncGameClient` overrides key methods:

```typescript
async def _ensure_ws(self):
    return  # No WebSocket - Supabase uses HTTP

async def _request(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    # HTTP POST instead of WebSocket RPC
    response = await http_client.post(
        f"{self._functions_url}/{edge_endpoint}",
        headers=self._edge_headers(),
        json=enriched,
    )
    # ... handle response ...
```

## Test Fixtures

### Environment Detection
```python
USE_SUPABASE_TESTS = _env_truthy("USE_SUPABASE_TESTS")
```

### Server URL Selection
```python
@pytest.fixture(scope="session")
def server_url(supabase_environment):
    if USE_SUPABASE_TESTS:
        return os.environ.get("SUPABASE_URL").rstrip("/")
    return "http://localhost:8002"
```

### Event Listener Creation
```python
async with create_firehose_listener(server_url, char_id) as listener:
    # For Supabase: Creates postgres_changes subscription with character JWT
    # For legacy: Creates WebSocket connection to /ws endpoint
```

## Interpreting Results

### Success
```
Payloads match; see step5 log for details.
```
- Edge function behaves identically to legacy
- Event payloads are correct
- Timing and sequencing work properly
- Safe to use in production

### Failure - Event Count Mismatch
```
Event count mismatch: 6 legacy vs 8 supabase
Event 4: missing counterpart
```
- Check for duplicate event emissions
- Verify `emitCharacterEvent` vs `emitSectorEnvelope` usage
- Character shouldn't receive both direct + sector broadcast for same event

### Failure - Payload Differences
```
Event 3 differs:
Legacy: {...}
Supabase: {...}
```
- Check edge function payload building logic
- Compare with `buildStatusPayload`, `buildLocalMapRegion`, etc.
- Verify field names match legacy format exactly

### Failure - Missing Events
```
Event count mismatch: 6 legacy vs 3 supabase
Event 3: missing counterpart
Event 4: missing counterpart
```
- Check for fire-and-forget async operations
- Ensure delayed operations use `await` pattern
- Verify edge function doesn't return before events are emitted

## Debugging Failures

### View Event Logs
```bash
# Find latest test run
ls -lt logs/payload-parity/tests_integration_test_game_server_api_py__test_move_to_adjacent_sector/ | head -2

# View legacy events
cat logs/payload-parity/.../events.legacy.jsonl | jq -r 'select(.record_type == "event") | .event_name'

# View Supabase events
cat logs/payload-parity/.../events.supabase.jsonl | jq -r 'select(.record_type == "event") | .event_name'

# Compare event payloads
cat logs/payload-parity/.../step5_compare.log
```

### Check Test Execution
```bash
# View test output
cat logs/payload-parity/.../step3_legacy_test.log
cat logs/payload-parity/.../step4_supabase_test.log
```

### Common Issues

**Realtime listener receives 0 events**
- Check postgres_changes payload extraction: `change["data"]["new"]` not `change["new"]`
- Verify event format transformation: database `event_type` → app `type`
- Ensure character JWT authentication is working

**Duplicate events**
- Remove redundant `emitSectorEnvelope` calls
- Character receives sector broadcasts automatically if in that sector
- Only use `emitSectorEnvelope` for events others should see

**Delayed events missing**
- Convert fire-and-forget `setTimeout` to `await` pattern
- Edge Functions support 150s idle timeout - use it
- Return response only after all events are emitted

## Adding New Function Tests

### 1. Implement Edge Function
```bash
# Create function in supabase/functions/NEW_FUNCTION/index.ts
# Follow patterns from move/index.ts or join/index.ts
```

### 2. Deploy to Cloud
```bash
npx supabase functions deploy NEW_FUNCTION --project-ref PROJECT_ID --no-verify-jwt
```

### 3. Create Integration Test
```python
async def test_new_function(server_url, payload_parity, check_server_available):
    char_id = "test_new_function"
    async with create_firehose_listener(server_url, char_id) as listener:
        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            # Test logic here
            pass
```

### 4. Run Payload Parity
```bash
source .env.cloud
uv run python scripts/double_run_payload_parity.py \
  tests/integration/test_game_server_api.py::test_new_function
```

### 5. Iterate Until Passing
- Fix event count mismatches
- Adjust payload structures
- Correct event timing
- Remove duplicates

## Success Metrics

A passing payload parity test confirms:
- ✅ Edge function implements full game logic correctly
- ✅ Supabase AsyncGameClient integration works end-to-end
- ✅ Events are emitted in correct order with proper timing
- ✅ Event payloads match legacy format exactly
- ✅ Postgres_changes realtime delivery works reliably
- ✅ Final game state is consistent with legacy behavior
- ✅ Function is production-ready for deployment

## References

- **Payload Parity Script**: `scripts/double_run_payload_parity.py`
- **Test Fixtures**: `tests/conftest.py` (monkey-patching, environment setup)
- **Event Capture**: `tests/helpers/event_capture.py` (EventListener class)
- **Supabase Client**: `utils/supabase_client.py` (HTTP + postgres_changes implementation)
- **Legacy Client**: `utils/api_client.py` (WebSocket RPC implementation)
- **Migration Plan**: `planning-files/NEXT-supabase-events-implementation.md`
