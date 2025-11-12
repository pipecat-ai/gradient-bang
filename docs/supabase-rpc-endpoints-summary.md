# Supabase RPC Endpoints: Implementation Status Summary

**Last Updated:** 2025-11-09
**Total Endpoints:** 41
**Complete:** 17 (41%)
**Remaining:** 24 (59%)

---

## Quick Stats

```
████████████████░░░░░░░░░░░░░░░░░░░░  41% Complete

✅ Complete:     17 endpoints
🟡 Partial:       2 endpoints (edge functions exist, need tests)
🔴 Not Started:  22 endpoints

Work Remaining:  24 endpoints total
```

---

## By Priority

### 🚨 HIGH PRIORITY (Core Gameplay)

**Garrison/Salvage (4 endpoints) - BLOCKING combat tests**
- [ ] combat.leave_fighters (deploy garrison)
- [ ] combat.collect_fighters (recall garrison)
- [ ] combat.set_garrison_mode (toll/offensive/defensive)
- [ ] salvage.collect (pick up salvage containers)

**Combat Tests (0 endpoints, but need tests for 2 existing)**
- [ ] Add edge tests for combat.initiate
- [ ] Add edge tests for combat.action

**Estimate:** 1 week (garrison endpoints + combat tests)

---

### ⚠️ MEDIUM PRIORITY (Multiplayer Features)

**Corporation Management (8 endpoints)**
- [ ] corporation.create
- [ ] corporation.join (with invite code)
- [ ] corporation.leave
- [ ] corporation.kick (admin-only)
- [ ] corporation.info (get corp details)
- [ ] corporation.list (list all corps)
- [ ] corporation.regenerate_invite_code
- [ ] my.corporation (get my corp membership)

**Note:** Database schema is 100% complete, just need the RPC wrappers.

**Estimate:** 1 week

---

### 📊 LOW PRIORITY (Admin/Utilities)

**Leaderboard (1 endpoint)**
- [ ] leaderboard.resources (wealth rankings)

**Character Admin (3 endpoints - rarely used)**
- [ ] character.create
- [ ] character.modify
- [ ] character.delete

**Port Admin (2 endpoints - admin-only)**
- [ ] reset_ports
- [ ] regenerate_ports

**Messaging (1 endpoint - future feature)**
- [ ] send_message (chat system)

**Health Check (1 endpoint - nice-to-have)**
- [ ] server_status

**Estimate:** 1 week (if needed)

---

## Completion Roadmap

### ✅ DONE (Week 0-2)
- Core navigation (7 endpoints)
- Trading & economy (8 endpoints)
- Test infrastructure (test.reset, event.query)

### 🎯 Week 3 (Current Focus)
- [ ] Garrison endpoints (4)
- [ ] Combat edge tests (2)
- [ ] salvage.collect (1)

**Target:** 24/41 complete (59%)

### 📅 Week 4
- [ ] Corporation endpoints (8)

**Target:** 32/41 complete (78%)

### 📅 Week 5 (Polish)
- [ ] Leaderboard (1)
- [ ] Character admin (3)
- [ ] Optional: Messaging, port admin, health check

**Target:** 36-41/41 complete (88-100%)

---

## Implementation Effort Estimates

| Category | Endpoints | Est. Days | Rationale |
|----------|-----------|-----------|-----------|
| Garrison/Salvage | 4 | 3-4 days | Shared modules exist, need RPC wrappers + tests |
| Combat Tests | 0 (tests only) | 2 days | Edge functions exist, need comprehensive tests |
| Corporation | 8 | 4-5 days | Schema ready, straightforward CRUD operations |
| Leaderboard | 1 | 1 day | Snapshot logic exists in FastAPI, need port |
| Character Admin | 3 | 1-2 days | Simple CRUD, rarely used |
| Messaging | 1 | 2-3 days | Requires message store integration |
| Port Admin | 2 | 1 day | Low priority, simple operations |
| Health Check | 1 | 1 hour | Trivial |

**Total remaining effort:** ~15-20 days (3-4 weeks)

---

## Detailed Status by Endpoint

### Core Navigation & Map (7/7 ✅ 100%)

| Endpoint | Status | Edge Function | Tests |
|----------|--------|---------------|-------|
| join | ✅ | join/index.ts | test_join.py (3 tests) |
| my_status | ✅ | my_status/index.ts | test_my_status.py (3 tests) |
| move | ✅ | move/index.ts | test_move_and_map.py (4 tests) |
| plot_course | ✅ | plot_course/index.ts | test_plot_course.py (2 tests) |
| local_map_region | ✅ | local_map_region/index.ts | test_move_and_map.py |
| list_known_ports | ✅ | list_known_ports/index.ts | test_move_and_map.py |
| path_with_region | ✅ | path_with_region/index.ts | test_path_with_region.py (2 tests) |

---

### Trading & Economy (8/8 ✅ 100%)

| Endpoint | Status | Edge Function | Tests |
|----------|--------|---------------|-------|
| trade | ✅ | trade/index.ts | test_trade.py (3 tests) |
| purchase_fighters | ✅ | purchase_fighters/index.ts | test_purchase_fighters.py (3 tests) |
| ship.purchase | ✅ | ship_purchase/index.ts | test_ship_purchase.py (4 tests) |
| dump_cargo | ✅ | dump_cargo/index.ts | test_dump_cargo.py (2 tests) |
| recharge_warp_power | ✅ | recharge_warp_power/index.ts | test_warp_power.py (4 tests) |
| transfer_warp_power | ✅ | transfer_warp_power/index.ts | test_warp_power.py |
| transfer_credits | ✅ | transfer_credits/index.ts | test_credits.py (3 tests) |
| bank_transfer | ✅ | bank_transfer/index.ts | test_credits.py |

---

### Combat System (2/8 🟡 25%)

| Endpoint | Status | Edge Function | Tests |
|----------|--------|---------------|-------|
| combat.initiate | 🟡 Partial | combat_initiate/index.ts | ❌ None |
| combat.action | 🟡 Partial | combat_action/index.ts | ❌ None |
| combat_tick | 🟡 Partial | combat_tick/index.ts | ❌ None (internal) |
| combat.leave_fighters | ❌ Not Started | - | - |
| combat.collect_fighters | ❌ Not Started | - | - |
| combat.set_garrison_mode | ❌ Not Started | - | - |
| salvage.collect | ❌ Not Started | - | - |
| *(auto-engage on move)* | ❌ Untested | In move/index.ts | - |

**Blockers:** Garrison endpoints needed for full combat test coverage

---

### Corporation Management (0/8 ❌ 0%)

| Endpoint | Status | Notes |
|----------|--------|-------|
| corporation.create | ❌ | Schema ready |
| corporation.join | ❌ | Schema ready, invite code validation needed |
| corporation.leave | ❌ | Schema ready |
| corporation.kick | ❌ | Schema ready, admin check needed |
| corporation.info | ❌ | Schema ready |
| corporation.list | ❌ | Schema ready |
| corporation.regenerate_invite_code | ❌ | Schema ready |
| my.corporation | ❌ | Schema ready |

**Note:** All schema tables exist (corporations, corporation_members, corporation_ships), just need RPC wrappers.

---

### Character Management (0/3 ❌ 0%)

| Endpoint | Status | Notes |
|----------|--------|-------|
| character.create | ❌ | Admin-only, rarely used |
| character.modify | ❌ | Admin-only, rarely used |
| character.delete | ❌ | Admin-only, CASCADE exists |

**Note:** Low priority - character creation happens implicitly via join (for players) or test_reset (for tests).

---

### Admin & Utility (2/7 🟡 29%)

| Endpoint | Status | Edge Function | Tests |
|----------|--------|---------------|-------|
| test.reset | ✅ | test_reset/index.ts | test_test_reset.py (3 tests) |
| event.query | ✅ | event_query/index.ts | test_event_query.py (4 tests) |
| server_status | ❌ | - | - |
| send_message | ❌ | - | - |
| reset_ports | ❌ | - | - |
| regenerate_ports | ❌ | - | - |
| leaderboard.resources | ❌ | - | - |

---

## Test Coverage

**Edge tests:** 40 tests across 14 files (~2100 lines)

**Coverage by category:**
- ✅ Core Navigation: Excellent (all endpoints tested)
- ✅ Trading & Economy: Excellent (all endpoints tested)
- ❌ Combat: None (edge functions exist but untested)
- ❌ Corporation: None (no edge functions yet)
- ✅ Admin: Good (test.reset, event.query tested)

**Missing tests:**
- combat.initiate edge tests
- combat.action edge tests
- All garrison/salvage tests (endpoints don't exist yet)
- All corporation tests (endpoints don't exist yet)

---

## Next Actions

### This Week
1. ✅ Test reset infrastructure (DONE)
2. ✅ Event query endpoint (DONE)
3. ✅ Join refactor (DONE)
4. **TODO:** Garrison endpoints (4 endpoints)
5. **TODO:** Combat edge tests
6. **TODO:** salvage.collect

### Next Week
7. **TODO:** Corporation endpoints (8 endpoints)
8. **TODO:** CI/CD pipeline

### Following Weeks
9. **TODO:** Leaderboard, character admin, messaging
10. **TODO:** Performance benchmarks
11. **TODO:** Production readiness checklist

---

## Critical Path

To reach **production readiness for core gameplay:**

**Must Have (17 done, 7 remaining = 24 total):**
- ✅ Navigation (7)
- ✅ Trading (8)
- ✅ Test infrastructure (2)
- ⚠️ Combat testing (2 - edge tests for existing functions)
- ❌ Garrison (4)
- ❌ Salvage (1)

**Nice to Have (17):**
- Corporation (8)
- Leaderboard (1)
- Character admin (3)
- Messaging (1)
- Port admin (2)
- Health check (1)
- combat_tick tests (1)

---

**Bottom Line:** **24 endpoints need work** to complete the migration. At current velocity (~2-3 endpoints/day with tests), this is **2-3 weeks of effort** for critical path, **4-5 weeks total** for full feature parity.

---

**End of Summary**
