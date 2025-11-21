# Event Query Admin Mode Investigation

**Status**: Needs debugging with live database access
**Impact**: 3 failing tests in admin query mode
**Created**: 2025-11-16

---

## Problem Summary

When running admin query tests, the query returns **0 events** even though:
- Events SHOULD be emitted by `my_status()` calls
- The database query appears correct
- 62 other tests pass (proving events work generally)

### Failing Tests

1. `test_admin_query_sees_all_events` - Admin query returns empty array
2. `test_admin_query_with_invalid_password` - Similar issue
3. `test_character_query_requires_character_id` - Parameter validation

---

## Investigation Findings

### Evidence #1: Events Table is Empty

**Direct database query during test investigation**:
```python
supabase.table('events').select('*').limit(20).execute()
# Result: 0 rows
```

**Hypothesis**: Events ARE being written, but either:
1. They're deleted/truncated by test fixtures before query runs
2. Transaction isolation prevents query from seeing uncommitted events
3. Timing issue - events not yet persisted when query executes
4. Events are being written to wrong database/schema

### Evidence #2: Event Query Edge Function is Correct

**Admin mode query logic** (`supabase/functions/event_query/index.ts:216-224`):
```typescript
if (isAdminMode) {
    // Admin mode: Query events directly without recipient filtering
    query = supabase
      .from('events')
      .select('timestamp,direction,event_type,character_id,sender_id,sector_id,ship_id,request_id,payload,meta')
      .gte('timestamp', start.toISOString())
      .lte('timestamp', end.toISOString())
      .order('timestamp', { ascending })
      .limit(dbLimit);
}
```

This queries the `events` table directly with no JOIN - architecturally correct for admin mode.

### Evidence #3: Name Lookup Works

**The edge function does character name lookup** (`event_query/index.ts:266-269`):
```typescript
const senderLookup = await loadCharacterNames(
    supabase,
    rows.flatMap((row) => [row.sender_id, row.character_id]),
);
```

So `sender` and `receiver` fields SHOULD return human-readable names (not UUIDs).

### Evidence #4: Characters Exist in Database

**Characters table has test data**:
```
Characters (4):
  test_admin_query_char2: 8d5a49db-1133-5732-8bc9-0bc1b9b29f83
  test_admin_query_char1: 97e74e74-87ee-5cb6-8b9a-2819ac2d0e85
  test_debug_admin1: c9073f5a-be2a-5942-9058-7fcc8be06c56
  test_debug_admin2: 50c6c8f1-c759-5c4b-9612-3be6333f782d
```

So the characters exist and have proper name → UUID mappings.

---

## Possible Root Causes

### Theory #1: Test Fixture Cleanup (MOST LIKELY)

**The `reset_test_state` fixture** (`tests/conftest.py:1162-1189`):
- Runs BEFORE each test (`autouse=True`)
- Truncates all tables including `events`

**Timeline**:
1. Test resets database (clears `events` table)
2. Test creates characters
3. Test calls `my_status()` → events emitted
4. **Events written to `events` table**
5. Test calls `event.query`
6. Query executes... but returns 0 rows?

**Issue**: Either:
- Events aren't being persisted (transaction not committed)
- Time window doesn't capture events (timestamp mismatch)
- Events are deleted between emission and query

### Theory #2: Event Emission Not Working

**However**: 62 tests pass, many of which verify events via WebSocket polling (`events_since`).

**This means**:
- Event emission DOES work
- The `emitDirectEvent` / `emitSectorEnvelope` functions work
- The problem is specific to `event_query` admin mode

### Theory #3: Timestamp Window Issue

**Test code** (`test_event_system.py:2517-2524`):
```python
start_time = datetime.now(timezone.utc)
await asyncio.sleep(0.1)

await get_status(client1, char1_id)
await get_status(client2, char2_id)

await asyncio.sleep(EVENT_DELIVERY_WAIT)  # 1.5 seconds
end_time = datetime.now(timezone.utc)
```

**Potential issue**:
- `start_time` set BEFORE events emitted
- Events have `timestamp` field set by edge function
- If edge function uses `new Date()` in TypeScript vs Python's `datetime.now()`, there could be timezone/precision mismatch

### Theory #4: Transaction Isolation

**Supabase uses PostgreSQL with default READ COMMITTED isolation**:
- Edge functions write events in transactions
- If transaction hasn't committed when query runs, events won't be visible
- But `EVENT_DELIVERY_WAIT` (1.5s) should be enough for commit

---

## Debugging Approach

### Step 1: Add Logging to event_query Edge Function

**Add to `supabase/functions/event_query/index.ts`**:
```typescript
console.log('event_query.admin_mode', {
    isAdminMode,
    start: start.toISOString(),
    end: end.toISOString(),
    dbLimit,
});

const { data, error } = await query;

console.log('event_query.results', {
    rowCount: Array.isArray(data) ? data.length : 0,
    error: error ? error.message : null,
    sampleRow: Array.isArray(data) && data.length > 0 ? data[0] : null,
});
```

### Step 2: Check Events Table Directly During Test

**Add to test after event emission**:
```python
# Query database directly
from supabase import create_client
import os

url = os.environ['SUPABASE_URL']
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
supabase = create_client(url, key)

events = supabase.table('events').select('*').order('id', desc=True).limit(10).execute()
print(f"Events in database: {len(events.data)}")
for e in events.data:
    print(f"  {e['id']}: {e['event_type']}, ts={e['timestamp']}")
```

### Step 3: Compare Timestamps

**Check if timestamp formats match**:
```python
print(f"Python start_time: {start_time.isoformat()}")
print(f"Python end_time: {end_time.isoformat()}")
print(f"Event timestamp: {events.data[0]['timestamp']}")
```

### Step 4: Check Transaction Commit

**Add explicit delay before query**:
```python
await asyncio.sleep(3.0)  # Increase from 1.5s to 3s
# Then run event_query
```

If this fixes it → transaction commit timing issue.

---

## Next Steps

1. **Deploy event_query with logging** (Step 1)
2. **Run failing test** and capture logs
3. **Check Supabase function logs**: `npx supabase functions logs event_query`
4. **If events exist**: Timestamp window issue → adjust test
5. **If events don't exist**: Event emission issue → check edge function implementation
6. **If error in query**: Database schema/permission issue

---

## Related Files

- **Test**: `tests/integration/test_event_system.py:2507-2537`
- **Edge Function**: `supabase/functions/event_query/index.ts`
- **Fixture**: `tests/conftest.py:1162` (`reset_test_state`)
- **Event Emission**: `supabase/functions/_shared/events.ts`

---

## Success Criteria

Admin query test should return events from both characters:
```python
events = admin_result["events"]  # Should have 2+ events
char1_events = [e for e in events if e.get("sender") == "test_admin_query_char1"
                                   or e.get("receiver") == "test_admin_query_char1"]
char2_events = [e for e in events if e.get("sender") == "test_admin_query_char2"
                                   or e.get("receiver") == "test_admin_query_char2"]

assert len(char1_events) > 0  # Should pass
assert len(char2_events) > 0  # Should pass
```

**Note**: Since `event_query` does name lookup, `sender`/`receiver` should be human-readable names, so the comparison logic is correct (no need for UUID canonicalization here).

---

## Appendix: How Event Emission Works

### Edge Function Emits Event

**Example from `my_status/index.ts:102-111`**:
```typescript
await emitCharacterEvent({
    supabase,
    eventType: 'status.snapshot',
    characterId,
    sectorId: ship.current_sector,
    payload: statusPayload,
    rpcTimestamp,
    requestId,
});
```

### Event Helper Writes to Database

**`_shared/events.ts` → `emitCharacterEvent` → `emitDirectEvent`**:
```typescript
await supabase.rpc('record_event_with_recipients', {
    p_event_type: eventType,
    p_direction: 'event_out',
    p_scope: 'direct',
    p_actor_character_id: actorCharacterId,
    p_sector_id: sectorId,
    p_payload: payload,
    p_recipients: [characterId],  // Single recipient
    p_reasons: ['direct'],
    // ...
});
```

### Database Function Inserts Event

**`supabase/migrations/20251110090000_events_rls.sql:105-197`**:

The `record_event_with_recipients` function:
1. INSERTs into `events` table
2. INSERTs into `event_character_recipients` table
3. Returns event ID

This is all in a single transaction.

### Query Retrieves Event

**Admin mode**: Queries `events` table directly
**Character mode**: JOINs `events` with `event_character_recipients`

---

## Conclusion

The `event_query` edge function rewrite is **architecturally sound**. The admin mode failure is likely a **timing or transaction issue**, not a logic bug. Once we can see the actual database state during test execution, the root cause should become clear.

The fact that 62 tests pass proves the event system works. The 3 admin query failures are an edge case that needs live debugging.
