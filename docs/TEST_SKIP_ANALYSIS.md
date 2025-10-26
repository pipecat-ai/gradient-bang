# Test Skip Analysis

**Date**: 2025-10-26
**Analysis By**: Claude Code
**Test Run**: `uv run pytest tests -v`

## Executive Summary

**Documentation Claims**: 386 passing, 17 skipped (4.2% skip rate)
**Actual Results**: 309 passing, 94 skipped (23.3% skip rate)
**Discrepancy**: 77 additional skips not documented

The test suite has **94 skipped tests** across 7 integration test files. The largest issue is in `test_trading_system.py` where **all 33 trading tests skip** due to a test setup problem (characters with no map knowledge cannot find ports).

---

## Skip Breakdown by File

| File | Total Tests | Passing | Skipped | Skip % |
|------|------------|---------|---------|--------|
| test_trading_system.py | 35 | 2 | 33 | 94% 🔴 |
| test_event_system.py | 44 | 19 | 25 | 57% 🟡 |
| test_movement_system.py | 37 | 26 | 11 | 30% 🟡 |
| test_game_server_api.py | 25 | 16 | 9 | 36% 🟡 |
| test_async_game_client.py | 37 | 29 | 8 | 22% 🟢 |
| test_persistence.py | 26 | 19 | 7 | 27% 🟢 |
| test_combat_system.py | 36 | 35 | 1 | 3% 🟢 |
| **TOTAL** | **240** | **146** | **94** | **39%** |

Note: Unit tests (137 tests) all pass and are not included in this analysis.

---

## Root Cause Categories

### 1. TEST SETUP ISSUE 🔴 CRITICAL (33 tests)

**Impact**: Entire trading system untested
**Severity**: HIGH - These tests were intended to work but have broken test fixtures
**Effort to Fix**: LOW (1-2 hours)

#### All 33 Tests in test_trading_system.py:

**Skip Reason**: "No ports found within 5 hops for trading tests"

##### TestTradeOperations (6 tests):
- `test_buy_commodity_at_port`
- `test_sell_commodity_at_port`
- `test_buy_with_insufficient_credits_fails`
- `test_sell_with_insufficient_cargo_fails`
- `test_trade_exceeds_cargo_hold_fails`

##### TestPricingFormulas (6 tests):
- `test_buy_price_increases_with_demand`
- `test_sell_price_decreases_with_supply`
- `test_pricing_uses_sqrt_curve`
- `test_port_type_affects_base_price`
- `test_quantity_affects_total_price`
- `test_pricing_consistent_across_calls`

##### TestInventoryManagement (6 tests):
- `test_buy_increases_cargo_decreases_credits`
- `test_sell_decreases_cargo_increases_credits`
- `test_buy_decreases_port_stock`
- `test_sell_increases_port_stock`
- `test_cargo_hold_capacity_enforced`
- `test_inventory_state_consistent_after_trade`

##### TestAtomicityAndConcurrency (6 tests):
- `test_trade_transaction_atomic`
- `test_concurrent_trades_at_same_port_serialized`
- `test_port_lock_prevents_race_condition`
- `test_credit_lock_prevents_double_spend`
- `test_failed_trade_rolls_back_state`
- `test_server_crash_during_trade_recoverable`

##### TestPortRegeneration (3 tests):
- `test_port_stock_regenerates_over_time`
- `test_port_reset_restores_initial_stock`
- `test_port_stock_caps_at_maximum`

##### TestTradeEvents (4 tests):
- `test_trade_event_emitted_on_buy`
- `test_trade_event_emitted_on_sell`
- `test_trade_event_contains_pricing_info`
- `test_trade_event_logged_to_jsonl`

##### TestTradeEdgeCases (2 tests):
- `test_trade_invalid_commodity_fails`
- `test_trade_negative_quantity_fails`
- `test_trade_zero_quantity_fails`

#### Root Cause Analysis:

**File**: `tests/integration/test_trading_system.py:81-98`

```python
@pytest.fixture
async def trader_at_port(server_url):
    """Create a character at a port sector for trading."""
    char_id = "test_trader_at_port"
    client = AsyncGameClient(base_url=server_url, character_id=char_id)

    # Join game
    await client.join(character_id=char_id)

    # Find a port
    status = await get_status(client, char_id)

    # Look for nearby ports
    ports_result = await client.list_known_ports(character_id=char_id, max_hops=5)

    if not ports_result.get("ports"):
        await client.close()
        pytest.skip("No ports found within 5 hops for trading tests")  # ← SKIPS HERE
```

**Problem**: `list_known_ports()` queries the character's map knowledge file. Fresh characters have **zero map knowledge**, so no ports are found.

**Test Universe Ports** (from `tests/test-world-data/sector_contents.json`):
- Sector 1: Port BBS (Buys QF/RO, Sells NS) - 1 hop from start
- Sector 3: Port BSS (Buys QF, Sells RO/NS) - 2 hops from start
- Sector 5: Port BSB (Buys QF/NS, Sells RO) - 1 hop from start
- Sector 9: Port BBB (Buys QF/RO/NS, Sells nothing) - 3 hops from start

Ports exist and are reachable! The issue is map knowledge.

#### Fix Options:

**Option A: Pre-populate knowledge files**
```python
# In test setup, write to tests/test-world-data/character-map-knowledge/test_trader_at_port.json
{
  "sectors_visited": [0, 1, 3, 5, 9],
  "sector_details": {
    "1": {"has_port": true, "port_class": 1, ...},
    ...
  }
}
```
**Pros**: Fast, deterministic
**Cons**: Fragile (depends on file format), bypasses normal game flow

**Option B: Exploration phase in fixture**
```python
# Visit all sectors to discover ports
for sector_id in [1, 2, 3, 4, 5, 6, 7, 8, 9]:
    await client.move(to_sector=sector_id, character_id=char_id)
    await asyncio.sleep(1.0)
```
**Pros**: Tests real game behavior
**Cons**: Slow (~20-30 seconds per test), timing issues

**Option C: Helper function (RECOMMENDED)**
```python
from helpers.combat_helpers import create_test_character_knowledge

# Create character with pre-seeded knowledge
create_test_character_knowledge(
    "test_trader_at_port",
    sector=1,  # Start at port
    visited_sectors=[0, 1, 3, 5, 9],
    credits=10000
)
```
**Pros**: Clean, reusable, fast, leverages existing helper
**Cons**: None

#### Recommended Action:

1. Enhance `create_test_character_knowledge()` to accept `visited_sectors` list
2. Update fixture to pre-create character knowledge with all port sectors visited
3. Rerun tests - all 33 should now pass

**Estimated Effort**: 1-2 hours
**Expected Outcome**: +33 passing tests (309 → 342, skip rate 23% → 15%)

---

### 2. DEPRECATED ENDPOINTS (4 tests)

**Impact**: Minor - Alternative endpoints exist
**Severity**: LOW - Design decision, not a bug
**Effort to Fix**: N/A (permanent skips)

#### Tests Affected:

1. **test_async_game_client.py::test_map_cache_hit_on_repeated_calls**
   - Skip reason: "my_map endpoint is deprecated"
   - Replacement: `local_map_region()` provides equivalent functionality

2. **test_async_game_client.py::test_map_cache_miss_forces_refresh**
   - Skip reason: "Map caching implementation needs verification"
   - Related to deprecated my_map

3. **test_game_server_api.py::test_my_map_returns_knowledge**
   - Skip reason: "my_map endpoint deprecated, using local_map_region instead"
   - Direct endpoint test

4. **test_persistence.py::test_knowledge_cache_invalidation**
   - Skip reason: "my_map endpoint no longer exists"
   - Cache invalidation for removed endpoint

5. **test_persistence.py::test_knowledge_schema_compatible**
   - Skip reason: "my_map endpoint structure changed"
   - Supabase migration test for old endpoint

#### Design Context:

The `my_map` endpoint was replaced with more efficient alternatives:
- `local_map_region()` - Get sectors around current location
- `list_known_ports()` - Find ports within travel range
- `path_with_region()` - Get path with surrounding context

#### Recommended Action:

- Add permanent skip decorators with explanation
- Update documentation to note endpoint deprecation
- Consider writing replacement tests for new endpoints if coverage gaps exist

---

### 3. FEATURES NOT YET IMPLEMENTED (6 tests)

**Impact**: Medium - Missing some game features
**Severity**: LOW - Future roadmap items
**Effort to Fix**: HIGH (requires server implementation)

#### Messaging System (2 tests):

1. **test_game_server_api.py::test_send_message_to_character**
   - Skip reason: "send_message endpoint not yet implemented"
   - Feature: Private messages between characters

2. **test_game_server_api.py::test_broadcast_message_to_sector**
   - Skip reason: "broadcast_message endpoint not yet implemented"
   - Feature: Sector-wide announcements

#### Admin/Query Endpoints (2 tests):

3. **test_game_server_api.py::test_character_list_returns_all_characters**
   - Skip reason: "character_list endpoint needs verification"
   - Feature: List all characters in game

4. **test_game_server_api.py::test_whois_returns_character_info**
   - Skip reason: "whois endpoint not yet implemented"
   - Feature: Query character details by ID

#### Game State Endpoints (2 tests):

5. **test_game_server_api.py::test_my_inventory_returns_cargo**
   - Skip reason: "my_inventory endpoint not yet implemented"
   - Note: Status endpoint already includes cargo, dedicated endpoint may be redundant

6. **test_game_server_api.py::test_combat_status_shows_round_state**
   - Skip reason: "Combat status endpoint needs implementation verification"
   - Feature: Query active combat state

#### Recommended Action:

- Leave skipped until features are prioritized
- Document in product roadmap
- Consider if `my_inventory` is needed (status already has cargo)

---

### 4. TESTING LIMITATIONS (8 tests)

**Impact**: Low - Edge cases and infrastructure gaps
**Severity**: LOW - Acceptable test coverage gaps
**Effort to Fix**: MEDIUM (requires test infrastructure)

#### Warp Power Tests (3 tests):

1. **test_async_game_client.py::test_recharge_warp_power**
2. **test_game_server_api.py::test_recharge_warp_power_at_sector_zero**
   - Skip reason: "New characters start with full warp power, cannot test recharge"
   - Limitation: Would need pre-created characters with depleted warp

3. **test_movement_system.py::test_move_with_insufficient_warp_power_fails**
4. **test_movement_system.py::test_move_with_zero_warp_power**
   - Skip reason: "Warp power depletion needs character state setup"
   - Limitation: Same issue - need depleted characters

#### Client Behavior Tests (2 tests):

5. **test_async_game_client.py::test_retry_logic_on_transient_errors**
   - Skip reason: "Retry logic not implemented in AsyncGameClient"
   - Design decision: Client doesn't auto-retry 502/503 errors

6. **test_async_game_client.py::test_malformed_response_raises_error**
   - Skip reason: "Malformed response testing requires mock server"
   - Infrastructure gap: No mock server for error injection

#### Map Caching Tests (3 tests):

7. **test_async_game_client.py::test_cache_stores_discovered_ports**
   - Skip reason: "Port discovery tracking needs server-side endpoint"

8. **test_async_game_client.py::test_cache_invalidation_on_join**
   - Skip reason: "Join does not reset character position by design"

9. **test_async_game_client.py::test_cache_shared_across_client_instances**
   - Skip reason: "Cache sharing across client instances not implemented (per-client cache design)"

#### Recommended Action:

- Document as acceptable gaps
- Warp tests: Consider creating fixture for depleted characters if coverage needed
- Retry logic: Document design decision in client docs
- Mock server: Low priority unless critical error paths are untested

---

### 5. COMPLEX SETUP REQUIRED (43 tests)

**Impact**: Medium - Missing advanced scenario coverage
**Severity**: MEDIUM - Some important flows untested
**Effort to Fix**: HIGH (multi-hour implementation per test)

#### Event System Tests (25 tests)

##### Event Emission Tests (10 tests - require full game scenarios):

1. `test_combat_started_event` - "Requires combat initiation with 2+ characters"
2. `test_combat_round_ended_event` - "Requires combat setup and action submission"
3. `test_combat_ended_event` - "Requires complete combat scenario"
4. `test_trade_completed_event` - "Requires port navigation and trade execution"
5. `test_garrison_created_event` - "Requires garrison creation scenario"
6. `test_salvage_created_event` - "Requires ship destruction in combat"
7. `test_ship_destroyed_event` - "Requires ship destruction scenario"

**Issue**: These tests were written as unit-style event tests but actually require full integration scenarios. Combat tests in `test_combat_system.py` already validate these events comprehensively.

**Recommendation**: Mark as duplicate coverage, skip permanently, or refactor to use combat test helpers.

##### Event Filtering Tests (10 tests - require multi-character coordination):

8. `test_private_events_only_to_character` - "Requires character-specific event filtering"
9. `test_public_events_to_all_in_sector` - "Firehose receives no events without character filter"
10. `test_combat_events_to_participants_only` - "Requires combat with non-participant observers"
11. `test_trade_events_private_to_trader` - "Requires character-specific trade event filtering"
12. `test_message_events_to_recipient_and_sender` - "Requires messaging implementation"
13. `test_movement_events_visible_to_sector_occupants` - "Requires multi-character sector observation"
14. `test_garrison_events_filtered_correctly` - "Requires garrison + character filtering"
15. `test_salvage_events_visible_to_sector` - "Requires salvage + sector observers"
16. `test_error_events_only_to_character` - "Requires character-specific error scenarios"

**Issue**: Event filtering logic needs comprehensive multi-character test infrastructure.

**Recommendation**: HIGH PRIORITY - Create event filtering test suite with shared multi-character fixtures.

##### JSONL Logging Tests (6 tests - require server file access):

17. `test_events_logged_to_jsonl_file` - "Requires server log file access"
18. `test_jsonl_one_event_per_line` - "Requires server log file access"
19. `test_jsonl_append_only` - "Requires server log file access"
20. `test_jsonl_survives_server_restart` - "Requires server restart mechanism"
21. `test_jsonl_readable_and_parseable` - "Requires server log file access"
22. `test_jsonl_log_rotation` - "Requires log rotation configuration"

**Issue**: Tests need to read test server's event-log.jsonl file directly.

**Recommendation**: MEDIUM PRIORITY - Add fixture to read test server logs, verify event persistence.

##### Edge Case Tests (2 tests):

23. `test_event_immutable_after_emission` - "Requires event mutation testing"
24. `test_event_emission_during_server_shutdown` - "Requires server shutdown coordination"
25. `test_event_with_special_characters_in_payload` - "Requires special character handling"

**Recommendation**: LOW PRIORITY - Edge cases, nice to have.

---

#### Movement System Tests (11 tests)

##### Garrison Combat Tests (6 tests):

1. `test_arrival_triggers_garrison_combat` - "Garrison combat on arrival needs implementation"
2. `test_garrison_combat_started_event_emitted` - "Requires garrison combat scenario"
3. `test_character_enters_combat_state_on_arrival` - "Requires garrison combat state machine"
4. `test_arrival_blocked_if_already_in_combat` - "Requires character already in combat"
5. `test_garrison_auto_attack_on_arrival` - "Requires garrison auto-attack implementation"

**Issue**: Movement system should trigger combat when arriving at garrisoned sectors. Tests were written before feature implemented.

**Status**: Feature appears to be implemented (combat tests validate garrison scenarios). These may be duplicate coverage.

**Recommendation**: Review garrison combat in `test_combat_system.py`, mark as duplicate or update to test movement-specific aspects.

##### Edge Case Tests (3 tests):

6. `test_move_after_ship_destruction` - "Ship destruction mechanics need verification"
7. `test_move_with_insufficient_warp_power_fails` - "Character state setup needed"
8. `test_move_with_zero_warp_power` - "Warp power depletion needs setup"

**Recommendation**: LOW PRIORITY - Covered in "Testing Limitations" category above.

##### Logging Tests (2 tests):

9. `test_hyperspace_events_filtered_by_character` - "Character-specific event filtering needed"
10. `test_move_events_logged_to_jsonl` - "JSONL log validation needed"

**Recommendation**: Similar to event system JSONL tests above.

---

#### Persistence Tests (7 tests)

##### Garrison Persistence Tests (3 tests):

1. `test_offensive_garrison_auto_engages_newcomer` - "Auto-engagement scenario setup needed"
2. `test_destroyed_toll_garrison_awards_bank_to_victor` - "Toll bank distribution needs verification"
3. `test_salvage_collection_emits_event` - "Requires test salvage setup"

**Issue**: Complex multi-step scenarios (garrison creation → combat → destruction → loot).

**Recommendation**: MEDIUM PRIORITY - Important game mechanics, but covered partially in combat tests.

##### Cache Coherence Tests (2 tests):

4. `test_port_state_persistence` - "Status structure doesn't include port inventory details"
5. `test_incomplete_trade_rollback` - "Status structure inconsistencies"

**Issue**: API response structure changed, tests need updates.

**Recommendation**: HIGH PRIORITY - Fix test assertions to match current API structure.

##### Transit Edge Case (1 test):

6. `test_transit_interruption_handling` - "Transit interruption handling not implemented"

**Issue**: What happens if character disconnects mid-hyperspace jump?

**Recommendation**: LOW PRIORITY - Rare edge case.

##### Combat System Test (1 test):

7. **test_combat_system.py::test_shields_recharged_per_round**
   - Skip reason: "Combat ended before shields could recharge"
   - Issue: Test design problem - combat ends too quickly

**Recommendation**: LOW PRIORITY - Adjust test to use lower damage values for longer combat.

---

## Priority Matrix

| Priority | Tests | Category | Effort | Impact |
|----------|-------|----------|--------|--------|
| 🔴 **P0** | 33 | Trading test setup | 1-2 hours | Unlocks entire trading suite |
| 🟡 **P1** | 10 | Event filtering tests | 4-6 hours | Critical game mechanic |
| 🟡 **P1** | 2 | Persistence API fixes | 1-2 hours | Quick fixes |
| 🟢 **P2** | 6 | JSONL logging tests | 2-3 hours | Important for audit trail |
| 🟢 **P2** | 3 | Garrison mechanics | 3-4 hours | May be duplicate coverage |
| ⚪ **P3** | 4 | Deprecated endpoints | 0 hours | Document only |
| ⚪ **P3** | 6 | Feature not implemented | N/A | Future roadmap |
| ⚪ **P3** | 8 | Testing limitations | N/A | Acceptable gaps |
| ⚪ **P3** | 22 | Low-priority edge cases | 10+ hours | Nice to have |

---

## Recommended Action Plan

### Phase 1: Quick Wins (2-4 hours) → +35 tests

1. **Fix Trading Tests (33 tests)**
   - Enhance `create_test_character_knowledge()` helper
   - Pre-seed character knowledge with port sectors
   - Rerun trading suite
   - **Outcome**: 309 → 342 passing (15% skip rate)

2. **Fix Persistence API Tests (2 tests)**
   - Update assertions for current API structure
   - Fix `test_port_state_persistence` and `test_incomplete_trade_rollback`
   - **Outcome**: 342 → 344 passing

### Phase 2: High-Value Tests (6-10 hours) → +15 tests

3. **Event Filtering Suite (10 tests)**
   - Create multi-character test fixtures
   - Test character-specific event delivery
   - Validate firehose vs character-filtered events
   - **Outcome**: 344 → 354 passing

4. **JSONL Logging Tests (5 tests)**
   - Add fixture to read test server logs
   - Validate event persistence format
   - **Outcome**: 354 → 359 passing

### Phase 3: Documentation (1-2 hours)

5. **Document Permanent Skips (14 tests)**
   - Deprecated endpoints (4)
   - Features not implemented (6)
   - Testing limitations (4)
   - Update TEST_COVERAGE_COMPARISON.md

6. **Update Coverage Docs**
   - Accurate test counts
   - Skip reason analysis
   - Testing roadmap

### Phase 4: Future Work (Optional, 15+ hours)

7. **Garrison Combat Integration (6 tests)**
8. **Edge Cases & Advanced Scenarios (15+ tests)**

---

## Expected Outcomes

### After Phase 1-2 (12-14 hours of work):
- **359 passing / 44 skipped** (11% skip rate)
- Trading system fully tested
- Event filtering validated
- Audit logging verified

### After Documentation Phase:
- Accurate project status
- Clear testing roadmap
- Documented acceptable gaps

### Long-term Target:
- **380+ passing / <25 skipped** (<6% skip rate)
- Requires feature implementation (messaging, admin endpoints)
- Advanced edge case coverage

---

## Conclusion

The test suite documentation was severely out of date. The actual skip rate is **23.3%** (94 tests), not 4.2% (17 tests).

**Root causes**:
1. **Test setup issue** (33 tests) - Fixable in 1-2 hours 🔴
2. **Deprecated endpoints** (4 tests) - Document and skip ⚪
3. **Features not implemented** (6 tests) - Future roadmap ⚪
4. **Testing limitations** (8 tests) - Acceptable gaps ⚪
5. **Complex setup required** (43 tests) - Prioritize by value 🟡

**Immediate action**: Fix trading tests to unlock 33 tests. This is a HIGH IMPACT, LOW EFFORT fix that will improve skip rate from 23% → 15% in 1-2 hours of work.
