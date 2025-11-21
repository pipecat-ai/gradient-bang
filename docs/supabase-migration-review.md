# Supabase Migration: Implementation Review & Recommendations

**Date:** 2025-11-10
**Reviewer:** Gradient Bang migration team
**Scope:** Supabase migration status + next steps
**Status:** Week 2 implementation in progress (Realtime hardened, remaining RPCs in flight)

## Executive Summary

The Supabase migration is **solidly on track** with impressive foundational work completed. The team has successfully implemented core infrastructure (schema, edge functions, event system, testing harness) and is now in Week 2 focus areas. However, there are several **architectural concerns**, **missing pieces**, and **potential optimization opportunities** that should be addressed before proceeding too far.

### Key Achievements ✅
- Complete database schema with proper foreign keys and indexes
- 18 operational edge functions with shared utility library
- Supabase AsyncGameClient drop-in replacement working (now backed by a dedicated realtime core)
- Event logging + Realtime broadcast infrastructure functional, including retry/backoff + warm-up guardrails
- Edge test harness with 48 tests covering join/move/trade/ship/warp flows and running cleanly from a cold stack
- Observer registry pattern for sector-wide event fanout

### Current Gaps / Focus Areas 🚨
1. **Corporation + messaging endpoints not yet ported** – the schema is ready but these RPCs still hit the FastAPI stack. Tests are temporarily gated until the Supabase versions exist.
2. **Salvage, admin, and bank-side utilities need Supabase equivalents** – these are the last functional “islands” blocking a full cutover.
3. **CI automation still pending** – the edge test harness is stable locally; we now need to wire it into CI so cold-start regressions get caught automatically.
4. **Performance telemetry** – warm-up and retry logic removed first-run flakes, but we still need proper SLO instrumentation (p95/p99) before production.

---

## 1. Schema & Database Design

### ✅ What's Working Well

**Strong foundational design:**
- All 13 core tables implemented with proper constraints
- Corporation tables (corporations, corporation_members, corporation_ships) fully integrated
- Ship ownership tracking supports character/corporation/unowned states cleanly
- Proper CASCADE behaviors on foreign keys
- Comprehensive indexing strategy (20+ indexes)
- Observer channels JSONB column for sector-wide broadcasts
- Events table with fan-out pattern (one row per recipient)

**Migration structure:**
- Incremental migrations with clear naming convention
- 6 migrations applied so far, each focused and reversible
- `20251109170000_add_observer_channels.sql` - Good example of iterative schema evolution

### ⚠️ Potential Issues

**1. Missing `planets` JSONB column**
The schema plan (line 1462) states:
> `sector_contents` table definition (including `planets JSONB DEFAULT '[]'`)

However, examining `20251108093000_initial_schema.sql`, the `sector_contents` table definition does NOT include a `planets` column. This may be intentional (deferring planet support), but it should be documented.

**Recommendation:** Add a migration comment or plan update explaining when/if planets will be added.

---

**2. Financial audit logging approach** ✅ **RESOLVED**
The plan's Week 2 section (§2B, line 82) mentions:
> add a lightweight `ledger_entries` table for optional auditing

This table is not present in any migration. The plan lists it as an "open question W2-Q2" (line 183):
> Do we create a first-class `ledger_entries` table this week or defer to Week 3?

**Decision (2025-11-09):** **Use the existing `events` table instead of creating a separate `ledger_entries` table.** This avoids data duplication and leverages existing infrastructure. The events table already has everything needed:
- `character_id` - who's involved
- `timestamp` - when it happened
- `event_type` - what kind of transaction
- `payload` - all transaction details (amounts, parties, balances)
- `sender_id` - the other party
- `request_id` - trace back to the RPC call

**Implementation requirements:**

**A. Standardize financial event type naming:**
```typescript
// Use consistent event_type names in edge functions:
'trade.executed'           // Buy/sell at ports
'credits.transferred'      // Character-to-character transfers
'bank.deposit'            // Megabank operations
'bank.withdrawal'
'fighter.purchased'       // Fighter armory
'ship.purchased'          // Shipyard
'toll.collected'          // Garrison toll payments
'salvage.claimed'         // Picking up salvage containers
```

**B. Ensure all financial event payloads include balance snapshots:**
```typescript
// Every financial event should include:
payload: {
  amount: -1000,              // Transaction amount (negative = debit)
  balance_before: 5000,       // Balance before transaction
  balance_after: 4000,        // Balance after transaction
  transaction_type: 'ship_purchase',
  // ... other transaction-specific details
}
```

**C. Add composite index for financial audit queries:**
```sql
-- Add to new migration (e.g., 20251110000000_financial_audit_index.sql):
CREATE INDEX idx_events_financial_audit
  ON events(character_id, timestamp DESC, event_type)
  WHERE event_type LIKE '%.purchased'
     OR event_type LIKE 'credits.%'
     OR event_type LIKE 'bank.%'
     OR event_type LIKE 'toll.%'
     OR event_type LIKE 'salvage.%'
     OR event_type = 'trade.executed';
```

**D. Optional: Create a financial_transactions view for convenience:**
```sql
CREATE VIEW financial_transactions AS
SELECT
  id,
  timestamp,
  character_id,
  event_type,
  (payload->>'amount')::INTEGER AS amount,
  (payload->>'balance_after')::INTEGER AS balance,
  sender_id,
  request_id,
  payload
FROM events
WHERE event_type IN (
  'trade.executed', 'credits.transferred', 'bank.deposit',
  'bank.withdrawal', 'fighter.purchased', 'ship.purchased',
  'toll.collected', 'salvage.claimed'
);
```

**Benefits of this approach:**
- ✅ No schema duplication (events table already exists)
- ✅ Consistent audit trail for all game events, not just financial
- ✅ Simpler to maintain (one table vs. two)
- ✅ Event partitioning strategy applies to financial data too
- ✅ Realtime broadcast works for financial events automatically

**Action items:**
1. Audit existing edge functions to ensure financial events include `balance_before` and `balance_after`
2. Add the partial index for financial queries
3. Document the standard event types in `docs/event-types.md`
4. Remove `ledger_entries` from all future planning documents

---

**3. Rate limiting table structure may not scale**
Current `rate_limits` table uses composite PK `(character_id, endpoint, window_start)`. For high-traffic scenarios:
- No automatic cleanup of old windows (could bloat over time)
- No global rate limit tracking (e.g., "max 1000 moves/hour across all characters")
- No support for burst vs sustained rate limits

**Recommendation:**
- Add a cleanup job or TTL policy for rate_limits rows older than 24 hours
- Consider adding a `rate_limits_global` table for system-wide thresholds
- Document expected query patterns and add `EXPLAIN ANALYZE` results to plan

---

**4. Missing indexes for event queries**
The plan mentions per-character event catch-up queries, but there's no composite index for:
```sql
CREATE INDEX idx_events_character_timestamp
  ON events(character_id, timestamp DESC, event_type);
```

Current index `idx_events_character` covers `(character_id, timestamp DESC)`, but adding `event_type` would speed up filtered queries like "get all combat.* events for character X since timestamp Y".

**Recommendation:** Add composite indexes for common event query patterns in a new migration.

---

## 2. Edge Functions & Shared Utilities

### ✅ What's Working Well

**Excellent shared library architecture:**
- 21 shared utility modules in `supabase/functions/_shared/`
- Clean separation: auth, rate limiting, events, combat, trading, map, status, observers
- Consistent error handling patterns across all functions
- Proper token validation (`validateApiToken`) on every endpoint
- Event emission helpers (`emitCharacterEvent`, `emitSectorEvent`, `emitSectorEnvelope`)

**Edge function coverage is impressive:**
- 18 functions implemented (join, move, trade, combat_*, ship_purchase, etc.)
- All use shared utilities for consistency
- Proper rate limiting on mutation endpoints
- Observer registry integration for sector-wide broadcasts

**Event system design is solid:**
- Dual-write pattern (events table + Realtime broadcast)
- Per-character channels (`public:character:{id}`)
- Per-sector channels (`public:sector:{id}`)
- Observer channels for garrison/corp notifications
- Event source metadata tracking (`request_id`, `method`, `timestamp`)

---

## 3. Path Forward (Week 3+)

Now that realtime delivery is hardened (broadcast retries + warm-up) and the edge harness can run cleanly from a cold stack, the remaining work is mostly endpoint parity plus automation.

### 3.1 Port the remaining RPCs
- **Corporations:** implement `corporation.create/delete/modify/join/leave/kick/regenerate_invite_code/list/info` and `my.corporation`, plus corp ship operations and corp-aware observers. Tests under `tests/integration/test_corporation_*.py` are already gated with `@pytest.mark.requires_supabase_functions` and will light up automatically once the functions land.
- **Messaging & salvage:** add Supabase functions for `send_message`, `salvage_collect`, and any admin/NPC utilities still tied to FastAPI.
- **Bank/admin helpers:** finish `bank_transfer`, manual smoke utilities, and edge-only maintenance endpoints so CI can manage state exclusively through Supabase (`scripts/ci_admin_smoke.py`).

### 3.2 Expand testing & automation
- Keep the `requires_supabase_functions` marker as a guardrail, but remove it as soon as each domain is ported so CI regains full coverage.
- Wire the cold-start edge test run (`uv run pytest tests/edge -q`) into CI; the new realtime warm-up ensures this is deterministic.
- Add perf/SLO probes (latency histograms, broadcast success counters) so we can track p95/p99 for `join/move/trade` before production.

### 3.3 Documentation & runbooks
- Update `AGENTS.md`, `CLAUDE.md`, and the Supabase runbook with the new realtime requirements (warm-up, retry env vars) so every developer/environment follows the same playbook.
- Keep the “scripts/run_supabase_functions.sh” helper checked in so local workflows can background the edge runtime quickly and capture logs for debugging.

With these steps, the only remaining work before cutover will be the final production deployment checklist (secrets, monitoring, rollback) already captured in the migration plan.

### ⚠️ Potential Issues

**1. Combat event emission incomplete**
The plan's §2A (line 50) states:
> **Remaining Work (Combat Hooks):** wire `_shared/combat_state.ts` + the combat edge functions to the new helpers so auto-engage and `combat.round_*` events emit sector envelopes

Looking at `_shared/combat_state.ts` (lines 1-150), I see state management functions but **no event emission calls**. The functions (`loadCombatForSector`, `persistCombatState`, `clearCombatState`) are pure data layer operations with no calls to `emitSectorEnvelope` or `emitCharacterEvent`.

**This means:**
- Combat round transitions don't emit events yet
- Auto-engage logic may not notify observers
- Integration tests expecting combat events will fail

**Recommendation:**
- Add event emission to `persistCombatState` (emit `combat.round_started`, `combat.round_resolved`)
- Add event emission to `clearCombatState` (emit `combat.ended`)
- Ensure garrison observers receive combat events through `emitSectorEnvelope`

---

**2. No error event consolidation**
Every edge function has its own error handling, but there's no centralized error event logger. This leads to:
- Inconsistent error payloads across endpoints
- Duplicated error emission code in every function
- No tracking of error rates/patterns

**Recommendation:**
- Create `_shared/error_handling.ts` with:
  - `emitAndThrowError(supabase, characterId, endpoint, error)` - Single source of truth
  - Standard error payload schema
  - Error classification (user error, validation, server error, rate limit)
- Refactor all functions to use the shared error handler

---

**3. Missing transaction support for multi-table mutations**
Several edge functions perform multi-step mutations without transactions:
- `ship_purchase/index.ts` - Updates characters, ships, corporations, events
- `trade/index.ts` - Updates ports, ships, events
- `transfer_credits/index.ts` - Updates two characters + bank + events

If any step fails midway, data could be left in inconsistent state.

**Supabase limitation:** Edge Functions don't have native transaction support for complex RPC chains.

**Recommendation:**
- Use optimistic locking more aggressively (version fields on all mutable tables)
- Add compensating transactions for rollback scenarios
- Document which operations are NOT atomic in CLAUDE.md
- Consider moving complex multi-table mutations to Postgres functions (pl/pgsql) for real ACID transactions

---

**4. Rate limiting implementation may have race conditions**
Looking at `_shared/rate_limiting.ts`, the pattern is:
1. Query for current window count
2. If under limit, increment count
3. If over limit, throw error

This is NOT atomic. Two concurrent requests could both see count=99, both increment to 100, both succeed when limit is 100.

**Recommendation:**
- Use Postgres `INSERT ... ON CONFLICT DO UPDATE` for atomic increment:
```sql
INSERT INTO rate_limits (character_id, endpoint, window_start, request_count)
VALUES ($1, $2, NOW() - INTERVAL '...", 1)
ON CONFLICT (character_id, endpoint, window_start)
DO UPDATE SET request_count = rate_limits.request_count + 1
RETURNING request_count;
```
- Check returned count and reject if over limit

---

**5. Observer registry not cached**
`_shared/observer_registry.ts` has `getObserverChannels()` which queries the database every time. For high-frequency events (movement, combat), this adds latency.

**Recommendation:**
- Cache observer channels in-memory (Deno Deploy has edge-local KV storage)
- Invalidate cache on garrison deploy/remove events
- Add cache hit rate metrics to monitor effectiveness

---

## 3. Python Supabase Client Implementation

### ✅ What's Working Well

**Excellent drop-in replacement design:**
- `utils/supabase_client.py` extends `LegacyAsyncGameClient`
- All public methods preserved
- Realtime event streaming working
- Legacy ID canonicalization for test compatibility
- Proper error propagation with `RPCError`

**Smart workarounds:**
- Auto-redirects legacy FastAPI URLs to Supabase when `SUPABASE_URL` is set
- Handles both `websocket` and `supabase` transport names
- Debug logging via `SUPABASE_REALTIME_DEBUG` env var

### ⚠️ Potential Issues

**1. No connection pooling for HTTP client**
Line 98:
```python
self._http = httpx.AsyncClient(timeout=10.0)
```

This creates one client per `AsyncGameClient` instance. For test suites that create many clients, this could exhaust file descriptors.

**Recommendation:**
- Use a shared `httpx.AsyncClient` across all instances (singleton pattern)
- Or at least document the limitation in CLAUDE.md

---

**2. Realtime channel subscription timeout is fixed**
Line 106-108:
```python
self._realtime_subscribe_timeout = float(
    os.getenv("SUPABASE_REALTIME_SUBSCRIBE_TIMEOUT", "5")
)
```

5 seconds is reasonable, but for CI environments with slow Docker startup, this might be too short.

**Recommendation:**
- Increase default to 10 seconds
- Add exponential backoff retry logic if subscription fails

---

**3. No explicit cleanup of Realtime channels**
The `close()` method calls `_shutdown_realtime()`, but there's no visible unsubscribe logic for Realtime channels. This could leave dangling subscriptions.

**Recommendation:**
- Add explicit `channel.unsubscribe()` call in `_shutdown_realtime()`
- Log channel cleanup for debugging

---

**4. Missing methods mentioned in plan**
Plan §5.1a (line 1057) mentions:
> The Supabase-backed client must ship those APIs at parity (same method signatures, validation, and event semantics), and the test pass must demonstrate coverage via `tests/test_leaderboard_snapshot.py` plus `tests/unit/test_purchase_fighters.py`.

Need to verify:
- Is `leaderboard_resources()` implemented? (Not visible in first 300 lines)
- Is `purchase_fighters()` implemented? (Likely, given edge function exists)

**Recommendation:**
- Audit all methods in legacy client vs Supabase client for parity
- Create a compatibility test that checks method signatures match

---

## 4. Testing Infrastructure

### ✅ What's Working Well

**Edge tests are comprehensive:**
- 39 tests across 13 test files
- Good coverage: auth, join, move, trade, combat, warp power, fighters, ships, credits
- Uses `pytest.mark.edge` for selective runs
- Proper environment variable handling

**Test patterns are clean:**
- Direct HTTP calls to edge functions
- Token validation tests
- Error case coverage (404, 401, 400)
- Success case verification

### 🚨 Critical Gaps

**1. No test reset infrastructure**
Plan §2A (line 73) states:
> **Test fixture work (blocking):** Supabase mode currently skips the FastAPI `test.reset` endpoint but still relies on the file-based world data. We must implement a Supabase-native `reset_supabase_state()` fixture that calls a dedicated `test_reset` edge function

**Current status:** This doesn't exist. Looking at git commits, there's no `test_reset` edge function.

**Impact:**
- Tests are not isolated (state leaks between tests)
- Combat tests fail because deterministic characters don't exist
- Integration tests can't run in Supabase mode yet

**Recommendation:**
- **URGENT:** Create `supabase/functions/test_reset/index.ts` that:
  - Truncates: characters, ship_instances, garrisons, salvage, events, rate_limits
  - Resets: ports to seed state, sector_contents combat/salvage to null
  - Re-runs seed scripts to populate deterministic test data
- Add `tests/fixtures/supabase_fixtures.py` with `reset_supabase_state()` fixture
- Update `tests/conftest.py` to use new fixture when `USE_SUPABASE_TESTS=1`

---

**2. No CI/CD pipeline**
Plan §2C (line 99) states:
> Add a Supabase-focused CI job in `.github/workflows/tests.yml`

**Current status:** Looking at git log, no CI work has landed yet.

**Impact:**
- No automated regression testing
- Manual testing only (error-prone)
- Breaking changes won't be caught before merge

**Recommendation:**
- **HIGH PRIORITY:** Add `.github/workflows/supabase-tests.yml` that:
  - Installs Supabase CLI via `npx supabase`
  - Runs `npx supabase start`
  - Runs `npx supabase db reset --yes`
  - Starts edge functions via `npx supabase functions serve`
  - Runs `uv run pytest tests/edge -v`
  - Fails build on any test failure
- Target: <12 minutes total runtime (per plan §2C line 109)

---

**3. No performance benchmarks**
Plan §5.5 (line 1189) specifies:
> Record baseline metrics from the legacy FastAPI server for comparison. Define target SLOs: p95 <200 ms for `join`/`move`, p99 <500 ms for every RPC.

**Current status:** No benchmarking infrastructure exists.

**Impact:**
- Can't verify if Supabase is faster/slower than FastAPI
- No early warning if performance degrades
- No data to support cutover decision

**Recommendation:**
- Add `tests/benchmarks/test_performance.py` that:
  - Measures latency for join, move, trade, combat actions
  - Runs 100 iterations and calculates p50/p95/p99
  - Compares Supabase vs FastAPI side-by-side
  - Fails if p95 > 200ms or p99 > 500ms
- Log results to `docs/performance-baselines.md`

---

**4. No stress/concurrency tests**
Plan §2B (line 87) mentions:
> Dual-account transfer scenarios (corp↔pilot, pilot↔pilot, pilot↔bank) succeed with optimistic locking proved by two concurrent `transfer_credits` calls.

**Current status:** No concurrent/stress tests exist in `tests/edge/`.

**Impact:**
- Optimistic locking bugs won't be caught until production
- Race conditions in rate limiting won't be detected
- Credit duplication bugs could occur

**Recommendation:**
- Add `tests/edge/test_concurrency.py` with:
  - 10 parallel `transfer_credits` calls (same source account)
  - 10 parallel `trade` calls (same port)
  - 10 parallel `move` calls (same character)
- Verify final balances/state match expected values
- Verify no duplicate transactions

---

**5. Integration test parity incomplete**
Plan §2D (line 123) states:
> `tests/integration/test_game_server_api.py -k "move"` run unchanged via `USE_SUPABASE_TESTS=1`

**Current status:** Per plan snapshot (line 47), move tests pass but combat tests fail:
> The first Supabase-backed run of `tests/integration/test_combat_system.py` ... fails with `RPCError: combat_initiate ... 409` because the Supabase pytest fixtures do not seed the deterministic combat characters

**Impact:**
- Cannot validate combat system end-to-end
- Integration test suite is partially broken

**Recommendation:**
- Fix test fixture seeding (see recommendation #1 above)
- Document which integration tests work in Supabase mode
- Create tracking issue for remaining integration test failures

---

## 5. Documentation & Knowledge Management

### 🚨 Critical Gaps

**1. CLAUDE.md not updated**
Plan §2C (line 96) states:
> Update `AGENTS.md` + `CLAUDE.md` with: Supabase-only auth model, new AsyncGameClient path, and Week 2 observer/economy changes

**Current status:** `CLAUDE.md` still references FastAPI server extensively. No Supabase migration guidance for AI assistants.

**Impact:**
- Future AI assistants won't know about Supabase architecture
- Developers using Claude Code will get outdated instructions
- Onboarding new team members is harder

**Recommendation:**
- Add "Supabase Architecture" section to CLAUDE.md covering:
  - How to run Supabase locally (`npx supabase start`)
  - Edge function development workflow
  - How to run tests (`USE_SUPABASE_TESTS=1 pytest`)
  - Event system patterns (observer registry, sector envelopes)
  - Common troubleshooting (rate limits, realtime subscription issues)

---

**2. No runbook for common operations**
Plan §6.4 (line 1262) mentions:
> Create runbook for common operations

**Current status:** No operational runbooks exist in `docs/`.

**Impact:**
- "How do I debug a failed edge function?" - no answer
- "How do I view Realtime messages?" - no answer
- "How do I manually reset test database?" - no answer

**Recommendation:**
- Create `docs/runbooks/supabase-operations.md` with:
  - Viewing edge function logs: `npx supabase functions logs`
  - Connecting to Supabase database: `npx supabase db connect`
  - Debugging Realtime: Set `SUPABASE_REALTIME_DEBUG=1`
  - Manual test reset: `npx supabase db reset --yes`
  - Inspecting events table: Example SQL queries

---

**3. No migration changelog**
Plan §2C (line 102) suggests:
> Capture Week 2 learnings + API drift notes in `planning-files/changelog-supabase.md` (new file) for weekly demos.

**Current status:** This file doesn't exist.

**Impact:**
- Hard to track what changed each week
- API drift between plan and implementation goes undocumented

**Recommendation:**
- Create `planning-files/changelog-supabase.md` now
- Backfill Week 0 and Week 1 accomplishments
- Add Week 2 progress as work completes

---

## 6. Architecture & Design Decisions

### ✅ What's Working Well

**Server-only architecture is clean:**
- No RLS policies needed (all requests trusted)
- Service role key + API token is simple and effective
- Rate limiting is defensive, not security-critical

**Event system design is well thought out:**
- Dual-write (table + broadcast) ensures no event loss
- Fan-out pattern allows character-specific filtering
- Observer registry enables sector-wide notifications without DB queries

**Corporation support is comprehensive:**
- Proper foreign keys and cascade behaviors
- Ownership tracking supports all three types (character/corp/unowned)
- Ship purchase logic handles corp bank debits correctly

### ⚠️ Architectural Concerns

**1. No transaction support for multi-step operations**
As mentioned in §2 issue #3, many edge functions perform multi-step mutations without atomicity guarantees.

**This violates a core principle:** Database operations should be atomic or compensating.

**Recommendation:**
- **Consider moving complex mutations to Postgres functions.** For example:
  - `ship_purchase` could be a pl/pgsql function that runs entirely in a transaction
  - `transfer_credits` could use database-level atomic updates
  - `trade` could use optimistic locking at the database level

**Trade-off:** Postgres functions are less flexible than TypeScript edge functions, but they guarantee atomicity.

---

**2. Event table growth not addressed**
With the fan-out pattern, high-traffic sectors will generate many event rows. A combat round with 10 participants could generate 50+ event rows (one per participant × all event types).

Plan mentions partitioning (§Post-Migration line 1358):
> Monthly partitions for events table

But there's no migration plan or retention policy.

**Recommendation:**
- Add `docs/events-retention-policy.md` specifying:
  - Keep events for 30 days, then archive to cold storage
  - Partition by month using Postgres declarative partitioning
  - Add automated cleanup job
- Implement partitioning in Week 3 or 4 (before events table exceeds 10M rows)

---

**3. Rate limiting may not prevent runaway NPCs**
Current rate limiting is per-character, per-endpoint. But a buggy NPC could:
- Call 100 different endpoints (each under individual limit)
- Create 100 characters and spam from each (no cross-character limit)

**Recommendation:**
- Add global rate limit tracking (e.g., max 10,000 RPC calls/hour for the entire system)
- Add NPC-specific limits (e.g., NPCs can't make more than 100 calls/hour)
- Consider IP-based rate limiting if NPCs run from limited IPs

---

**4. No rollback plan beyond "switch branches"**
Plan §Rollback (line 1316) states:
> No production rollback scripts are required because all Supabase work occurs in a separate worktree/branch. If we need to revert, we simply deploy the current main branch

**This assumes:**
- No data has been migrated to Supabase production
- No characters created in Supabase-only mode
- No events logged that depend on Supabase schema

**But what if the cutover happens and we discover a critical bug?** Switching branches doesn't roll back database state.

**Recommendation:**
- Define a rollback procedure that includes:
  - How to export critical data from Supabase (characters, ships, credits)
  - How to re-import into filesystem format
  - How to verify data integrity after rollback
- Test rollback procedure during Week 5 (before production cutover)

---

**5. No monitoring/alerting infrastructure**
Plan §6.3 (line 1249) mentions:
> Monitor Supabase dashboard for errors

But there's no concrete alerting setup.

**Recommendation:**
- Configure Supabase email alerts for:
  - Error rate > 1% for any edge function
  - Database connection pool > 80% usage
  - Events table growth > 1M rows/day
  - Rate limit rejections > 100/hour
- Set up Grafana dashboard (or similar) to visualize:
  - Edge function latency (p50/p95/p99)
  - Event emission rate by type
  - Combat round resolution time
  - Trade volume by port

---

## 7. Week 2 Progress Assessment

### Current Status vs Plan

| Task | Planned Completion | Actual Status | Gap Analysis |
|------|-------------------|---------------|--------------|
| Observer hooks (§2A) | Wed, Nov 12 | Partially done | Combat envelope emission missing |
| Economy parity (§2B) | Fri, Nov 14 | Not started | Blocked by observer completion |
| Docs + CI (§2C) | Sun, Nov 16 | Not started | URGENT: CI needed for quality |
| Move integration parity (§2D) | Sun, Nov 16 | ✅ Complete | Excellent progress |

### Blocking Issues

**1. Combat test fixtures**
Status: 🚨 BLOCKING
Impact: Cannot validate combat system end-to-end
Fix: Create `test_reset` edge function + seed fixtures

**2. CI/CD pipeline**
Status: 🚨 BLOCKING (for Week 3+)
Impact: No automated regression testing
Fix: Add GitHub Actions workflow

**3. Documentation updates**
Status: ⚠️ HIGH PRIORITY
Impact: Team members + AI assistants lack guidance
Fix: Update CLAUDE.md, create runbooks

### Recommendations for Week 2 Completion

**Focus Area 1: Unblock Combat Tests (Target: Mon-Tue, Nov 10-11)**
1. Create `test_reset` edge function
2. Add seed fixture generation to `scripts/supabase_seed_test_data.py`
3. Update `tests/conftest.py` to use Supabase fixtures
4. Verify combat tests pass: `USE_SUPABASE_TESTS=1 pytest tests/integration/test_combat_system.py -v`

**Focus Area 2: CI/CD Pipeline (Target: Wed, Nov 12)**
1. Add `.github/workflows/supabase-tests.yml`
2. Verify pipeline runs end-to-end on a feature branch
3. Require pipeline success for merges to main

**Focus Area 3: Documentation Sprint (Target: Thu-Fri, Nov 13-14)**
1. Update CLAUDE.md with Supabase architecture section
2. Create `docs/runbooks/supabase-operations.md`
3. Create `planning-files/changelog-supabase.md` and backfill Week 0-2

**Focus Area 4: Combat Envelope Emission (Target: Sat-Sun, Nov 15-16)**
1. Add `emitSectorEnvelope` calls to combat state transitions
2. Verify observer channels receive combat events
3. Re-run integration tests to confirm no regressions

---

## 8. Priority Recommendations Summary

### 🚨 URGENT (Week 2)

1. **Create test reset infrastructure** - Blocking combat tests
2. **Add CI/CD pipeline** - Blocking quality assurance for Week 3+
3. **Update CLAUDE.md** - Blocking team productivity
4. **Fix combat event emission** - Blocking Week 2 sign-off

### ⚠️ HIGH PRIORITY (Week 3)

5. **Standardize financial event tracking** - Ensure all credit transactions include balance snapshots and use consistent event types (see §1 issue #2)
6. **Create performance benchmarks** - Need baseline before cutover
7. **Add concurrency/stress tests** - Validate optimistic locking
8. **Create operational runbooks** - Reduce debugging time

### 📊 MEDIUM PRIORITY (Week 4)

9. **Fix rate limiting atomicity** - Prevent race conditions
10. **Add observer channel caching** - Reduce query latency
11. **Consolidate error handling** - Improve consistency
12. **Add events table partitioning plan** - Prevent unbounded growth

### 🔧 LOW PRIORITY (Week 5+)

13. **Audit AsyncGameClient method parity** - Ensure no missing methods
14. **Define rollback procedure** - Safety net for cutover
15. **Configure monitoring/alerting** - Production readiness
16. **Add connection pooling to Supabase client** - Optimize resource usage

---

## 9. Architectural Soundness Assessment

### Overall Grade: **B+ (Good, with room for improvement)**

**Strengths:**
- Clean separation of concerns (schema, edge functions, shared utilities)
- Event system architecture is well designed
- Corporation support is comprehensive
- Test coverage is solid for completed features

**Weaknesses:**
- No transaction support for multi-step operations (potential data corruption)
- Event table growth strategy undefined (could become bottleneck)
- Rate limiting has race conditions (could fail under load)
- No observability/monitoring infrastructure (production risk)

### Is the Architecture "On the Wrong Track"?

**No major course corrections needed**, but several **tactical improvements** would strengthen the foundation:

1. **Move complex mutations to Postgres functions** - For atomicity
2. **Add event retention policy now** - Before it becomes a crisis
3. **Fix rate limiting atomicity** - Before hitting production
4. **Add monitoring early** - Easier to instrument during development

These are refinements, not rebuilds. The core architecture is sound.

---

## 10. Conclusion

The Supabase migration is **well-executed and on schedule**. The team has built a solid foundation with good architectural patterns. However, **several critical gaps** (test reset, CI/CD, documentation) need immediate attention to maintain momentum.

### Key Takeaways

✅ **Strong foundation:** Schema, edge functions, event system, Supabase client all working
⚠️ **Testing gaps:** No test reset, no CI/CD, combat tests failing
📚 **Documentation debt:** CLAUDE.md outdated, no runbooks, no changelog
🏗️ **Architecture refinements:** Add transactions, event retention, fix rate limit races

### Recommended Next Steps

1. **This week:** Focus on unblocking combat tests and adding CI/CD
2. **Next week:** Complete economy parity, performance benchmarks, documentation
3. **Week 4:** Standardize financial event tracking, stress tests, monitoring setup
4. **Week 5:** Rollback procedure, production readiness checklist

The migration is **on track to succeed** if these gaps are addressed proactively.

---

**End of Review**
