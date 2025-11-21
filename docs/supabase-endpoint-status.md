# Supabase Migration: RPC Endpoint Implementation Status

**Last Updated:** 2025-11-09
**Source Analysis:** Legacy FastAPI server (`game-server/server.py`) vs Supabase edge functions

---

## Status Legend

- ✅ **COMPLETE** - Edge function exists, AsyncGameClient method exists, tests passing
- 🟡 **PARTIAL** - Edge function exists but missing tests or client method
- 🔴 **NOT STARTED** - No edge function implementation yet
- ⚠️ **BLOCKED** - Depends on other unfinished work

---

## 1. Core Navigation & Status (7 endpoints)

| Legacy Endpoint | Status | Edge Function | Client Method | Tests | Notes |
|----------------|--------|---------------|---------------|-------|-------|
| `join` | ✅ COMPLETE | `join/index.ts` | ✅ Inherited | ✅ `test_join.py` | Fully working |
| `my_status` | ✅ COMPLETE | `my_status/index.ts` | ✅ Inherited | ✅ `test_my_status.py` | Fully working |
| `move` | ✅ COMPLETE | `move/index.ts` | ✅ Inherited | ✅ `test_move_and_map.py` | Integration tests pass |
| `plot_course` | ✅ COMPLETE | `plot_course/index.ts` | ✅ Inherited | ✅ `test_plot_course.py` | Fully working |
| `local_map_region` | ✅ COMPLETE | `local_map_region/index.ts` | ✅ Inherited | ✅ `test_move_and_map.py` | Tested with move |
| `list_known_ports` | ✅ COMPLETE | `list_known_ports/index.ts` | ✅ Inherited | 🟡 Partial | Needs dedicated test |
| `path_with_region` | ✅ COMPLETE | `path_with_region/index.ts` | ✅ Inherited | ✅ `test_path_with_region.py` | Fully working |

**Summary:** 7/7 complete (100%)

---

## 2. Trading & Economy (8 endpoints)

| Legacy Endpoint | Status | Edge Function | Client Method | Tests | Notes |
|----------------|--------|---------------|---------------|-------|-------|
| `trade` | ✅ COMPLETE | `trade/index.ts` | ✅ Inherited | ✅ `test_trade.py` | Port locking works |
| `purchase_fighters` | ✅ COMPLETE | `purchase_fighters/index.ts` | ✅ Inherited | ✅ `test_purchase_fighters.py` | Fighter armory working |
| `ship.purchase` | ✅ COMPLETE | `ship_purchase/index.ts` | `purchase_ship()` ✅ | ✅ `test_ship_purchase.py` | Corp purchases work |
| `dump_cargo` | ✅ COMPLETE | `dump_cargo/index.ts` | ✅ Inherited | ✅ `test_dump_cargo.py` | Salvage creation works |
| `recharge_warp_power` | ✅ COMPLETE | `recharge_warp_power/index.ts` | ✅ Inherited | ✅ `test_warp_power.py` | Fuel at sector 0 |
| `transfer_warp_power` | ✅ COMPLETE | `transfer_warp_power/index.ts` | ✅ Inherited | ✅ `test_warp_power.py` | Ship-to-ship fuel |
| `transfer_credits` | ✅ COMPLETE | `transfer_credits/index.ts` | ✅ Inherited | ✅ `test_credits.py` | Character-to-character |
| `bank_transfer` | ✅ COMPLETE | `bank_transfer/index.ts` | See note | ✅ `test_credits.py` | Uses `deposit_to_bank()` / `withdraw_from_bank()` |

**Summary:** 8/8 complete (100%)

**Note on bank_transfer:** Legacy client has two separate methods (`deposit_to_bank`, `withdraw_from_bank`) that both call the `bank_transfer` edge function with different payloads.

---

## 3. Combat System (8 endpoints)

| Legacy Endpoint | Status | Edge Function | Client Method | Tests | Notes |
|----------------|--------|---------------|---------------|-------|-------|
| `combat.initiate` | 🟡 PARTIAL | `combat_initiate/index.ts` | ✅ Overridden in Supabase client | 🔴 No dedicated test | Edge function exists, needs testing |
| `combat.action` | 🟡 PARTIAL | `combat_action/index.ts` | ✅ Overridden in Supabase client | 🔴 No dedicated test | Edge function exists, needs testing |
| `combat.leave_fighters` | 🔴 NOT STARTED | ❌ Missing | ✅ Inherited | 🔴 No test | Garrison deploy not implemented |
| `combat.collect_fighters` | 🔴 NOT STARTED | ❌ Missing | ✅ Inherited | 🔴 No test | Garrison collect not implemented |
| `combat.set_garrison_mode` | 🔴 NOT STARTED | ❌ Missing | ✅ Inherited | 🔴 No test | Garrison mode (toll/offensive/defensive) |
| `salvage.collect` | 🔴 NOT STARTED | ❌ Missing | ✅ Inherited | 🔴 No test | Picking up salvage containers |
| `combat_tick` (internal) | 🟡 PARTIAL | `combat_tick/index.ts` | N/A (server-side) | 🔴 No test | Background tick handler exists |
| *(Auto-engage)* | ⚠️ BLOCKED | In `move/index.ts`? | N/A | 🔴 No test | Combat auto-engage on move not verified |

**Summary:** 2/8 partial, 4/8 not started (25% complete)

**Critical Gap:** The entire garrison system (deploy, collect, modes) is missing from Supabase. This blocks:
- Garrison deployment tests
- Toll collection tests
- Corporation fleet positioning
- Combat test suite (depends on garrison setup)

---

## 4. Corporation Management (8 endpoints)

| Legacy Endpoint | Status | Edge Function | Client Method | Tests | Notes |
|----------------|--------|---------------|---------------|-------|-------|
| `corporation.create` | ✅ COMPLETE | `corporation_create/index.ts` | `create_corporation()` ✅ | 🟡 Partial (`tests/edge/test_corporations.py`) | Deducts credits, emits `corporation.created` |
| `corporation.join` | ✅ COMPLETE | `corporation_join/index.ts` | `join_corporation()` ✅ | 🟡 Partial (`tests/edge/test_corporations.py`) | Invite code validation + events |
| `corporation.leave` | ✅ COMPLETE | `corporation_leave/index.ts` | `leave_corporation()` ✅ | 🟡 Partial (`tests/edge/test_corporations.py`) | Handles disband + abandoned ships |
| `corporation.kick` | ✅ COMPLETE | `corporation_kick/index.ts` | `kick_corporation_member()` ✅ | 🟡 Partial (`tests/edge/test_corporations.py`) | Sends `corporation.member_kicked` |
| `corporation.info` | ✅ COMPLETE | `corporation_info/index.ts` | Inherited | 🟡 Partial (`tests/edge/test_corporations.py`) | Public vs member payloads |
| `corporation.list` | ✅ COMPLETE | `corporation_list/index.ts` | `list_corporations()` ✅ | 🟡 Partial (`tests/edge/test_corporations.py`) | Sorted summaries w/ counts |
| `corporation.regenerate_invite_code` | ✅ COMPLETE | `corporation_regenerate_invite_code/index.ts` | Inherited | 🟡 Partial (`tests/edge/test_corporations.py`) | Broadcasts new code |
| `my.corporation` | ✅ COMPLETE | `my_corporation/index.ts` | Inherited | 🟡 Partial (`tests/edge/test_corporations.py`) | Member payload w/ `joined_at` |

**Summary:** 8/8 complete (100%)

**Note:** Edge coverage for create/join/leave/kick/info/list/regenerate/my endpoints lives in `tests/edge/test_corporations.py`. Integration suites will be ungated once Supabase stack runs in CI.

---

## 5. Character Management (3 endpoints)

| Legacy Endpoint | Status | Edge Function | Client Method | Tests | Notes |
|----------------|--------|---------------|---------------|-------|-------|
| `character.create` | 🔴 NOT STARTED | ❌ Missing | `character_create()` ✅ | 🔴 No test | Admin-only |
| `character.modify` | 🔴 NOT STARTED | ❌ Missing | `character_modify()` ✅ | 🔴 No test | Admin-only |
| `character.delete` | 🔴 NOT STARTED | ❌ Missing | `character_delete()` ✅ | 🔴 No test | Admin-only, CASCADE behavior exists |

**Summary:** 0/3 complete (0%)

**Note:** These are admin-only endpoints rarely used in production. Low priority. Character creation currently happens implicitly via `join` edge function.

---

## 6. Admin & Utility (7 endpoints)

| Legacy Endpoint | Status | Edge Function | Client Method | Tests | Notes |
|----------------|--------|---------------|---------------|-------|-------|
| `test.reset` | ✅ COMPLETE | `test_reset/index.ts` | `test_reset()` ✅ | ✅ `test_test_reset.py` | Supabase DB truncation + reseed |
| `server_status` | 🔴 NOT STARTED | ❌ Missing | `server_status()` ✅ | 🔴 No test | Health check endpoint |
| `event.query` | ✅ COMPLETE | `event_query/index.ts` | `event_query()` ✅ | ✅ `test_event_query.py` | Query events table, JSONL parity |
| `send_message` | 🔴 NOT STARTED | ❌ Missing | `send_message()` ✅ | 🔴 No test | Chat/messaging system |
| `reset_ports` | 🔴 NOT STARTED | ❌ Missing | N/A | 🔴 No test | Admin utility, low priority |
| `regenerate_ports` | 🔴 NOT STARTED | ❌ Missing | N/A | 🔴 No test | Admin utility, low priority |
| `leaderboard.resources` | 🔴 NOT STARTED | ❌ Missing | `leaderboard_resources()` ✅ | 🔴 No test | Wealth leaderboard snapshot |

**Summary:** 2/7 complete (29%)

**Critical Missing:**
- `leaderboard.resources` - Mentioned in plan §4.5

---

## Overall Status Summary

| Category | Complete | Partial | Not Started | Total | % Complete |
|----------|----------|---------|-------------|-------|------------|
| Core Navigation | 7 | 0 | 0 | 7 | 100% |
| Trading & Economy | 8 | 0 | 0 | 8 | 100% |
| Combat System | 0 | 2 | 6 | 8 | 25% |
| Corporation Mgmt | 8 | 0 | 0 | 8 | 100% |
| Character Mgmt | 0 | 0 | 3 | 3 | 0% |
| Admin & Utility | 2 | 0 | 5 | 7 | 29% |
| **TOTAL** | **25** | **2** | **14** | **41** | **61%** |

---

## Priority Recommendations

### 🚨 URGENT (Week 2)

**1. `test.reset` edge function**
- **Status:** ✅ Implemented via `test_reset/index.ts`
- **Effort:** 1-2 days (complete)
- **Dependencies:** None
- **Notes:** Supabase-edge reset now mirrors FastAPI workflow and feeds the AsyncGameClient path

**2. Garrison endpoints (3 functions)**
- `combat.leave_fighters` (garrison deploy)
- `combat.collect_fighters` (garrison collect)
- `combat.set_garrison_mode` (toll/offensive/defensive)
- **Status:** BLOCKING combat test suite
- **Effort:** 2-3 days
- **Dependencies:** Observer event emission (partial - see review §2A)

**3. `salvage.collect` endpoint**
- **Status:** Needed for salvage test coverage
- **Effort:** 1 day
- **Dependencies:** None (salvage creation via `dump_cargo` already works)

### ⚠️ HIGH PRIORITY (Week 3)

**4. Corporation endpoints (8 functions)**
- All corp management RPCs
- **Status:** Schema ready, RPCs missing
- **Effort:** 3-4 days
- **Dependencies:** None (schema complete)
- **Note:** Can be done in parallel with garrison work

**5. `event.query` endpoint**
- **Status:** ✅ Implemented via `event_query/index.ts` + `test_event_query.py`
- **Effort:** 1 day (complete)
- **Dependencies:** Events table (already exists)

**6. Add combat tests**
- Once garrison endpoints exist, add `tests/edge/test_combat.py`
- Cover: initiate, actions, flee, auto-engage, garrison modes

### 📊 MEDIUM PRIORITY (Week 4)

**7. `leaderboard.resources` endpoint**
- Mentioned in migration plan §4.5
- Needs Supabase-backed snapshot storage

**8. Character management endpoints**
- Admin-only, rarely used
- Can defer until Week 5

### 🔧 LOW PRIORITY (Week 5+)

**9. Admin utilities**
- `reset_ports`, `regenerate_ports` - Admin-only
- `server_status` - Nice to have for health checks
- `send_message` - Chat system (future feature)

---

## Implementation Notes

### Edge Function Status

**Existing functions (26 total):**
```
✅ bank_transfer          ✅ local_map_region       ✅ purchase_fighters
✅ combat_action          ✅ move                   ✅ recharge_warp_power
✅ combat_initiate        ✅ my_status              ✅ ship_purchase
✅ combat_tick            ✅ path_with_region       ✅ trade
✅ dump_cargo             ✅ plot_course            ✅ transfer_credits
✅ join                   ✅ list_known_ports       ✅ transfer_warp_power
✅ corporation_create     ✅ corporation_join       ✅ corporation_leave
✅ corporation_kick       ✅ corporation_info       ✅ corporation_list
✅ corporation_regenerate_invite_code ✅ my_corporation
```

**Missing functions (13 total):**
```
❌ combat_leave_fighters           ❌ character_create
❌ combat_collect_fighters         ❌ character_modify
❌ combat_set_garrison_mode        ❌ character_delete
❌ salvage_collect                 ❌ send_message
❌ corporation_delete              ❌ reset_ports
❌ corporation_modify              ❌ regenerate_ports
❌ server_status                   ❌ leaderboard_resources
```

### Test Coverage

**Edge tests exist (13 test files):**
- `test_join.py`
- `test_my_status.py`
- `test_move_and_map.py`
- `test_plot_course.py`
- `test_path_with_region.py`
- `test_trade.py`
- `test_purchase_fighters.py`
- `test_ship_purchase.py`
- `test_dump_cargo.py`
- `test_warp_power.py` (covers recharge + transfer)
- `test_credits.py` (covers transfer_credits + bank_transfer)
- `test_supabase_client_integration.py`
- `conftest.py`

**Missing tests:**
- Combat system (initiate, action, garrison, salvage)
- Character management (all 3 endpoints)
- Admin utilities (test.reset, send_message, leaderboard, etc.)

**New tests:**
- `tests/edge/test_corporations.py` exercises create/join/leave/kick/info/list/regenerate/my flows (requires Supabase stack)

### Client Method Status

**Supabase AsyncGameClient** (in `utils/supabase_client.py`):
- Extends `LegacyAsyncGameClient` from `utils/api_client.py`
- Inherits all 40+ methods from legacy client
- Overrides: `combat_initiate`, `combat_action`, `_request`, `_send_command`
- All other methods work via inheritance (call edge functions via `_request`)

**Key insight:** Most methods "just work" because the Supabase client inherits them and routes through the edge functions transparently. The missing pieces are the edge functions themselves, not the client methods.

---

## Next Steps

1. **Immediate (This Week):**
   - Implement `test.reset` edge function (BLOCKING)
   - Implement garrison endpoints (3 functions)
   - Implement `salvage.collect`
   - Add combat edge tests

2. **Week 3:**
   - Implement all 8 corporation endpoints
   - Add corporation edge tests

3. **Week 4:**
   - Implement `leaderboard.resources`
   - Implement character management endpoints
   - Add integration test parity for all new endpoints

4. **Week 5+:**
   - Implement remaining admin utilities
   - Consider `send_message` for chat system
   - Final polish and documentation

---

**End of Status Report**
