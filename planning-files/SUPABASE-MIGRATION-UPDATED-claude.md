# Supabase Migration Plan - Unified Implementation Strategy

**Created:** 2025-11-11
**Author:** Claude (Code Assistant)
**Status:** Active Development Plan

## Executive Summary

This document provides a **proven, incremental approach** to migrating Gradient Bang from FastAPI to Supabase, based on the successful implementation and validation of the `move` edge function. The strategy emphasizes **one function at a time** with full test coverage verification before proceeding.

### Current Achievement: Move Function ✅

The `move` edge function serves as the **reference implementation** for all future migrations:
- **Deployed to cloud** and fully functional
- **Payload parity verified** (2025-11-11 08:02) - all 6 events match legacy exactly
- **End-to-end test passing** - from HTTP POST through postgres_changes delivery to final game state
- **Timing validated** - 2 second hyperspace delay properly awaited
- **No code duplication** - same test runs against both implementations via monkey-patching

### Migration Philosophy

**One Function, Fully Tested, Then Next**

1. Implement edge function in TypeScript
2. Deploy to cloud immediately (cloud is the source of truth for realtime)
3. Run payload parity test to verify exact behavioral equivalence
4. Fix any discrepancies until test passes
5. Document lessons learned
6. Repeat for next function

This approach ensures:
- **No regressions** - every function proven equivalent before moving forward
- **Fast iteration** - cloud deployments take 5-10 seconds
- **Clear progress** - each passing test is a concrete milestone
- **Reduced risk** - problems caught immediately, not accumulated

---

## Part 1: Proven Patterns from Move Implementation

### 1.1 Edge Function Structure

**Template Pattern (from `move/index.ts`):**

```typescript
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitSectorEnvelope } from '../_shared/events.ts';
import { parseJsonRequest, requireString, resolveRequestId } from '../_shared/request.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    return errorResponse('invalid JSON payload', 400);
  }

  const requestId = resolveRequestId(payload);
  const characterId = await canonicalizeCharacterId(requireString(payload, 'character_id'));

  // Rate limiting
  await enforceRateLimit(supabase, characterId, 'function_name');

  // Business logic
  return await handleFunction({ supabase, characterId, requestId, ...otherParams });
});
```

**Key Principles:**
1. **Always validate API token first** - `validateApiToken(req)`
2. **Parse request with error handling** - `parseJsonRequest(req)`
3. **Canonicalize character IDs** - `await canonicalizeCharacterId(rawId)`
4. **Enforce rate limits early** - before expensive operations
5. **Use helper functions** - separate `handleFunction()` for business logic
6. **Emit events before returning** - events are part of the contract

### 1.2 Event Emission Patterns

**✅ CORRECT - Direct Event:**
```typescript
await emitCharacterEvent({
  supabase,
  characterId,
  eventType: 'movement.complete',
  payload: { /* ... */ },
  shipId,
  sectorId,
  requestId,
});
```

**✅ CORRECT - Sector Broadcast (for observers only):**
```typescript
await emitMovementObservers({
  supabase,
  sectorId,
  metadata: observerMetadata,
  movement: 'arrive',
  source,
  requestId,
});
```

**❌ WRONG - Duplicate Emission:**
```typescript
// DON'T do this - character receives sector broadcast automatically
await emitCharacterEvent({ /* event */ });
await emitSectorEnvelope({ /* same event */ }); // DUPLICATE!
```

**Rule:** Use `emitCharacterEvent()` for character-specific events. Use `emitSectorEnvelope()` / `emitMovementObservers()` ONLY for events that observers should see. Never send both to the same character.

### 1.3 Delayed Operations

**✅ CORRECT - Await Delayed Work:**
```typescript
async function completeMovement(params): Promise<void> {
  if (hyperspaceSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, hyperspaceSeconds * 1000));
  }

  // Emit events after delay
  await emitCharacterEvent({ /* movement.complete */ });
  await emitCharacterEvent({ /* map.local */ });
}

// In main handler
await completeMovement({ /* params */ }); // MUST await
return successResponse({ request_id: requestId });
```

**❌ WRONG - Fire-and-Forget:**
```typescript
// DON'T do this - events will be lost
setTimeout(() => {
  completeMovement({ /* params */ }); // Not awaited!
}, hyperspaceSeconds * 1000);

return successResponse({ request_id: requestId }); // Returns immediately
```

**Rule:** Edge Functions support 150s idle timeout. Use it. Always `await` delayed operations to ensure events are emitted before returning.

### 1.4 Shared Helpers

**Available Modules (`supabase/functions/_shared/`):**

| Module | Purpose | Key Functions |
|--------|---------|---------------|
| `auth.ts` | API token validation | `validateApiToken()`, `unauthorizedResponse()` |
| `request.ts` | Request parsing | `parseJsonRequest()`, `requireString()`, `resolveRequestId()` |
| `ids.ts` | ID canonicalization | `canonicalizeCharacterId()` |
| `events.ts` | Event emission | `emitCharacterEvent()`, `emitSectorEnvelope()`, `buildEventSource()` |
| `status.ts` | Character/ship data | `loadCharacter()`, `loadShip()`, `buildStatusPayload()` |
| `map.ts` | Map operations | `loadMapKnowledge()`, `buildLocalMapRegion()`, `markSectorVisited()` |
| `movement.ts` | Movement helpers | `emitMovementObservers()` |
| `trading.ts` | Trade operations | Port locking, commodity exchange |
| `corporations.ts` | Corp management | Membership, invite codes, events |
| `combat_*.ts` | Combat system | Multiple modules for combat mechanics |
| `actors.ts` | Authorization | `ensureActorAuthorization()` |
| `rate_limiting.ts` | Rate limits | `enforceRateLimit()` |

**Rule:** Always check `_shared/` for existing helpers before implementing new logic. Reuse proven code.

---

## Part 2: Test Coverage Verification Workflow

### 2.1 The Test Harness

**Script:** `scripts/double_run_payload_parity.py`

**What It Does:**
1. Runs test against **legacy FastAPI server** (port 8002) → captures events to `events.legacy.jsonl`
2. Runs **same test** against **Supabase cloud deployment** → captures events to `events.supabase.jsonl`
3. Compares the two event logs - **must match exactly** (count, sequence, payloads)

**How It Works:**
```bash
# 1. Load cloud environment
source .env.cloud

# 2. Run payload parity comparison
uv run python scripts/double_run_payload_parity.py \
  tests/integration/test_game_server_api.py::test_move_to_adjacent_sector
```

**Output:**
- ✅ Success: `"Payloads match; see step5 log for details"`
- ❌ Failure: Detailed diff showing which events differ

### 2.2 Test Infrastructure

**Monkey-Patching Pattern:**

The test harness uses **environment-based switching** to run the same test against different implementations:

```python
# When USE_SUPABASE_TESTS=1 is set:
from utils.supabase_client import AsyncGameClient as _SupabaseAsyncGameClient
_api_client_module.AsyncGameClient = _SupabaseAsyncGameClient

# Tests import normally:
from utils.api_client import AsyncGameClient  # Gets Supabase version!
```

**This means:**
- Same test code validates both implementations
- No test duplication or forking
- True behavioral equivalence verification

**Test Structure Example:**
```python
async def test_move_to_adjacent_sector(server_url, payload_parity, check_server_available):
    char_id = "test_api_move"
    async with create_firehose_listener(server_url, char_id) as listener:
        async with AsyncGameClient(base_url=server_url, character_id=char_id) as client:
            await client.join(character_id=char_id)
            listener.clear_events()

            # Action under test
            result = await client.move(to_sector=1, character_id=char_id)
            assert result.get("success") is True

            # Wait for delayed operations
            await asyncio.sleep(2.5)

            # Validate events
            events = listener.events
            assert_event_emitted(events, "movement.start")
            assert_event_emitted(events, "movement.complete")

            # Verify final state
            status = await get_status(client, char_id)
            assert status["sector"]["id"] == 1
```

### 2.3 What Gets Verified

**Full Stack Coverage:**

1. **HTTP Transport** - Supabase uses HTTP POST, legacy uses WebSocket RPC
2. **Edge Function Logic** - TypeScript vs Python implementation
3. **Database Operations** - INSERT into `events` table
4. **Realtime Delivery** - postgres_changes vs HTTP broadcast
5. **Event Payloads** - Field-by-field comparison (with canonical UUID mapping)
6. **Event Timing** - Delayed events properly sequenced
7. **Final Game State** - Character position, stats, map knowledge

**Event Comparison:**

The harness uses smart comparison that accounts for:
- **UUID canonicalization** - Legacy uses display names, Supabase uses UUIDs
- **Timestamp tolerance** - Small timing differences acceptable
- **Field ordering** - JSON field order doesn't matter
- **Metadata fields** - Some transport-specific fields ignored

### 2.4 Debugging Failed Tests

**Common Failure Patterns:**

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Event count mismatch (8 vs 6) | Duplicate emissions | Remove redundant `emitSectorEnvelope()` |
| Missing events (3 vs 6) | Fire-and-forget async | Change to `await` pattern |
| Payload differences | Wrong helper function | Use `buildStatusPayload()` etc. |
| Realtime listener gets 0 events | Wrong payload extraction | Extract from `change["data"]["new"]` |
| Events received but test fails | Wrong field names | Transform `event_type` → `type` |

**Debug Commands:**
```bash
# Find latest test run
ls -lt logs/payload-parity/ | head -5

# View events
cat logs/payload-parity/.../events.legacy.jsonl | jq -r 'select(.record_type == "event") | .event_name'
cat logs/payload-parity/.../events.supabase.jsonl | jq -r 'select(.record_type == "event") | .event_name'

# Compare payloads
cat logs/payload-parity/.../step5_compare.log
```

---

## Part 3: Function-by-Function Migration Plan

### 3.1 Completed Functions ✅

| Function | Status | Test Coverage | Notes |
|----------|--------|--------------|-------|
| `get_character_jwt` | ✅ Deployed | ✅ Verified | ES256 JWT signing working |
| `join` | ✅ Deployed | ✅ Verified | Character creation + status events |
| `my_status` | ✅ Deployed | ✅ Verified | Status snapshot emission |
| `move` | ✅ Deployed | ✅ **PAYLOAD PARITY PASSING** | **Reference implementation** |

### 3.2 Priority 1: Core Gameplay (Next 4 Functions)

#### Function #5: `trade`
**Complexity:** Medium
**Dependencies:** `status`, `map`, `trading.ts`
**Events:** `trade.executed`, `port.update`

**Implementation Checklist:**
- [ ] Port state locking (optimistic)
- [ ] Credit validation and transfer
- [ ] Commodity quantity updates
- [ ] Port price recalculation
- [ ] Event emission (character only, NOT sector broadcast for trades)
- [ ] Deploy to cloud
- [ ] Run test: `test_trade_buy_commodity` and `test_trade_sell_commodity`
- [ ] Payload parity verification

**Test Command:**
```bash
source .env.cloud
uv run python scripts/double_run_payload_parity.py \
  tests/integration/test_game_server_api.py::test_trade_buy_commodity
```

**Estimated Time:** 2-3 hours

---

#### Function #6: `recharge_warp_power`
**Complexity:** Low
**Dependencies:** `status`
**Events:** `warp.recharged`

**Implementation Checklist:**
- [ ] Validate character at sector 0
- [ ] Credit deduction
- [ ] Warp power increase
- [ ] Event emission
- [ ] Deploy to cloud
- [ ] Run test: `test_recharge_warp_power`
- [ ] Payload parity verification

**Test Command:**
```bash
source .env.cloud
uv run python scripts/double_run_payload_parity.py \
  tests/integration/test_game_server_api.py::test_recharge_warp_power
```

**Estimated Time:** 1-2 hours

---

#### Function #7: `transfer_warp_power`
**Complexity:** Low
**Dependencies:** `status`
**Events:** `warp.transferred`

**Implementation Checklist:**
- [ ] Validate both characters in same sector
- [ ] Warp power deduction and addition
- [ ] Event emission (to both characters)
- [ ] Deploy to cloud
- [ ] Run test: `test_transfer_warp_power`
- [ ] Payload parity verification

**Estimated Time:** 1-2 hours

---

#### Function #8: `transfer_credits`
**Complexity:** Low
**Dependencies:** `status`
**Events:** `credits.transferred`

**Implementation Checklist:**
- [ ] Credit validation
- [ ] Credit deduction and addition
- [ ] Event emission (to both characters)
- [ ] Deploy to cloud
- [ ] Run test: `test_transfer_credits`
- [ ] Payload parity verification

**Estimated Time:** 1-2 hours

---

### 3.3 Priority 2: Combat System (Next 6 Functions)

#### Function #9: `combat_initiate`
**Complexity:** High
**Dependencies:** `combat_*.ts`, `status`, `map`
**Events:** `combat.initiated`, `combat.round_waiting`

**Implementation Checklist:**
- [ ] Load character and target states
- [ ] Validate same sector
- [ ] Create combat encounter
- [ ] Add both as participants
- [ ] Start combat timer
- [ ] Event emission (to both participants + sector observers)
- [ ] Deploy to cloud
- [ ] Run test: `test_combat_initiate`
- [ ] Payload parity verification

**Estimated Time:** 4-6 hours

---

#### Function #10: `combat_action`
**Complexity:** High
**Dependencies:** `combat_*.ts`
**Events:** `combat.action_submitted`, `combat.round_resolved`, `combat.ended`

**Implementation Checklist:**
- [ ] Load combat state
- [ ] Validate participant
- [ ] Record action
- [ ] Check if all actions submitted → resolve round
- [ ] Combat resolution logic (from `combat_resolution.ts`)
- [ ] Check victory conditions
- [ ] Event emission (to participants + observers)
- [ ] Deploy to cloud
- [ ] Run test: `test_combat_attack_action`
- [ ] Payload parity verification

**Estimated Time:** 6-8 hours

---

#### Functions #11-14: Garrison Operations
- `combat_leave_fighters` (deploy garrison)
- `combat_collect_fighters` (collect garrison)
- `combat_set_garrison_mode` (change toll/defensive/offensive)
- Combat auto-engage on movement

**Estimated Time:** 8-10 hours total

---

### 3.4 Priority 3: Corporation System (Next 8 Functions)

Corporation functions are **already implemented** but may need payload parity verification:

| Function | Status | Notes |
|----------|--------|-------|
| `corporation_create` | ✅ Implemented | Needs test verification |
| `corporation_join` | ✅ Implemented | Needs test verification |
| `corporation_leave` | ✅ Implemented | Needs test verification |
| `corporation_kick` | ✅ Implemented | Error codes need alignment |
| `corporation_regenerate_invite_code` | ✅ Implemented | Needs test verification |
| `corporation_list` | ✅ Implemented | Needs test verification |
| `corporation_info` | ✅ Implemented | Needs test verification |
| `my_corporation` | ✅ Implemented | Needs test verification |

**Test Strategy:**
Run payload parity tests for each function to verify event emissions match legacy:
```bash
source .env.cloud
uv run python scripts/double_run_payload_parity.py \
  tests/integration/test_corporation_api.py::test_corporation_create
```

---

### 3.5 Remaining Functions

| Function | Complexity | Priority | Estimated Time |
|----------|-----------|----------|----------------|
| `local_map_region` | Low | P1 | 1-2 hours |
| `list_known_ports` | Low | P1 | 1-2 hours |
| `plot_course` | Low | P1 | 1-2 hours |
| `path_with_region` | Low | P1 | 1-2 hours |
| `dump_cargo` | Low | P2 | 1-2 hours |
| `purchase_fighters` | Medium | P2 | 2-3 hours |
| `ship_purchase` | Medium | P2 | 2-3 hours |
| `bank_transfer` | Low | P2 | 1-2 hours |
| `event_query` | Medium | P2 | 2-3 hours |
| `test_reset` | Medium | P2 | 2-3 hours |
| `combat_tick` | High | P2 | 3-4 hours |

---

## Part 4: Development Workflow

### 4.1 Standard Function Implementation Process

**Step 1: Implement Edge Function**
```bash
# Create function directory
mkdir -p supabase/functions/FUNCTION_NAME

# Implement index.ts using move/index.ts as template
# Copy patterns for auth, parsing, validation, event emission
```

**Step 2: Deploy to Cloud**
```bash
# Deploy function
npx supabase functions deploy FUNCTION_NAME \
  --project-ref pqmccexihlpnljcjfght \
  --no-verify-jwt

# Deployment takes 5-10 seconds
```

**Step 3: Run Integration Test**
```bash
# Load cloud environment
source .env.cloud

# Run specific test
uv run pytest tests/integration/test_game_server_api.py::test_FUNCTION_NAME -xvs
```

**Step 4: Run Payload Parity Test**
```bash
# Compare legacy vs Supabase
source .env.cloud
uv run python scripts/double_run_payload_parity.py \
  tests/integration/test_game_server_api.py::test_FUNCTION_NAME
```

**Step 5: Fix Discrepancies**
- If event count differs → check for duplicate emissions
- If payloads differ → verify helper functions match legacy
- If timing issues → ensure delays are properly awaited
- If realtime fails → check postgres_changes subscription

**Step 6: Document Lessons Learned**
- Update this plan with new patterns discovered
- Note any edge cases or gotchas
- Share knowledge with team

### 4.2 Local vs Cloud Development

**Local Development (Iteration):**
- ✅ Edit function logic
- ✅ Test database writes (query `events` table directly)
- ✅ Test RLS policies
- ❌ **Cannot test realtime** (CLI bug with postgres_changes)

**Cloud Development (Validation):**
- ✅ Full realtime delivery
- ✅ Payload parity verification
- ✅ End-to-end integration
- Fast deploys (5-10 seconds)

**Recommended Cycle:**
1. Implement locally
2. Deploy to cloud frequently
3. Test realtime delivery
4. Iterate based on test results

### 4.3 Database Seeding

**Cloud Database:** Requires direct PostgreSQL connection

**Connection Details:**
```bash
# .env.cloud should contain:
SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres
```

**Seeding Command:**
```bash
# Reset and seed test data
uv run python scripts/reset_test_state.py --supabase
```

**Note:** IPv4 add-on required for direct connections (Supabase is IPv6-only by default)

---

## Part 5: Testing Strategy

### 5.1 Test Categories

**Category 1: Payload Parity Tests** (HIGHEST PRIORITY)
- Run same test against legacy and Supabase
- Verify exact event equivalence
- Proves behavioral compatibility
- **Required before marking function complete**

**Category 2: Edge-Specific Tests** (`tests/edge/`)
- Test Supabase-specific features
- RLS policy validation
- JWT authentication
- Rate limiting

**Category 3: Integration Tests** (`tests/integration/`)
- Already exist for legacy
- Run unchanged against Supabase via monkey-patching
- Prove contract compatibility

### 5.2 Test Execution

**Run Payload Parity for All Completed Functions:**
```bash
# Source cloud environment once
source .env.cloud

# Run parity tests
uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::test_join_creates_character
uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::test_my_status_returns_current_state
uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::test_move_to_adjacent_sector
# ... etc for each function
```

**Run Full Integration Suite:**
```bash
# Run all integration tests against Supabase
USE_SUPABASE_TESTS=1 uv run pytest tests/integration/test_game_server_api.py -v
```

### 5.3 Success Criteria Per Function

A function is **complete** when:
- ✅ Edge function deployed to cloud
- ✅ Integration test passes against Supabase
- ✅ Payload parity test passes (exact event match)
- ✅ No duplicate events
- ✅ Proper timing (delayed operations awaited)
- ✅ Final game state matches legacy
- ✅ Lessons documented

---

## Part 6: Architecture Patterns

### 6.1 Event Delivery Architecture

**postgres_changes Flow:**
```
[Edge Function]
      ↓
  INSERT INTO public.events + event_character_recipients
      ↓
  PostgreSQL WAL (Write-Ahead Log)
      ↓
  postgres_cdc_rls extension
      ↓
  RLS policy evaluation (per subscriber)
      ↓
  Supabase Realtime WebSocket
      ↓
  Client receives event (authenticated with character JWT)
```

**Key Points:**
- One database INSERT fans out to all authorized recipients
- RLS enforces visibility server-side (clients can't cheat)
- Same events available via `event_query` for replay
- Event ID used for cross-topic deduplication

### 6.2 Event Format Transformation

**Database Schema:**
```json
{
  "event_type": "movement.complete",
  "payload": { /* JSONB */ },
  "scope": "direct",
  "sector_id": 5,
  "ship_id": "uuid",
  "character_id": "uuid",
  "request_id": "uuid",
  "inserted_at": "2025-11-11T08:00:00Z"
}
```

**Application Format (Legacy):**
```json
{
  "type": "movement.complete",
  "payload": { /* nested */ },
  "summary": "Character moved to Sector 5"
}
```

**Transformation (in SupabaseRealtimeListener):**
```python
def _handle_supabase_change(self, change):
    record = change.get("data", {}).get("new", {})

    # Transform database schema to app format
    event = {
        "type": record.get("event_type"),  # Rename field
        "payload": record.get("payload"),   # Pass through
        "summary": self._generate_summary(record),  # Generate from record
    }

    self._dispatch_event(event)
```

### 6.3 Rate Limiting

**Pattern:**
```typescript
await enforceRateLimit(supabase, characterId, 'function_name');
```

**Configuration:**
- Per-function limits stored in `rate_limit_config` table
- Limits checked against `rate_limit_usage` table
- Sliding window algorithm
- 429 error if exceeded

**Note:** Rate limits apply to **character**, not actor. This prevents corp members from circumventing limits.

### 6.4 Actor Authorization

**Pattern:**
```typescript
await ensureActorAuthorization({
  supabase,
  ship,
  actorCharacterId,
  adminOverride,
  targetCharacterId: characterId,
});
```

**Rules:**
- If `actorCharacterId` is null or matches `characterId` → OK
- If ship is corporation-owned → check `actorCharacterId` is corp member
- If `adminOverride` is true → check admin privileges
- Otherwise → reject with 403

---

## Part 7: Common Pitfalls and Solutions

### 7.1 Event Emission Mistakes

**Mistake #1: Fire-and-Forget Async**
```typescript
// ❌ WRONG
setTimeout(() => {
  emitCharacterEvent({ /* event */ });
}, 2000);
return successResponse({ /* result */ });
```

**Solution:** Always await delayed operations
```typescript
// ✅ CORRECT
await new Promise(resolve => setTimeout(resolve, 2000));
await emitCharacterEvent({ /* event */ });
return successResponse({ /* result */ });
```

---

**Mistake #2: Duplicate Emissions**
```typescript
// ❌ WRONG
await emitCharacterEvent({ characterId, eventType: 'movement.complete', /* ... */ });
await emitSectorEnvelope({ sectorId, eventType: 'movement.complete', /* ... */ });
// Character receives event TWICE if in that sector!
```

**Solution:** Emit direct OR broadcast, not both
```typescript
// ✅ CORRECT
await emitCharacterEvent({ characterId, eventType: 'movement.complete', /* ... */ });
// Character receives this directly; no sector broadcast needed for their own event
```

---

**Mistake #3: Wrong Payload Structure**
```typescript
// ❌ WRONG - Missing 'source' field
await emitCharacterEvent({
  eventType: 'movement.start',
  payload: { sector: sectorSnapshot },
});
```

**Solution:** Use helper functions that build correct payloads
```typescript
// ✅ CORRECT
const source = buildEventSource('move', requestId);
await emitCharacterEvent({
  eventType: 'movement.start',
  payload: {
    source,  // Required field
    sector: sectorSnapshot,
    hyperspace_time: hyperspaceSeconds,
  },
});
```

### 7.2 Realtime Delivery Issues

**Problem:** Realtime listener receives 0 events despite database writes

**Checklist:**
1. ✅ Character JWT authentication working? (`get_character_jwt` deployed)
2. ✅ Subscription to correct table? (should be `public.events`)
3. ✅ RLS policies allow character to see events? (check `event_character_recipients`)
4. ✅ Correct payload extraction? (extract from `change["data"]["new"]`)
5. ✅ Event format transformation? (map `event_type` → `type`)

**Debug Commands:**
```sql
-- Check events in database
SELECT event_type, character_id, inserted_at
FROM events
WHERE character_id = 'test_character_uuid'
ORDER BY inserted_at DESC
LIMIT 10;

-- Check recipients
SELECT r.character_id, r.reason, e.event_type
FROM event_character_recipients r
JOIN events e ON e.id = r.event_id
WHERE r.character_id = 'test_character_uuid'
ORDER BY e.inserted_at DESC
LIMIT 10;
```

### 7.3 Test Failures

**Failure Pattern:** "Event count mismatch: 6 legacy vs 8 supabase"

**Cause:** Duplicate event emissions

**Solution:**
1. Check edge function for redundant `emitSectorEnvelope()` calls
2. Character shouldn't receive both direct event AND sector broadcast for same event
3. Remove one of the emissions

---

**Failure Pattern:** "Event count mismatch: 6 legacy vs 3 supabase"

**Cause:** Missing events (fire-and-forget async)

**Solution:**
1. Find any `setTimeout()` or async IIFE without `await`
2. Change to `await new Promise(...)` pattern
3. Ensure function doesn't return until all events emitted

---

**Failure Pattern:** "Payload differences in event 3"

**Cause:** Wrong helper function or missing field

**Solution:**
1. Compare Supabase payload to legacy using `jq`
2. Check which helper builds that payload (e.g., `buildStatusPayload()`)
3. Ensure all legacy fields are present
4. Fix and redeploy

---

## Part 7.4: Move Function Sanity Check Recommendations

Based on comprehensive analysis of the move implementation (documented in `docs/move-function-sanity-check.md`), here are actionable recommendations to strengthen the foundation:

### Recommendation 1: Add Clarifying Comments

**Location:** `supabase/functions/move/index.ts` (finally block)

**Current Code:**
```typescript
} finally {
  if (enteredHyperspace) {
    await finishHyperspace({ supabase, shipId: ship.ship_id, destination: ship.current_sector ?? 0 });
  }
}
```

**Add Comment:**
```typescript
} finally {
  if (enteredHyperspace) {
    // Reset ship to departure sector (still ship.current_sector at this point) if movement fails.
    // This rollback is intentional - ship stays at origin when completion errors occur.
    await finishHyperspace({ supabase, shipId: ship.ship_id, destination: ship.current_sector ?? 0 });
  }
}
```

**Why:** Clarifies that the rollback behavior is intentional, preventing future confusion about whether this is a bug.

---

### Recommendation 2: Add Movement Completion Telemetry

**Location:** `supabase/functions/move/index.ts` (completeMovement function)

**Add After `finishHyperspace()`:**
```typescript
console.log('movement.completed', {
  character_id: characterId,
  ship_id: shipId,
  from_sector: /* store departure sector in handleMove() */,
  to_sector: destination,
  duration_ms: hyperspaceSeconds * 1000,
  first_visit: firstVisit,
  request_id: requestId,
  timestamp: new Date().toISOString(),
});
```

**Why:** Enables tracking of movement patterns, performance analysis, and debugging of timing issues. Complements existing `movement.observers.emitted` logging.

---

### Recommendation 3: Document Event Emission Guidelines

**Location:** `supabase/functions/_shared/events.ts` (add JSDoc at top of file)

**Add Documentation:**
```typescript
/**
 * Event Emission Guidelines
 * ========================
 *
 * CRITICAL RULES for avoiding duplicate events and ensuring proper delivery:
 *
 * 1. Direct Character Events
 *    - Use emitCharacterEvent() when the event targets a specific character
 *    - Example: status updates, personal achievements, direct messages
 *
 * 2. Sector Broadcasts
 *    - Use emitSectorEnvelope() or emitMovementObservers() for multi-recipient sector events
 *    - ALWAYS exclude the actor using excludeCharacterIds parameter
 *    - Example: character.moved events to observers, garrison notifications
 *
 * 3. NEVER Emit Both
 *    - ❌ WRONG: emitCharacterEvent() + emitSectorEnvelope() for same event to same character
 *    - Character automatically receives sector broadcasts if they're in that sector
 *    - This creates duplicates and breaks payload parity tests
 *
 * 4. Always Await
 *    - All event emissions MUST be awaited before returning response
 *    - Edge Functions support 150s timeout - use it for delayed operations
 *    - Never use fire-and-forget setTimeout() without await
 *
 * 5. Include Source Field
 *    - Always use buildEventSource(method, requestId) for traceability
 *    - Include source in ALL event payloads for debugging and metrics
 *
 * 6. Proper Error Handling
 *    - Emit error events using emitErrorEvent() for validation failures
 *    - Include endpoint name, request_id, status code, and detail message
 *
 * Example Pattern (from move/index.ts):
 *
 *   // Direct to character
 *   await emitCharacterEvent({
 *     supabase,
 *     characterId,
 *     eventType: 'movement.complete',
 *     payload: { source, ...data },
 *     requestId,
 *   });
 *
 *   // Broadcast to observers (excludes actor automatically)
 *   await emitMovementObservers({
 *     supabase,
 *     sectorId: destination,
 *     metadata: observerMetadata,
 *     movement: 'arrive',
 *     source,
 *     requestId,
 *   });
 */
```

**Why:** Codifies patterns discovered through move implementation, prevents future duplicate emission bugs that plagued early iterations.

---

### Recommendation 4: Add Observer Notification Integration Test

**Location:** `tests/integration/test_game_server_api.py` (new test)

**Add Test:**
```python
async def test_move_broadcasts_to_sector_observers(server_url, payload_parity, check_server_available):
    """
    Verify character.moved events reach sector observers.

    Validates:
        - Observer in same sector receives character.moved event
        - Moving character does NOT receive duplicate via sector broadcast
        - Observer in different sector does NOT receive event
        - Event payload includes correct movement metadata
    """
    mover = "test_move_broadcaster"
    observer_same_sector = "test_observer_same"
    observer_other_sector = "test_observer_other"

    async with create_firehose_listener(server_url, mover) as mover_listener:
        async with create_firehose_listener(server_url, observer_same_sector) as observer_same_listener:
            async with create_firehose_listener(server_url, observer_other_sector) as observer_other_listener:
                async with AsyncGameClient(base_url=server_url, character_id=mover) as mover_client:
                    async with AsyncGameClient(base_url=server_url, character_id=observer_same_sector) as obs_same_client:
                        async with AsyncGameClient(base_url=server_url, character_id=observer_other_sector) as obs_other_client:
                            # Setup: All start at sector 0
                            await mover_client.join(character_id=mover)
                            await obs_same_client.join(character_id=observer_same_sector)
                            await obs_other_client.join(character_id=observer_other_sector)

                            # Move observer_other to sector 2 (different from mover)
                            await obs_other_client.move(to_sector=2, character_id=observer_other_sector)
                            await asyncio.sleep(2.5)

                            # Clear all listeners
                            mover_listener.clear_events()
                            observer_same_listener.clear_events()
                            observer_other_listener.clear_events()

                            # Action: Mover moves from sector 0 to sector 1
                            await mover_client.move(to_sector=1, character_id=mover)
                            await asyncio.sleep(2.5)

                            # Validate: Mover receives movement.start and movement.complete
                            mover_events = mover_listener.events
                            assert_event_emitted(mover_events, "movement.start")
                            assert_event_emitted(mover_events, "movement.complete")
                            # Mover should NOT receive character.moved (no self-broadcast)
                            character_moved_events = [e for e in mover_events if e.get("type") == "character.moved"]
                            assert len(character_moved_events) == 0, "Mover should not receive character.moved via sector broadcast"

                            # Validate: Observer in same sector receives departure event
                            observer_same_events = observer_same_listener.events
                            # Observer should see character.moved for departure from sector 0
                            departure_events = [e for e in observer_same_events
                                              if e.get("type") == "character.moved"
                                              and e.get("payload", {}).get("movement") == "depart"]
                            assert len(departure_events) >= 1, "Observer should see departure from sector 0"

                            # Validate: Observer in different sector receives nothing
                            observer_other_events = observer_other_listener.events
                            movement_events = [e for e in observer_other_events
                                             if e.get("type") in ("movement.start", "movement.complete", "character.moved")]
                            assert len(movement_events) == 0, "Observer in different sector should not see movement events"
```

**Why:** Validates the critical observer pattern that prevents duplicate emissions while ensuring proper sector-wide notification.

---

### Recommendation 5: Document Garrison Event Format

**Location:** `docs/event-formats.md` (create new file or add to existing docs)

**Add Section:**
```markdown
## Garrison Events

When a character moves into or out of a sector containing garrisons, two types of events are emitted:

### 1. Regular Observer Events (`character.moved`)

**Recipients:** All characters in the sector (excluding the moving character)
**Event Type:** `character.moved`
**Payload:**
```json
{
  "player": { "id": "character-uuid", "name": "Character Name" },
  "ship": { "ship_name": "Ship Name", "ship_type": "ship_type" },
  "movement": "arrive" | "depart",
  "timestamp": "ISO-8601",
  "source": { "type": "rpc", "method": "move", "request_id": "uuid" }
}
```

### 2. Garrison Notification Events (`garrison.character_moved`)

**Recipients:** Garrison owner + all corporation members (if garrison is corp-owned)
**Event Type:** `garrison.character_moved`
**Payload:**
```json
{
  "player": { "id": "character-uuid", "name": "Character Name" },
  "ship": { "ship_name": "Ship Name", "ship_type": "ship_type" },
  "movement": "arrive" | "depart",
  "timestamp": "ISO-8601",
  "source": { "type": "rpc", "method": "move", "request_id": "uuid" },
  "garrison": {
    "owner_id": "owner-character-uuid",
    "owner_name": "Owner Name",
    "corporation_id": "corp-uuid" | null,
    "fighters": 1000,
    "mode": "defensive" | "offensive" | "toll",
    "toll_amount": 100,
    "deployed_at": "ISO-8601"
  }
}
```

**Recipient Tagging:**
- Garrison owner: `reason = 'garrison_owner'`
- Corporation members: `reason = 'garrison_corp_member'`
- Regular observers: `reason = 'sector_snapshot'`

**Implementation:** See `_shared/observers.ts::emitGarrisonCharacterMovedEvents()`
```

**Why:** Documents the advanced garrison notification feature for future developers and provides clear examples of event formats.

---

### Recommendation 6: Add Sanity Check to CI/CD

**Location:** `.github/workflows/` or similar CI configuration

**Add Step:**
```yaml
- name: Verify Move Function Sanity
  run: |
    # Run payload parity test for move function
    source .env.cloud
    uv run python scripts/double_run_payload_parity.py \
      tests/integration/test_game_server_api.py::test_move_to_adjacent_sector

    # Check for success
    if [ $? -ne 0 ]; then
      echo "❌ Move function payload parity FAILED"
      echo "This is the reference implementation - it must always pass"
      exit 1
    fi

    echo "✅ Move function payload parity verified"
```

**Why:** Prevents regressions to the reference implementation. Since move is the template, it must always remain working.

---

### Recommendation 7: Create Quick Reference Card

**Location:** `docs/edge-function-quick-ref.md` (new file)

**Content:**
```markdown
# Edge Function Quick Reference

## Template Checklist

When implementing a new edge function, copy this checklist:

### Request Flow
- [ ] `validateApiToken(req)` - First line of defense
- [ ] `parseJsonRequest(req)` - With try-catch
- [ ] `canonicalizeCharacterId()` - For all character IDs
- [ ] `resolveRequestId(payload)` - For tracing
- [ ] `enforceRateLimit()` - Before expensive operations
- [ ] Business logic in separate `handleFunction()`

### Event Emission
- [ ] Use `buildEventSource(method, requestId)` for source field
- [ ] Direct events: `emitCharacterEvent()`
- [ ] Sector broadcasts: `emitSectorEnvelope()` with exclusions
- [ ] NEVER both for same character
- [ ] Always `await` emissions
- [ ] Error events: `emitErrorEvent()`

### Testing
- [ ] Deploy: `npx supabase functions deploy FUNCTION --project-ref PROJECT_ID --no-verify-jwt`
- [ ] Integration test: `source .env.cloud && uv run pytest tests/integration/test_game_server_api.py::test_FUNCTION -xvs`
- [ ] Payload parity: `source .env.cloud && uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::test_FUNCTION`
- [ ] Fix until passing
- [ ] Document lessons learned

### Common Patterns

**Delayed Operations:**
```typescript
await new Promise(resolve => setTimeout(resolve, delayMs));
await emitEvents();
return successResponse();
```

**Observer Notifications:**
```typescript
await emitMovementObservers({
  supabase,
  sectorId,
  metadata: { characterId, characterName, shipId, shipName, shipType },
  movement: 'arrive',
  source: buildEventSource('move', requestId),
  requestId,
});
```

**Error Handling:**
```typescript
try {
  // Business logic
} catch (err) {
  await emitErrorEvent(supabase, {
    characterId,
    method: 'function_name',
    requestId,
    detail: err.message,
    status: 500,
  });
  return errorResponse(err.message, 500);
}
```

## Reference Implementation

Study `supabase/functions/move/index.ts` - it demonstrates all patterns correctly.

Payload parity status: ✅ PASSING (verified 2025-11-11 08:02)
```

**Why:** Provides a quick reference for developers implementing new functions, reducing cognitive load and preventing common mistakes.

---

### Implementation Priority

**High Priority (Before Next Function):**
1. ✅ Recommendation 3: Add event emission guidelines to `_shared/events.ts`
2. ✅ Recommendation 7: Create quick reference card

**Medium Priority (During Trade Implementation):**
3. ✅ Recommendation 2: Add telemetry logging pattern
4. ✅ Recommendation 1: Add clarifying comments

**Low Priority (After Phase 1 Complete):**
5. ⏳ Recommendation 4: Add observer integration test
6. ⏳ Recommendation 5: Document garrison event formats
7. ⏳ Recommendation 6: Add sanity check to CI/CD

---

## Part 8: Milestones and Progress Tracking

### 8.1 Phase 1: Core Functions (Week 1-2)

**Goal:** Get essential gameplay working

| Function | Estimated Hours | Status |
|----------|----------------|--------|
| `join` | - | ✅ Complete |
| `my_status` | - | ✅ Complete |
| `move` | - | ✅ Complete |
| `trade` | 2-3 | ⏳ Next |
| `recharge_warp_power` | 1-2 | ⏳ Pending |
| `transfer_warp_power` | 1-2 | ⏳ Pending |
| `transfer_credits` | 1-2 | ⏳ Pending |
| `local_map_region` | 1-2 | ⏳ Pending |
| `list_known_ports` | 1-2 | ⏳ Pending |
| `plot_course` | 1-2 | ⏳ Pending |
| `path_with_region` | 1-2 | ⏳ Pending |

**Exit Criteria:**
- All functions have payload parity tests passing
- Can play game: join, move, trade, navigate
- No critical bugs

### 8.2 Phase 2: Combat System (Week 3-4)

**Goal:** Full combat functionality

| Function | Estimated Hours | Status |
|----------|----------------|--------|
| `combat_initiate` | 4-6 | ⏳ Pending |
| `combat_action` | 6-8 | ⏳ Pending |
| `combat_leave_fighters` | 2-3 | ⏳ Pending |
| `combat_collect_fighters` | 2-3 | ⏳ Pending |
| `combat_set_garrison_mode` | 2-3 | ⏳ Pending |
| Auto-engage on move | 2-3 | ⏳ Pending |

**Exit Criteria:**
- All combat tests passing
- Garrison mechanics working
- Combat events match legacy exactly

### 8.3 Phase 3: Corporation System (Week 5)

**Goal:** Verify corporation functions

| Function | Estimated Hours | Status |
|----------|----------------|--------|
| Corporation functions verification | 1-2 each | ⏳ Pending |
| Event payload alignment | 2-3 | ⏳ Pending |

**Exit Criteria:**
- All corporation tests passing
- Event emissions match legacy
- Error codes aligned

### 8.4 Phase 4: Remaining Functions (Week 6)

**Goal:** Complete remaining functions

| Function | Estimated Hours | Status |
|----------|----------------|--------|
| `dump_cargo` | 1-2 | ⏳ Pending |
| `purchase_fighters` | 2-3 | ⏳ Pending |
| `ship_purchase` | 2-3 | ⏳ Pending |
| `bank_transfer` | 1-2 | ⏳ Pending |
| `event_query` | 2-3 | ⏳ Pending |
| `combat_tick` | 3-4 | ⏳ Pending |

**Exit Criteria:**
- 100% of functions migrated
- All integration tests passing
- Performance acceptable

### 8.5 Phase 5: Cutover Preparation (Week 7)

**Goal:** Prepare for production switch

**Tasks:**
- [ ] Run full integration suite against Supabase (all 50+ tests)
- [ ] Performance testing and optimization
- [ ] Documentation updates (CLAUDE.md, AGENTS.md, runbooks)
- [ ] Monitoring and alerting setup
- [ ] Backup and rollback procedures tested
- [ ] Team training on Supabase operations

**Exit Criteria:**
- All tests green
- Performance meets SLOs (p95 <200ms, p99 <500ms)
- Runbooks complete
- Rollback tested

---

## Part 9: Deployment and Operations

### 9.1 Deployment Process

**Deploy Single Function:**
```bash
npx supabase functions deploy FUNCTION_NAME \
  --project-ref pqmccexihlpnljcjfght \
  --no-verify-jwt
```

**Deploy All Functions:**
```bash
# Deploy all at once (use sparingly)
for func in $(ls supabase/functions/ | grep -v _shared); do
  npx supabase functions deploy $func --project-ref pqmccexihlpnljcjfght --no-verify-jwt
done
```

**Set Environment Variables:**
```bash
# Set secrets via CLI (not committed to repo)
npx supabase secrets set EDGE_API_TOKEN=xxx --project-ref pqmccexihlpnljcjfght
npx supabase secrets set MOVE_DELAY_SECONDS_PER_TURN=0.67 --project-ref pqmccexihlpnljcjfght
```

### 9.2 Monitoring

**Key Metrics to Track:**
- Edge function invocation count (per function)
- Edge function error rate (per function)
- Edge function p50/p95/p99 latency
- Database connection pool usage
- Realtime connection count
- Event delivery latency (INSERT to client receipt)

**Supabase Dashboard:**
- Function logs: `https://supabase.com/dashboard/project/PROJECT/functions`
- Database metrics: `https://supabase.com/dashboard/project/PROJECT/database/pooler`
- Realtime metrics: `https://supabase.com/dashboard/project/PROJECT/realtime`

### 9.3 Troubleshooting

**Common Issues:**

| Issue | Diagnosis | Solution |
|-------|-----------|----------|
| Function timeout | Check logs for slow queries | Add indexes, optimize logic |
| Realtime not working | Check JWT authentication | Verify `get_character_jwt` deployed |
| Events not visible | Check RLS policies | Verify `event_character_recipients` populated |
| Rate limit false positives | Check rate_limit_usage table | Adjust thresholds in config |
| Database connection exhaustion | Check connection pool metrics | Scale Pooler or optimize queries |

**Debug Commands:**
```bash
# View function logs
npx supabase functions logs FUNCTION_NAME --project-ref pqmccexihlpnljcjfght

# Check database
psql "$SUPABASE_DB_URL" -c "SELECT * FROM events ORDER BY inserted_at DESC LIMIT 10;"

# Test edge function directly
curl -X POST https://PROJECT.supabase.co/functions/v1/FUNCTION \
  -H "Authorization: Bearer $EDGE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"character_id": "test", "healthcheck": true}'
```

---

## Part 10: Success Criteria and Completion

### 10.1 Technical Success Criteria

**Required for Cutover:**
- ✅ All 30+ edge functions deployed
- ✅ All integration tests passing against Supabase
- ✅ All payload parity tests passing
- ✅ No event count mismatches
- ✅ No duplicate emissions
- ✅ Proper timing (delays awaited)
- ✅ Performance meets SLOs:
  - join/move p95 <200ms
  - join/move p99 <500ms
  - combat p95 <300ms
  - combat p99 <750ms

### 10.2 Functional Success Criteria

**Gameplay Validation:**
- ✅ NPCs can navigate and trade
- ✅ Combat works (initiate, attack, flee, garrison)
- ✅ Corporations work (create, join, leave, kick)
- ✅ Events delivered in real-time (<1s latency)
- ✅ Map knowledge persists correctly
- ✅ Credits and warp power transactions work

### 10.3 Operational Success Criteria

**Operations Readiness:**
- ✅ Runbooks complete (`docs/runbooks/supabase.md`)
- ✅ Monitoring dashboards configured
- ✅ Alerting thresholds set (50/75/90% of limits)
- ✅ Backup/restore tested
- ✅ Rollback procedure tested (deploy legacy branch)
- ✅ Team trained on Supabase operations

### 10.4 Final Checklist

**Before Production Cutover:**
- [ ] All tests green for 48 hours
- [ ] Load testing passed (sustained 100 ops/sec for 1 hour)
- [ ] Database backups verified
- [ ] Secrets configured in production
- [ ] Monitoring/alerting active
- [ ] Rollback plan documented and tested
- [ ] Team sign-off obtained

---

## Part 11: Lessons Learned (Living Document)

### 11.1 From Move Implementation

**✅ What Worked:**
1. **Await delayed operations** - Edge Functions handle 150s timeouts; use them
2. **Deploy early, deploy often** - Cloud deployments take 5-10 seconds
3. **Trust postgres_changes** - Works reliably when configured correctly
4. **One function at a time** - Incremental validation caught issues early

**❌ What Didn't Work:**
1. **Fire-and-forget async** - Events lost; always await
2. **Local CLI for realtime testing** - CLI has bugs; use cloud
3. **Duplicate emissions** - Character received events twice
4. **Guessing payload structure** - Always use helper functions

### 11.2 Patterns to Propagate

1. **Event Source Pattern:**
   ```typescript
   const source = buildEventSource('function_name', requestId);
   // Include in all event payloads
   ```

2. **Delayed Operation Pattern:**
   ```typescript
   await new Promise(resolve => setTimeout(resolve, delayMs));
   await emitEvents(); // Emit after delay
   return successResponse(); // Return after events
   ```

3. **Observer Pattern:**
   ```typescript
   // Direct to character
   await emitCharacterEvent({ characterId, eventType, payload });

   // Broadcast to sector (excluding character)
   await emitMovementObservers({ sectorId, metadata, movement });
   ```

### 11.3 Future Considerations

**After Migration Complete:**
1. Consider consolidating `combat_*.ts` modules (8 files → fewer)
2. Optimize `event_character_recipients` queries if scaling issues
3. Add event retention cleanup (archive events >7 days)
4. Implement event replay for connection recovery
5. Add comprehensive admin tooling

---

## Appendix A: Quick Reference Commands

### Development
```bash
# Deploy function
npx supabase functions deploy FUNCTION_NAME --project-ref pqmccexihlpnljcjfght --no-verify-jwt

# Run integration test
source .env.cloud && uv run pytest tests/integration/test_game_server_api.py::TEST_NAME -xvs

# Run payload parity
source .env.cloud && uv run python scripts/double_run_payload_parity.py tests/integration/test_game_server_api.py::TEST_NAME
```

### Debugging
```bash
# View function logs
npx supabase functions logs FUNCTION_NAME --project-ref pqmccexihlpnljcjfght

# Query events
psql "$SUPABASE_DB_URL" -c "SELECT event_type, character_id, inserted_at FROM events ORDER BY inserted_at DESC LIMIT 10;"

# View test logs
cat logs/payload-parity/LATEST/step5_compare.log
```

### Database
```bash
# Reset cloud database
source .env.cloud && uv run python scripts/reset_test_state.py --supabase

# Connect to database
psql "$SUPABASE_DB_URL"
```

---

## Appendix B: File Locations

### Edge Functions
- Implementation: `supabase/functions/FUNCTION_NAME/index.ts`
- Shared helpers: `supabase/functions/_shared/*.ts`

### Tests
- Integration tests: `tests/integration/test_game_server_api.py`
- Edge-specific tests: `tests/edge/test_*.py`
- Payload parity script: `scripts/double_run_payload_parity.py`

### Configuration
- Cloud environment: `.env.cloud`
- Supabase config: `supabase/config.toml`
- Database migrations: `supabase/migrations/*.sql`

### Documentation
- This plan: `planning-files/SUPABASE-MIGRATION-UPDATED-claude.md`
- Events plan: `planning-files/NEXT-supabase-events-implementation.md`
- Test coverage: `planning-files/test-coverage-verification.md`
- Original plan: `planning-files/NEXT-supabase-migration-plan.md`

---

## Appendix C: Contact and Support

**For Questions:**
- Check CLAUDE.md for project conventions
- Check AGENTS.md for agent/operator guidelines
- Check docs/runbooks/ for operational procedures

**For Issues:**
- GitHub issues: https://github.com/anthropics/claude-code/issues
- Supabase support: https://supabase.com/dashboard/support

---

**End of Document**

*This is a living document. Update it as new patterns emerge and lessons are learned.*
