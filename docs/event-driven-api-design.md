# Event-Driven API Design: Removing Data Payloads from RPC Responses

**Table of Contents:**
- [Executive Summary](#executive-summary)
- [Design Decisions](#design-decisions)
- [Risks and Mitigations](#risks-and-mitigations)
- [Current API Handlers Inventory](#current-api-handlers-inventory)
- [Event Recipients Reference](#event-recipients-reference)
- [Summary of New Events](#summary-of-new-events)
- [Error Handling Strategy](#error-handling-strategy)
- [Implementation Phases](#implementation-phases)
- [Migration Strategy](#migration-strategy)
- [Testing Strategy](#testing-strategy)
- [Conclusion](#conclusion)
- [Detailed Implementation Tickets](#detailed-implementation-tickets)

---

## Executive Summary

This document describes a refactoring of the Gradient Bang game server API to eliminate data payloads from RPC responses. All operational data will be communicated through events on the WebSocket connection. RPC responses will contain only success/failure indicators and error details.

### Motivation

**Current Problem:** The API currently returns data in both RPC responses AND emits events, leading to:
- Redundant data transmission (same data sent twice)
- Inconsistent client patterns (some clients use return values, some use events)
- Complexity in maintaining dual data paths
- Unclear separation between command acknowledgment and state updates

**Proposed Solution:** Adopt a clean event-driven architecture where:
- RPC calls are **commands** that trigger actions (like POST requests)
- RPC responses indicate only **success or failure** of the command
- All **state updates and data** flow through events on the WebSocket
- Clients have a single, consistent way to receive game data

### Benefits

1. **Consistency:** Single source of truth for game data (events)
2. **Clarity:** Clear separation between commands (RPC) and data (events)
3. **Real-time:** All clients naturally receive real-time updates via events
4. **Testability:** RPC responses still indicate success/failure for easy testing
5. **Simplicity:** No duplicate data paths to maintain
6. **Scalability:** Events can be multicast efficiently to multiple recipients

**Design Principles:**
1. All clients must connect via WebSocket at `/ws`
2. All RPC calls made through the WebSocket connection
3. RPC responses contain only: `{success: true}` or `{success: false, error: "details"}`
4. All operational data delivered via events on the same WebSocket
5. Error details provided in both RPC response (for testing) and error event (for clients)
6. All endpoints become event-driven, including read-only operations
7. **Exception:** Admin/test endpoints remain unchanged for convenience

**Migration Approach:**
Since all clients are internal to this repository, we can do a coordinated update without maintaining backward compatibility. The implementation follows this order:
1. Server-side changes (Phases 1-4)
2. AsyncGameClient update (Phase 5.1)
3. Test updates (Phase 5.2)
4. Documentation (Phase 6)
5. NPC updates and cleanup (Phase 7 - Future Work)

---

## Design Decisions

### Event Ordering

**Decision:** Events within a single operation are emitted in deterministic order using `await` on each emit call.

**Rationale:** Clients may depend on receiving events in a logical sequence (e.g., `movement.start` before `movement.complete`). By awaiting each emit, we guarantee order within a single operation.

**Implementation:** All event emission code uses `await event_dispatcher.emit(...)` sequentially, not in parallel.

### Event Acknowledgment

**Decision:** Events do NOT require acknowledgment from clients.

**Rationale:** Keep the protocol simple. WebSocket provides reliable delivery at the transport layer. If a client misses an event due to disconnection, they can request current state on reconnection.

### Event Replay

**Decision:** No event replay mechanism in initial implementation.

**Rationale:** Clients should request current state (via `my_status`, `my_map`, etc.) when reconnecting. Event replay adds significant complexity and is not essential for the initial implementation.

**Future Consideration:** Could add event replay later if needed, storing recent events per character.

### Rate Limiting

**Decision:** Only RPC requests count towards rate limits, not events.

**Rationale:** Events are push notifications from the server. Rate limiting should only apply to client-initiated requests.

### Event Batching

**Decision:** Events are sent individually, not batched.

**Rationale:** Simplicity. Individual events are easier to process and debug. Batching can be added later if performance requires it.

### WebSocket Protocol

**Frame Types:**
- `rpc` - Client-to-server RPC request
- `rpc_response` - Server-to-client RPC response
- `event` - Server-to-client event notification

**RPC Request Format:**
```json
{
  "frame_type": "rpc",
  "id": "abc123",
  "method": "move",
  "params": {"character_id": "trader", "to_sector": 42}
}
```

**RPC Response Format:**
```json
{
  "frame_type": "rpc_response",
  "id": "abc123",
  "success": true
}
```

**Event Format:**
```json
{
  "frame_type": "event",
  "event": "movement.complete",
  "payload": {
    "source": {
      "type": "rpc",
      "method": "move",
      "request_id": "abc123",
      "timestamp": "2024-01-01T00:00:00Z"
    },
    "player": {...},
    "ship": {...},
    "sector": {...}
  }
}
```

---

## Risks and Mitigations

### Risk: Event Arrives Before RPC Response

**Scenario:** Network latency could cause an event to arrive at the client before the RPC response.

**Mitigation:** RPC acknowledgments remain minimal, while clients process events asynchronously via their registered handlers. Since events are the authoritative data channel, client logic must tolerate events that arrive before the related RPC response.

### Risk: Unexpected Events in Queue

**Scenario:** Client waits for `status.snapshot` but receives `sector.update` first.

**Mitigation:** Client event handlers should be written to ignore or defer events that are not immediately actionable, and maintain their own lightweight state machines if specific sequencing is required.

**Future Enhancement:** Add event subscription filtering so clients only receive events they care about, reducing handler noise.

### Risk: Client Disconnects During Operation

**Scenario:** Client sends RPC, disconnects before receiving response or event.

**Mitigation:** On reconnection, client should call `my_status` to get current state. The server completes operations even if the client disconnects.

### Risk: Breaking Existing Clients

**Scenario:** Old clients expect data in RPC responses.

**Mitigation:** All clients are internal to this repo. We update all clients simultaneously in a coordinated manner. No backward compatibility needed.

### Risk: Event Order Violation

**Scenario:** Events arrive out of order due to network or queueing issues.

**Mitigation:** Server guarantees emit order via sequential `await`, and WebSocket transport preserves frame ordering. Client handlers should treat events as streaming data and enforce any additional sequencing guarantees they need at a higher layer.

---

## Quick Reference: All API Changes

This section provides an at-a-glance summary of changes to all 24 API endpoints.

**Endpoints with NO changes (Admin/Test):**
- `reset_ports`, `regenerate_ports`, `test.reset`, `server_status` - Continue returning data

**Endpoints being REMOVED:**
- `check_trade` - Deleted entirely (use client-side validation or try/catch)
- `combat.status` - Deleted entirely (use combat.round_waiting events)

**Endpoints getting NEW events (10 total):**
- `my_status`, `join` → `status.snapshot`
- `my_map` → `map.knowledge`
- `local_map_region` → `map.region`
- `list_known_ports` → `ports.list`
- `path_with_region` → `path.region`
- `combat.action` → `combat.action_accepted`
- `combat.leave_fighters` → `garrison.deployed`
- `combat.collect_fighters` → `garrison.collected`
- `combat.set_garrison_mode` → `garrison.mode_changed`
- `salvage.collect` → `salvage.collected`

**Endpoints with ENHANCED events:**
- `trade` → Enhance `trade.executed` with trade details
- `recharge_warp_power` → Enhance `warp.purchase` with result details
- `transfer_warp_power` → Enhance `warp.transfer` with result details
- `combat.initiate` → Enhance `combat.round_waiting` with initiator field (round 1 only)

**Endpoints with REMOVED return data only:**
- `move` - Already has comprehensive events, just remove return data
- `plot_course` - Already emits `course.plot`, just remove return data

**Total Changes:**
- 2 endpoints deleted
- 10 new events created
- 4 existing events enhanced
- 2 endpoints simplified (remove redundant data)
- 4 admin/test endpoints unchanged
- **All 22 operational endpoints** return minimal `{success: true/false}` responses

---

## Current API Handlers Inventory

### State-Modifying Operations

#### 1. `join` - Join/rejoin the game

**Current Implementation:**
- **Returns:** Full status payload (`player`, `ship`, `sector` with complete contents)
- **Events Emitted:**
  - `character.joined` - On initial join (character_id, sector, timestamp)
  - `character.moved` - On sector teleport during rejoin (multiple variants for mover/observers)

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **New Events:**
  - `status.snapshot` - Full status payload (player, ship, sector) sent after join completes
- **Removed Events:**
  - `character.joined` - Removed (redundant with status.snapshot)
- **Existing Events:** Keep `character.moved` for sector teleport during rejoin
- **Design Note:** A character's ship persists in-sector whether the pilot is connected or not; sector-mates rely on existing `character.moved` and `sector.update` events rather than a dedicated "player joined" broadcast.

---

#### 2. `move` - Move to adjacent sector

**Current Implementation:**
- **Returns:** Full status payload (same as `join`)
- **Events Emitted:**
  - `character.moved` - Departure notification (movement: "depart") to old sector observers
  - `movement.start` - Sent to moving character (destination sector contents, hyperspace_time)
  - `movement.complete` - Sent to moving character (player, ship, sector)
  - `map.local` - Local map region around destination sector
  - `character.moved` - Arrival notification (movement: "arrive") to new sector observers

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Existing Events:** Already comprehensive, no new events needed
- **Note:** The `movement.complete` event already contains the full status payload

---

#### 3. `my_status` - Get current status

**Current Implementation:**
- **Returns:** Full status payload (player, ship, sector)
- **Events Emitted:** NONE

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **New Events:**
  - `status.snapshot` - Full status payload sent in response to my_status request

---

#### 4. `trade` - Execute trade transaction

**Current Implementation:**
- **Returns:** Trade result details:
  ```json
  {
    "success": true,
    "trade_type": "buy|sell",
    "commodity": "quantum_foam",
    "units": 100,
    "price_per_unit": 25,
    "total_price": 2500,
    "new_credits": 7500,
    "new_cargo": {"quantum_foam": 100, ...},
    "new_prices": {...}
  }
  ```
- **Events Emitted:**
  - `trade.executed` - Sent to trader (player, ship)
  - `port.update` - Sent to all characters in sector (sector, port details)

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `trade.executed` - Expand to include trade result details (commodity, units, price_per_unit, total_price, new_credits, new_cargo, new_prices)
  - `port.update` - Keep as is

---

#### 5. `recharge_warp_power` - Buy warp power at sector 0

**Current Implementation:**
- **Returns:**
  ```json
  {
    "success": true|false,
    "units_bought": 50,
    "price_per_unit": 2,
    "total_cost": 100,
    "new_warp_power": 150,
    "warp_power_capacity": 200,
    "new_credits": 900,
    "message": "Success message"
  }
  ```
- **Events Emitted:**
  - `warp.purchase` - Sent to character (character_id, sector, units, price_per_unit, total_cost, timestamp)
  - `status.update` - Full status payload sent after purchase

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `warp.purchase` - Expand to include new_warp_power, warp_power_capacity, new_credits
  - `status.update` - Keep as is (already includes full state)

---

#### 6. `transfer_warp_power` - Transfer warp power between characters

**Current Implementation:**
- **Returns:**
  ```json
  {
    "success": true|false,
    "units_transferred": 25,
    "from_warp_power_remaining": 75,
    "to_warp_power_current": 125,
    "message": "Success message"
  }
  ```
- **Events Emitted:**
  - `warp.transfer` - Sent to both characters (from_character_id, to_character_id, sector, units, timestamp)
  - `status.update` - Sent to both characters (full status payload each)

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `warp.transfer` - Expand to include from_warp_power_remaining, to_warp_power_current
  - `status.update` - Keep as is (already sent to both characters)

---

#### 7. `combat.initiate` - Start combat encounter

**Current Implementation:**
- **Returns:** Full encounter details:
  ```json
  {
    "combat_id": "uuid",
    "sector_id": 42,
    "round_number": 1,
    "ended": false,
    "participants": {
      "character1": {
        "combatant_id": "character1",
        "combatant_type": "character",
        "fighters": 100,
        "shields": 50,
        ...
      },
      ...
    },
    "initiator": "character1",
    "target": "character2",
    "target_type": "character"
  }
  ```
- **Events Emitted:**
  - `combat.round_waiting` - Sent to all participants (via async task)

**Proposed Changes:**
- **Returns:** `{success: true, combat_id: "uuid"}` or `{success: false, error: "details"}`
- **Events:** Enhance `combat.round_waiting` to include `initiator` field (round 1 only)
- **Note:** No new event needed - `combat.round_waiting` already provides combat_id, sector, round, participants, garrison, deadline. Adding `initiator` provides context about who started the combat.

---

#### 8. `combat.action` - Submit combat action

**Current Implementation:**
- **Returns:**
  ```json
  {
    "accepted": true,
    "combat_id": "uuid",
    "round": 2,
    "ended": false,
    "round_resolved": true,
    "outcome": {
      "round_number": 2,
      "actions": {...},
      "damage_dealt": {...},
      "fighters_remaining": {...},
      "shields_remaining": {...},
      ...
    },
    "pay_processed": true  // for PAY actions
  }
  ```
- **Events Emitted:**
  - `combat.round_resolved` - Sent to all participants when round completes (via callback)
  - `combat.round_waiting` - Sent for next round (via callback)
  - `combat.ended` - Sent when combat ends (via callback)

**Proposed Changes:**
- **Returns:** `{success: true, combat_id: "uuid"}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `combat.action_accepted` - NEW event indicating action was recorded
  - `combat.round_resolved` - Keep as is (already comprehensive)
  - `combat.round_waiting` - Keep as is
  - `combat.ended` - Keep as is

---

#### 9. `combat.status` - **TO BE REMOVED**

**Current Implementation:**
- **Returns:** Full encounter details (same structure as combat.initiate)
- **Events Emitted:** NONE

**Proposed Changes:**
- **DELETE THIS ENDPOINT ENTIRELY**
- Remove from server.py RPC_HANDLERS
- Delete game-server/api/combat_status.py
- Remove from AsyncGameClient
- Remove from tool schemas (if present)

**Rationale:** This endpoint is unnecessary because:
- Players already in a combat sector automatically receive `combat.round_waiting` events for each round
- **Players joining the game** must receive `combat.round_waiting` if there's combat in their starting sector
- **Players arriving via move** must receive `combat.round_waiting` when they emerge from hyperspace into a combat sector
- Therefore, clients never need to query combat status - they're always pushed the current state

**Implementation Requirements:**
1. **Verify `join` code path:** After character is placed in sector, check if combat exists in that sector and emit `combat.round_waiting` to the joining player
2. **Verify `move` code path:** In `movement.complete` event emission, check if combat exists in destination sector and emit `combat.round_waiting` to the arriving player
3. **Late arrival behavior:** Players arriving mid-round won't have the full round deadline to submit actions. This is intentional game design - it's the risk of jumping into an active combat zone.

---

#### 10. `combat.leave_fighters` - Deploy garrison

**Current Implementation:**
- **Returns:**
  ```json
  {
    "sector": 42,
    "garrison": {
      "owner_name": "character1",
      "fighters": 100,
      "mode": "offensive",
      "toll_amount": 0,
      "deployed_at": "2024-01-01T00:00:00Z",
      "is_friendly": true
    },
    "fighters_remaining": 50
  }
  ```
- **Events Emitted:**
  - `sector.update` - Sent to all characters in sector (full sector contents)
  - `combat.round_waiting` - Sent if garrison auto-attacks (via start_sector_combat)

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `garrison.deployed` - NEW event with garrison details and fighters_remaining
  - `sector.update` - Keep as is
  - `combat.round_waiting` - Keep as is

---

#### 11. `combat.collect_fighters` - Collect garrison fighters

**Current Implementation:**
- **Returns:**
  ```json
  {
    "sector": 42,
    "credits_collected": 500,
    "garrison": {...} or null,
    "fighters_on_ship": 150
  }
  ```
- **Events Emitted:**
  - `sector.update` - Sent to all characters in sector

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `garrison.collected` - NEW event with credits_collected, garrison (if any), fighters_on_ship
  - `sector.update` - Keep as is

---

#### 12. `combat.set_garrison_mode` - Change garrison mode

**Current Implementation:**
- **Returns:**
  ```json
  {
    "sector": 42,
    "garrison": {
      "owner_name": "character1",
      "fighters": 100,
      "mode": "toll",
      "toll_amount": 100,
      ...
    }
  }
  ```
- **Events Emitted:**
  - `sector.update` - Sent to all characters in sector

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `garrison.mode_changed` - NEW event with updated garrison details
  - `sector.update` - Keep as is

---

#### 13. `salvage.collect` - Collect salvage container

**Current Implementation:**
- **Returns:**
  ```json
  {
    "salvage": {
      "id": "uuid",
      "cargo": {...},
      "credits": 500,
      "scrap": 10
    },
    "cargo": {"quantum_foam": 100, ...},
    "credits": 8500
  }
  ```
- **Events Emitted:**
  - `sector.update` - Sent to all characters in sector (salvage removed)

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Enhanced Events:**
  - `salvage.collected` - NEW event with salvage details, new cargo, new credits
  - `sector.update` - Keep as is

---

#### 14. `send_message` - Send chat message

**Current Implementation:**
- **Returns:** `{"id": "message_uuid"}`
- **Events Emitted:**
  - `chat.message` - Sent to recipients (broadcast or direct)

**Proposed Changes:**
- **Returns:** `{success: true, message_id: "uuid"}` or `{success: false, error: "details"}`
- **Events:** Keep as is
- **Note:** message_id can remain in success response for client convenience

---

### Read-Only/Computational Operations

#### 15. `my_map` - Get map knowledge

**Current Implementation:**
- **Returns:** Complete map knowledge data:
  ```json
  {
    "sector": 42,
    "sectors_visited": {
      "0": {"port": {...}, "last_visited": "...", ...},
      "42": {...},
      ...
    },
    "ship_config": {...},
    "credits": 10000
  }
  ```
- **Events Emitted:** NONE

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **New Events:**
  - `map.knowledge` - Complete map knowledge data

---

#### 16. `plot_course` - Find path between sectors

**Current Implementation:**
- **Returns:**
  ```json
  {
    "from_sector": 0,
    "to_sector": 42,
    "path": [0, 5, 12, 42],
    "distance": 3
  }
  ```
- **Events Emitted:**
  - `course.plot` - Same data as return (redundant!)

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **Events:** Keep existing `course.plot` event (remove redundant return data)

---

#### 17. `local_map_region` - Get known sectors around center

**Current Implementation:**
- **Returns:**
  ```json
  {
    "center_sector": 42,
    "sectors": [
      {
        "id": 42,
        "visited": true,
        "hops_from_center": 0,
        "adjacent_sectors": [41, 43],
        "port": "SSB",
        "position": [100, 200],
        "lanes": [...]
      },
      ...
    ],
    "total_sectors": 25,
    "total_visited": 20,
    "total_unvisited": 5
  }
  ```
- **Events Emitted:** NONE

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **New Events:**
  - `map.region` - Complete region data

---

#### 18. `list_known_ports` - Find ports within range

**Current Implementation:**
- **Returns:**
  ```json
  {
    "from_sector": 42,
    "ports": [
      {
        "sector_id": 45,
        "hops_from_start": 2,
        "port": {"code": "SSB", ...},
        "position": [120, 230],
        "last_visited": "..."
      },
      ...
    ],
    "total_ports_found": 15,
    "searched_sectors": 50
  }
  ```
- **Events Emitted:** NONE

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **New Events:**
  - `ports.list` - Complete ports data

---

#### 19. `path_with_region` - Get path with context

**Current Implementation:**
- **Returns:**
  ```json
  {
    "path": [42, 45, 48, 52],
    "distance": 3,
    "sectors": [
      {
        "sector_id": 42,
        "on_path": true,
        "visited": true,
        "hops_from_path": 0,
        ...
      },
      ...
    ],
    "total_sectors": 30,
    "known_sectors": 25,
    "unknown_sectors": 5
  }
  ```
- **Events Emitted:** NONE

**Proposed Changes:**
- **Returns:** `{success: true}` or `{success: false, error: "details"}`
- **New Events:**
  - `path.region` - Complete path and region data

---

#### 20. `check_trade` - **TO BE REMOVED**

**Current Implementation:**
- **Returns:** Trade validation result (can_trade, error, current_credits, current_cargo, etc.)
- **Events Emitted:** NONE

**Proposed Changes:**
- **DELETE THIS ENDPOINT ENTIRELY**
- Remove from server.py RPC_HANDLERS
- Delete game-server/api/check_trade.py
- Remove from AsyncGameClient
- Remove from tool schemas
- Find and remove all client-side calls

**Rationale:** Trade validation can be done client-side with cached state, or clients can simply attempt trades and handle failures. The complexity of maintaining a separate validation endpoint is not worth it.

---

### Admin/Test Operations

#### 21. `reset_ports` - Reset all ports (admin)

**Current Implementation:**
- **Returns:** `{"reset": true, "port_count": 150}`
- **Events Emitted:**
  - `port.reset` - Broadcast to all (port_count)

**Proposed Changes:**
- **No changes** - Admin operations can continue returning data directly for convenience
- **Events:** Keep existing `port.reset` event for notifying players

---

#### 22. `regenerate_ports` - Regenerate port stock (admin)

**Current Implementation:**
- **Returns:** `{"regenerated": true, "port_count": 150}`
- **Events Emitted:**
  - `port.regenerate` - Broadcast to all (port_count)

**Proposed Changes:**
- **No changes** - Admin operations can continue returning data directly for convenience
- **Events:** Keep existing `port.regenerate` event for notifying players

---

#### 23. `test.reset` - Test utility

**Current Implementation:**
- **Returns:** Various test-specific data
- **Events Emitted:** None

**Proposed Changes:**
- **No changes** - Test utilities can continue returning data directly for convenience

---

#### 24. `server_status` - Server information

**Current Implementation:**
- **Returns:**
  ```json
  {
    "name": "Gradient Bang",
    "version": "0.2.0",
    "status": "running",
    "sectors": 5000
  }
  ```
- **Events Emitted:** NONE

**Proposed Changes:**
- **No changes** - Server status is metadata, not operational game data

---

## Event Recipients Reference

This section documents which characters/connections receive each event.

### Existing Events (Modified or Unchanged)

| Event Name | Recipients | character_filter | Notes |
|------------|-----------|------------------|-------|
| `character.moved` (depart) | Characters in departure sector | [character_ids in old sector] | Unchanged |
| `character.moved` (arrive) | Characters in arrival sector | [character_ids in new sector] | Unchanged |
| `character.moved` (mover) | Moving character only | [character_id] | Unchanged |
| `movement.start` | Moving character only | [character_id] | Unchanged |
| `movement.complete` | Moving character only | [character_id] | Unchanged |
| `map.local` | Moving character only | [character_id] | Unchanged |
| `trade.executed` | Trading character only | [character_id] | Enhanced with trade details |
| `port.update` | All characters in sector | [character_ids in sector] | Unchanged |
| `warp.purchase` | Purchasing character only | [character_id] | Enhanced with result details |
| `warp.transfer` | Both sender and receiver | [from_character_id, to_character_id] | Enhanced with result details |
| `status.update` | Target character(s) only | [character_id] or [multiple ids] | Unchanged |
| `course.plot` | Requesting character only | [character_id] | Unchanged |
| `combat.round_waiting` | All combat participants | [participant character_ids] | Enhanced: Add `initiator` field (round 1 only) |
| `combat.round_resolved` | All combat participants + fled | [participants + recently_fled] | Unchanged |
| `combat.ended` | All combat participants | [participant character_ids] | Unchanged |
| `sector.update` | All characters in sector | [character_ids in sector] | Unchanged |
| `chat.message` (broadcast) | All connected clients | None (broadcast) | Unchanged |
| `chat.message` (direct) | Sender and recipient only | [from_id, to_id] | Unchanged |
| `port.reset` | All connected clients | None (broadcast) | Unchanged (admin operation) |
| `port.regenerate` | All connected clients | None (broadcast) | Unchanged (admin operation) |

### Removed Events

| Event Name | Reason for Removal |
|------------|--------------------|
| `character.joined` | Redundant - replaced by `status.snapshot` event on join |

### New Events (To Be Implemented)

| Event Name | Recipients | character_filter | Replaces Return From |
|------------|-----------|------------------|---------------------|
| `status.snapshot` | Requesting/joining character only | [character_id] | `join`, `my_status` |
| `map.knowledge` | Requesting character only | [character_id] | `my_map` |
| `map.region` | Requesting character only | [character_id] | `local_map_region` |
| `ports.list` | Requesting character only | [character_id] | `list_known_ports` |
| `path.region` | Requesting character only | [character_id] | `path_with_region` |
| `combat.action_accepted` | Submitting character only | [character_id] | `combat.action` |
| `garrison.deployed` | Deploying character only | [character_id] | `combat.leave_fighters` |
| `garrison.collected` | Collecting character only | [character_id] | `combat.collect_fighters` |
| `garrison.mode_changed` | Character who changed mode | [character_id] | `combat.set_garrison_mode` |
| `salvage.collected` | Collecting character only | [character_id] | `salvage.collect` |

**Key Observations:**
- **Personal data events** (status.snapshot, map.*, combat.action_accepted) are sent only to requesting character
- **Sector-wide events** (sector.update, port.update) are sent to all characters in the sector
- **Combat events** (combat.*) are sent to all participants in the encounter
- **Broadcast events** (port.reset, port.regenerate) are sent to all connected clients
- **Multi-character events** (warp.transfer) are sent to specific involved characters
- **Note:** `status.snapshot` serves dual purpose for both `join` and `my_status` operations
- **Note:** `combat.round_waiting` enhanced to include `initiator` field (round 1 only) to identify who started the combat
- **Correlation:** Every RPC-triggered event payload includes a `source` object with `{type: "rpc", method, request_id, timestamp}` so clients and logs can relate events to the originating command.

---

## Summary of New Events

| Event Name | Purpose | Replaces Return Data From |
|------------|---------|---------------------------|
| `status.snapshot` | Full status after join or on demand | `join`, `my_status` |
| `map.knowledge` | Complete map knowledge | `my_map` |
| `map.region` | Local map region | `local_map_region` |
| `ports.list` | Ports within range | `list_known_ports` |
| `path.region` | Path with context | `path_with_region` |
| `combat.action_accepted` | Action recorded | `combat.action` |
| `garrison.deployed` | Garrison created/updated | `combat.leave_fighters` |
| `garrison.collected` | Fighters collected | `combat.collect_fighters` |
| `garrison.mode_changed` | Mode updated | `combat.set_garrison_mode` |
| `salvage.collected` | Salvage claimed | `salvage.collect` |

**Total: 10 new events**

**Notes:**
- `combat.initiate` doesn't need a new event - the existing `combat.round_waiting` event already contains all necessary combat data (combat_id, sector, round, participants, garrison, deadline). We enhance `combat.round_waiting` to include an `initiator` field (round 1 only) to identify who started the combat.
- `combat.status` endpoint is removed entirely - players always receive `combat.round_waiting` events when in a combat sector (including new arrivals via join or move)
- All RPC-triggered events include a `source` block `{type: "rpc", method, request_id, timestamp}` for correlation; system-initiated events (timers, admin actions) may provide alternative `source.type` values.

---

## Error Handling Strategy

All RPC handlers will return errors in a consistent format:

**Success Response:**
```json
{
  "success": true
}
```

Optional: Some operations may include essential IDs in success response:
```json
{
  "success": true,
  "combat_id": "uuid"  // for combat.initiate
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

**Error Event (Optional):**
```json
{
  "frame_type": "event",
  "event": "error",
  "payload": {
    "source": {
      "type": "rpc",
      "method": "move",
      "request_id": "abc123",
      "timestamp": "2024-01-01T00:00:00Z"
    },
    "error": "Sector 99 is not adjacent to current sector 42",
    "endpoint": "move"
  }
}
```

The error event is optional but recommended for client convenience. Tests can rely on the RPC response error field.

---

## Implementation Phases

### Phase 1: Infrastructure Setup
1. Create event emission helpers for new events
2. Add support for error events in EventDispatcher
3. Propagate RPC frame `id` through handler context for correlation metadata
4. Update RPC response formatting utilities

### Phase 2: Remove check_trade
1. Delete game-server/api/check_trade.py
2. Remove from server.py RPC_HANDLERS
3. Remove from utils/api_client.py AsyncGameClient
4. Remove from utils/tools_schema.py
5. Search codebase for check_trade usage and remove
6. Update documentation

### Phase 2.5: Remove combat.status
1. Delete game-server/api/combat_status.py
2. Remove from server.py RPC_HANDLERS
3. Remove from utils/api_client.py AsyncGameClient
4. Remove from utils/tools_schema.py (if present)
5. **Verify join/move emit combat.round_waiting to new arrivals**

### Phase 3: Update Read-Only Endpoints
1. `my_status` → emit `status.snapshot`
2. `my_map` → emit `map.knowledge`
3. `plot_course` → remove return data (already emits event)
4. `local_map_region` → emit `map.region`
5. `list_known_ports` → emit `ports.list`
6. `path_with_region` → emit `path.region`

### Phase 4: Update State-Modifying Endpoints
1. `join` → emit `status.snapshot` (remove character.joined), verify combat.round_waiting emission
2. `trade` → enhance `trade.executed` event
3. `recharge_warp_power` → enhance `warp.purchase` event
4. `transfer_warp_power` → enhance `warp.transfer` event
5. `combat.initiate` → enhance `combat.round_waiting` with initiator
6. `combat.action` → emit `combat.action_accepted`
7. `combat.leave_fighters` → emit `garrison.deployed`
8. `combat.collect_fighters` → emit `garrison.collected`
9. `combat.set_garrison_mode` → emit `garrison.mode_changed`
10. `salvage.collect` → emit `salvage.collected`
11. `move` → verify combat.round_waiting emission on arrival

### Phase 5: Client and Test Updates
1. Update AsyncGameClient to handle event-based responses
2. Update tests to verify events instead of return values

### Phase 6: Documentation
1. Update API documentation
2. Update CLAUDE.md
3. Create event reference documentation

### Phase 7: NPC Updates (Future Work)
1. Update NPC scripts to use event-driven AsyncGameClient
2. Remove old terminal viewers (firehose_viewer.py, character_viewer.py)
3. Design new monitoring/visualization tools as needed

---

## Migration Strategy

All clients are internal to this repository, so we can do a coordinated update:

### Implementation Order
1. **Server changes** (Phases 1-4): Update all API handlers to emit events and return minimal responses
2. **AsyncGameClient update** (Phase 5.1): Update the Python client library to use event-driven mode
3. **Test updates** (Phase 5.2): Update all tests to verify events instead of return values
4. **Documentation** (Phase 6): Update all documentation to reflect new architecture
5. **NPC updates** (Phase 7 - Future Work): Update NPC scripts after AsyncGameClient is stable
6. **Terminal viewers** (Phase 7 - Future Work): Remove `tools/firehose_viewer.py` and `tools/character_viewer.py` (outdated, will rethink purpose later)

### No Dual Mode Required
Since all clients are in this repository, we don't need to maintain backward compatibility. We can update everything in a coordinated manner without supporting both old and new modes simultaneously.

---

## Testing Strategy

### Unit Tests
- Test each handler returns minimal success/failure
- Verify events are emitted with correct payload structure
- Test error conditions return appropriate error responses

### Integration Tests
- Verify WebSocket connection receives events after RPC calls
- Test event ordering (e.g., movement.start before movement.complete)
- Test event filtering (character-specific events only go to relevant clients)

### Performance Tests
- Measure event emission latency
- Test concurrent operations with many connected clients
- Verify event queue doesn't cause memory issues

**Tooling Note:** All Python dependency management and test execution should continue to use `uv` (e.g., `uv sync`, `uv run pytest ...`) to stay consistent with the repo conventions.

---

## Conclusion

This design moves Gradient Bang to a fully event-driven architecture where:
- **RPC calls are commands** that trigger state changes (similar to POST requests)
- **All game data flows through WebSocket events** (single source of truth)
- **Clients use AsyncGameClient** which dispatches events to handlers/queues
- **Testing remains straightforward** with error details in responses
- **Admin/test endpoints remain unchanged** for convenience

### Implementation Pattern

Each API endpoint follows this pattern:

```python
async def handle(request: dict, world) -> dict:
    # 1. Validate parameters
    if not valid:
        return rpc_failure("Error message")

    # 2. Perform operation
    result = await perform_operation(...)

    # 3. Emit event(s) with data
    request_id = request["request_id"]
    payload_with_data["source"] = build_event_source("endpoint_name", request_id)
    await event_dispatcher.emit(
        "event.name",
        payload_with_data,
        character_filter=[character_id]
    )

    # 4. Return minimal success
    return rpc_success()  # or rpc_success({"id": "..."})
```

### Client Pattern

AsyncGameClient wraps this complexity by sending RPC acknowledgments and streaming events to registered consumers. Callers react to the resulting `status.snapshot` (or other) events via handlers or event queues they control.

### Migration Timeline

The migration can be done incrementally, starting with infrastructure, then removing unnecessary endpoints, updating all handlers, and finally updating the client library and tests.

**Estimated Effort:**
- Phases 1-4: 9 days (Server-side changes)
- Phase 5: 3 days (Client and tests)
- Phase 6: 2 days (Documentation)
- **Total: 14 days** (with testing and documentation)

**Post-Implementation:**
- Phase 7 (NPC updates) will be done separately after AsyncGameClient is stable
- Old terminal viewers will be removed
- New monitoring tools can be designed based on the event-driven architecture

### Key Advantages

1. **Consistency:** All clients use the same pattern (events)
2. **Real-time:** Naturally supports real-time multiplayer updates
3. **Testability:** RPC responses remain simple and testable
4. **Scalability:** Events can efficiently multicast to multiple recipients
5. **Simplicity:** No dual data paths to maintain

---

# Detailed Implementation Tickets

This section provides detailed implementation tickets with sample code, architecture notes, and testing strategies for each phase.

---

## Phase 1: Infrastructure Setup

### Ticket 1.1: Create RPC Response Helper Functions

**Objective:** Standardize success/failure responses across all handlers.

**Architecture Notes:**
- Create utility functions in `game-server/api/utils.py` for consistent response formatting
- Ensure all handlers use these utilities for uniform response structure
- Support optional data fields (e.g., `combat_id`, `message_id`) in success responses

**Sample Code:**

```python
# game-server/api/utils.py

from datetime import datetime, timezone

def rpc_success(data: dict | None = None) -> dict:
    """Return standardized success response.

    Args:
        data: Optional additional data (e.g., {"combat_id": "uuid"})

    Returns:
        Success response dict
    """
    response = {"success": True}
    if data:
        response.update(data)
    return response


def rpc_failure(error: str) -> dict:
    """Return standardized failure response.

    Args:
        error: Human-readable error message

    Returns:
        Failure response dict
    """
    return {
        "success": False,
        "error": error
    }


def build_event_source(
    endpoint: str,
    request_id: str,
    *,
    source_type: str = "rpc",
    timestamp: datetime | None = None,
) -> dict:
    """Construct correlation metadata for events/errors."""

    return {
        "type": source_type,
        "method": endpoint,
        "request_id": request_id,
        "timestamp": (timestamp or datetime.now(timezone.utc)).isoformat(),
    }
```

**Testing:**
```python
# game-server/tests/test_api_utils.py

def test_rpc_success_minimal():
    result = rpc_success()
    assert result == {"success": True}

def test_rpc_success_with_data():
    result = rpc_success({"combat_id": "test-123"})
    assert result == {"success": True, "combat_id": "test-123"}

def test_rpc_failure():
    result = rpc_failure("Invalid sector")
    assert result == {"success": False, "error": "Invalid sector"}
```

**Acceptance Criteria:**
- [ ] `rpc_success()` returns `{"success": True}`
- [ ] `rpc_success({"key": "val"})` includes additional data
- [ ] `rpc_failure("msg")` returns `{"success": False, "error": "msg"}`
- [ ] Unit tests pass

---

### Ticket 1.2: Add Error Event Support

**Objective:** Enable optional error events for client convenience.

**Architecture Notes:**
- Error events are sent to the requesting character only
- Include a `source` object `{type: "rpc", method, request_id, timestamp}` plus the human-readable error message
- Keep the legacy `endpoint` string for convenience, but log correlation should primarily use the `source` block
- This is optional—clients can rely on RPC response errors for simpler implementation

**Sample Code:**

```python
# game-server/api/utils.py

from datetime import datetime, timezone
from typing import Optional

async def emit_error_event(
    event_dispatcher,
    character_id: str,
    endpoint: str,
    request_id: str,
    error: str
) -> None:
    """Emit error event to character.

    Args:
        event_dispatcher: EventDispatcher instance
        character_id: Character who made the request
        endpoint: RPC endpoint name (e.g., "move", "trade")
        request_id: RPC frame id associated with the failure
        error: Error message
    """
    await event_dispatcher.emit(
        "error",
        {
            "source": build_event_source(endpoint, request_id),
            "endpoint": endpoint,
            "error": error,
        },
        character_filter=[character_id],
    )
```

**Usage Example:**

```python
# In an API handler:
try:
    # ... validation logic ...
    if invalid_condition:
        error_msg = "Sector 99 is not adjacent to current sector 42"
        await emit_error_event(
            event_dispatcher,
            character_id,
            "move",
            request_id=request["request_id"],
            error=error_msg,
        )
        return rpc_failure(error_msg)
except Exception as e:
    error_msg = str(e)
    await emit_error_event(
        event_dispatcher,
        character_id,
        "move",
        request_id=request["request_id"],
        error=error_msg,
    )
    return rpc_failure(error_msg)
```

**Testing:**
```python
# game-server/tests/test_error_events.py

async def test_emit_error_event(mock_dispatcher):
    await emit_error_event(
        mock_dispatcher,
        "char1",
        "move",
        request_id="req-error",
        error="Invalid move"
    )

    mock_dispatcher.emit.assert_called_once()
    call_args = mock_dispatcher.emit.call_args

    assert call_args[0][0] == "error"  # event name
    payload = call_args[0][1]
    assert payload["endpoint"] == "move"
    assert payload["error"] == "Invalid move"
    assert payload["source"]["request_id"] == "req-error"
    assert call_args[1]["character_filter"] == ["char1"]
```

**Acceptance Criteria:**
- [ ] `emit_error_event()` function created
- [ ] Error events include endpoint, error, and a `source` block with method/request_id/timestamp
- [ ] Error events sent only to requesting character
- [ ] `docs/event_catalog.md` documents the `error` event schema
- [ ] Unit tests pass

---

### Ticket 1.3: Expose RPC Frame ID to Handlers

**Objective:** Ensure every handler can attach correlation metadata to emitted events.

**Architecture Notes:**
- Update the WebSocket RPC router to require or generate an `id` for each inbound command.
- Pass that `request_id` into handler context (e.g., as `request["request_id"]`) so event payloads can call `build_event_source`.
- Echo the same `id` in the RPC response for client correlation.

**Sample Code:**

```python
# rpc/router.py

async def handle_rpc_message(conn: Connection, message: dict[str, Any]) -> None:
    endpoint = message["method"]
    request_id = message.get("id") or uuid.uuid4().hex
    params = dict(message.get("params", {}))
    params["request_id"] = request_id
    handler = RPC_HANDLERS[endpoint]
    result = await handler(params, world)
    await conn.send_rpc_response(request_id, result)
```

**Acceptance Criteria:**
- [ ] RPC router guarantees every request has an `id`
- [ ] Handlers receive the `request_id`
- [ ] Server responses echo the `id`
- [ ] Event emission helpers/examples updated to attach `source`

---

## Phase 2: Remove check_trade

### Ticket 2.1: Delete check_trade Endpoint

**Objective:** Remove check_trade endpoint and all related code.

**Files to Modify/Delete:**
1. DELETE: `game-server/api/check_trade.py`
2. MODIFY: `game-server/server.py` - Remove from RPC_HANDLERS
3. MODIFY: `utils/api_client.py` - Remove AsyncGameClient.check_trade method
4. MODIFY: `utils/tools_schema.py` - Remove CheckTradeTool class
5. SEARCH: Find all usages in codebase

**Implementation Steps:**

```bash
# Step 1: Find all usages
grep -r "check_trade" --include="*.py" .

# Step 2: Delete the API handler
rm game-server/api/check_trade.py
```

**Code Changes:**

```python
# game-server/server.py - REMOVE this entry:
RPC_HANDLERS: Dict[str, RPCHandler] = {
    # ... other handlers ...
    "check_trade": _with_rate_limit(
        "check_trade", lambda payload: api_check_trade.handle(payload, world)
    ),  # <-- DELETE THIS LINE
    # ... other handlers ...
}
```

```python
# utils/api_client.py - REMOVE this method from AsyncGameClient:

async def check_trade(
    self, commodity: str, quantity: int, trade_type: str
) -> dict:
    """Check if a trade is possible without executing it."""
    # <-- DELETE THIS ENTIRE METHOD
```

```python
# utils/tools_schema.py - REMOVE CheckTradeTool class:

class CheckTradeTool(BaseTool):
    # <-- DELETE THIS ENTIRE CLASS
    pass
```

**Testing:**
```bash
# Verify endpoint is gone
uv run pytest tests/test_api_handlers.py -k check_trade
# Should find no tests or all should be deleted

# Verify no remaining references
grep -r "check_trade" --include="*.py" .
# Should return no results (except this doc and git history)
```

**Acceptance Criteria:**
- [ ] `game-server/api/check_trade.py` deleted
- [ ] `check_trade` removed from server.py RPC_HANDLERS
- [ ] `check_trade` removed from AsyncGameClient
- [ ] `CheckTradeTool` removed from tools_schema.py
- [ ] No remaining code references to check_trade
- [ ] All related tests removed or updated

---

## Phase 2.5: Remove combat.status and Verify Combat Event Emission

### Ticket 2.5.1: Delete combat.status Endpoint

**Objective:** Remove combat.status endpoint and all related code.

**Files to Modify/Delete:**
1. DELETE: `game-server/api/combat_status.py`
2. MODIFY: `game-server/server.py` - Remove from RPC_HANDLERS
3. MODIFY: `utils/api_client.py` - Remove AsyncGameClient.combat_status method (if exists)
4. MODIFY: `utils/tools_schema.py` - Remove CombatStatusTool class (if exists)
5. SEARCH: Find all usages in codebase

**Implementation Steps:**

```bash
# Step 1: Find all usages
grep -r "combat_status\|combat\.status" --include="*.py" .

# Step 2: Delete the API handler
rm game-server/api/combat_status.py
```

**Code Changes:**

```python
# game-server/server.py - REMOVE this entry:
RPC_HANDLERS: Dict[str, RPCHandler] = {
    # ... other handlers ...
    "combat.status": _with_rate_limit(
        "combat.status", lambda payload: api_combat_status.handle(payload, world)
    ),  # <-- DELETE THIS LINE
    # ... other handlers ...
}
```

**Acceptance Criteria:**
- [ ] `game-server/api/combat_status.py` deleted
- [ ] `combat.status` removed from server.py RPC_HANDLERS
- [ ] `combat_status` removed from AsyncGameClient (if present)
- [ ] No remaining code references to combat.status/combat_status
- [ ] All related tests removed or updated

---

### Ticket 2.5.2: Verify Combat Events on Join

**Objective:** Ensure joining players receive combat.round_waiting if combat is active in their sector.

**Current Code Location:** `game-server/api/join.py`

**Architecture Notes:**
- After a character joins and is placed in a sector, check if combat is active
- If active combat exists, emit `combat.round_waiting` to the newly joined character
- The player won't have full round time to submit an action (intentional design)

**Implementation:**

```python
# game-server/api/join.py (add after status.snapshot emission)

async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    # ... all existing join logic ...

    # Emit status.snapshot event
    status_payload = await build_status_payload(world, character_id)
    request_id = request["request_id"]
    status_payload["source"] = build_event_source("join", request_id)
    await event_dispatcher.emit(
        "status.snapshot",
        status_payload,
        character_filter=[character_id],
    )

    # NEW: Check for active combat in joined sector
    character = world.characters[character_id]
    if world.combat_manager:
        encounter = await world.combat_manager.find_encounter_in_sector(character.sector)
        if encounter and not encounter.ended:
            # Player joined into active combat - send them current round state
            from combat.utils import serialize_round_waiting_event

            round_waiting_payload = await serialize_round_waiting_event(
                world,
                encounter,
                viewer_id=character_id
            )
            round_waiting_payload["source"] = build_event_source("join", request_id)

            await event_dispatcher.emit(
                "combat.round_waiting",
                round_waiting_payload,
                character_filter=[character_id],
            )

    return rpc_success()
```

Apply the same pattern to:
- `list_known_ports` → inject `source` via `build_event_source("list_known_ports", request_id)` before emitting `ports.list`
- `path_with_region` → inject `source` via `build_event_source("path_with_region", request_id)` before emitting `path.region`

**Testing:**

```python
# tests/test_join_combat.py

@pytest.mark.asyncio
async def test_join_into_active_combat(mock_world, mock_dispatcher):
    """Test joining into a sector with active combat."""
    # Setup active combat in sector 10
    mock_encounter = create_mock_encounter(sector_id=10, round_number=2)
    mock_world.combat_manager.find_encounter_in_sector.return_value = mock_encounter

    result = await handle(
        {"character_id": "new_arrival"},
        mock_world
    )

    assert result == {"success": True}

    # Verify combat.round_waiting was sent to new player
    round_waiting_calls = [
        call for call in mock_dispatcher.emit.call_args_list
        if call[0][0] == "combat.round_waiting"
    ]
    assert len(round_waiting_calls) == 1
    assert round_waiting_calls[0][1]["character_filter"] == ["new_arrival"]
```

**Acceptance Criteria:**
- [ ] `join` checks for active combat in player's starting sector
- [ ] If combat exists, emits `combat.round_waiting` to joining player
- [ ] Event includes full combat state (participants, round, deadline)
- [ ] `docs/event_catalog.md` updated for `combat.round_waiting`
- [ ] Tests pass

---

### Ticket 2.5.3: Verify Combat Events on Move Arrival

**Objective:** Ensure arriving players receive combat.round_waiting when emerging from hyperspace into combat.

**Current Code Location:** `game-server/api/move.py`

**Architecture Notes:**
- When `movement.complete` event is emitted, check if combat is active in destination sector
- If active combat exists, emit `combat.round_waiting` to the arriving character
- The player won't have full round time to submit an action (intentional design)

**Implementation:**

```python
# game-server/api/move.py (in movement completion logic)

# After emitting movement.complete event:

# NEW: Check for active combat in destination sector
if world.combat_manager:
    encounter = await world.combat_manager.find_encounter_in_sector(to_sector)
    if encounter and not encounter.ended:
        # Player arrived into active combat - send them current round state
        from combat.utils import serialize_round_waiting_event

        round_waiting_payload = await serialize_round_waiting_event(
            world,
            encounter,
            viewer_id=character_id
        )

        await event_dispatcher.emit(
            "combat.round_waiting",
            round_waiting_payload,
            character_filter=[character_id],
        )
```

**Testing:**

```python
# tests/test_move_combat.py

@pytest.mark.asyncio
async def test_arrive_into_active_combat(mock_world, mock_dispatcher):
    """Test arriving into a sector with active combat."""
    # Setup active combat in destination sector
    destination_sector = 42
    mock_encounter = create_mock_encounter(sector_id=destination_sector, round_number=3)
    mock_world.combat_manager.find_encounter_in_sector.return_value = mock_encounter

    result = await handle(
        {"character_id": "traveler", "to_sector": destination_sector},
        mock_world
    )

    assert result == {"success": True}

    # Verify combat.round_waiting was sent to arriving player
    round_waiting_calls = [
        call for call in mock_dispatcher.emit.call_args_list
        if call[0][0] == "combat.round_waiting"
    ]
    assert len(round_waiting_calls) == 1
    assert round_waiting_calls[0][1]["character_filter"] == ["traveler"]
```

**Acceptance Criteria:**
- [ ] `move` completion checks for active combat in destination sector
- [ ] If combat exists, emits `combat.round_waiting` to arriving player
- [ ] Event includes full combat state (participants, round, deadline)
- [ ] Tests pass

---

## Phase 3: Update Read-Only Endpoints

### Ticket 3.1: Implement status.snapshot Event (my_status)

**Objective:** Convert my_status to emit status.snapshot event.

**Current Code Location:** `game-server/api/my_status.py`

**Architecture Notes:**
- Status snapshot is personal data, sent only to requesting character
- Payload structure identical to current return value
- Reuse existing `build_status_payload()` utility

**Implementation:**

```python
# game-server/api/my_status.py

from fastapi import HTTPException
from .utils import build_status_payload, rpc_success, rpc_failure
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        return rpc_failure("Missing character_id")

    if character_id not in world.characters:
        return rpc_failure(f"Character '{character_id}' not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        return rpc_failure(
            "Character is in hyperspace, status unavailable until arrival"
        )

    # Build status payload (same as before)
    status_payload = await build_status_payload(world, character_id)
    request_id = request["request_id"]
    status_payload["source"] = build_event_source("my_status", request_id)

    # Emit event with status data
    await event_dispatcher.emit(
        "status.snapshot",
        status_payload,
        character_filter=[character_id],
    )

    # Return minimal success
    return rpc_success()
```

**Testing:**

```python
# tests/test_my_status.py

import pytest
from unittest.mock import AsyncMock, patch

@pytest.mark.asyncio
async def test_my_status_emits_event(mock_world, mock_dispatcher):
    """Test my_status emits status.snapshot event."""
    character_id = "test_char"
    mock_world.characters[character_id] = MockCharacter(
        character_id, sector=10, in_hyperspace=False
    )

    request_payload = {"character_id": character_id, "request_id": "req-123"}

    with patch('game-server.api.my_status.event_dispatcher', mock_dispatcher):
        result = await handle(request_payload, mock_world)

    # Verify RPC response
    assert result == {"success": True}

    # Verify event emission
    mock_dispatcher.emit.assert_called_once()
    call_args = mock_dispatcher.emit.call_args

    assert call_args[0][0] == "status.snapshot"
    payload = call_args[0][1]
    assert "player" in payload
    assert "ship" in payload
    assert "sector" in payload
    assert payload["source"]["request_id"] == "req-123"
    assert call_args[1]["character_filter"] == [character_id]


@pytest.mark.asyncio
async def test_my_status_missing_character():
    """Test my_status returns error for missing character."""
    result = await handle({"character_id": "nonexistent"}, mock_world)

    assert result == {
        "success": False,
        "error": "Character 'nonexistent' not found"
    }
```

**Acceptance Criteria:**
- [ ] Handler returns `{"success": True}` on success
- [ ] Handler returns `{"success": False, error: "..."}` on failure
- [ ] Emits `status.snapshot` event with full status payload
- [ ] Event sent only to requesting character
- [ ] `docs/event_catalog.md` documents `status.snapshot`
- [ ] Unit tests pass
- [ ] Integration test confirms WebSocket receives event

---

### Ticket 3.2: Implement map.knowledge Event (my_map)

**Objective:** Convert my_map to emit map.knowledge event.

**Current Code Location:** `game-server/api/my_map.py`

**Implementation:**

```python
# game-server/api/my_map.py

from fastapi import HTTPException
from .utils import rpc_success, rpc_failure
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        return rpc_failure("Missing character_id")

    # Load persisted knowledge (same logic as before)
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    data = knowledge.model_dump()

    # Determine authoritative current sector
    live_sector = None
    if hasattr(world, "characters") and character_id in world.characters:
        live_sector = world.characters[character_id].sector
    if live_sector is None:
        live_sector = data.get("current_sector", 0)

    # Expose sector and drop legacy naming
    data["sector"] = live_sector
    if "current_sector" in data:
        del data["current_sector"]

    # Emit map knowledge event
    request_id = request["request_id"]
    data["source"] = build_event_source("my_map", request_id)
    await event_dispatcher.emit(
        "map.knowledge",
        data,
        character_filter=[character_id],
    )

    return rpc_success()
```

**Testing:**

```python
# tests/test_my_map.py

@pytest.mark.asyncio
async def test_my_map_emits_event(mock_world, mock_dispatcher):
    """Test my_map emits map.knowledge event."""
    character_id = "test_char"

    request_payload = {"character_id": character_id, "request_id": "req-map"}

    with patch('game-server.api.my_map.event_dispatcher', mock_dispatcher):
        result = await handle(request_payload, mock_world)

    assert result == {"success": True}

    mock_dispatcher.emit.assert_called_once()
    call_args = mock_dispatcher.emit.call_args

    assert call_args[0][0] == "map.knowledge"
    payload = call_args[0][1]
    assert "sector" in payload
    assert "sectors_visited" in payload
    assert payload["source"]["request_id"] == "req-map"
    assert call_args[1]["character_filter"] == [character_id]
```

**Acceptance Criteria:**
- [ ] Handler returns minimal success/failure response
- [ ] Emits `map.knowledge` event with complete map data
- [ ] Event sent only to requesting character
- [ ] `docs/event_catalog.md` documents `map.knowledge`
- [ ] Tests pass

---

### Ticket 3.3: Remove Redundant Return Data (plot_course)

**Objective:** plot_course already emits course.plot event; just remove return data.

**Current Code Location:** `game-server/api/plot_course.py`

**Implementation:**

```python
# game-server/api/plot_course.py

from fastapi import HTTPException
from .utils import rpc_success, rpc_failure
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    if not world.universe_graph:
        return rpc_failure("Game world not loaded")

    character_id = request.get("character_id")
    to_sector = request.get("to_sector")

    if not character_id:
        return rpc_failure("Missing character_id")
    if to_sector is None:
        return rpc_failure("Missing to_sector")

    # Get character's current sector
    character = world.characters.get(character_id)
    if not character:
        return rpc_failure(f"Character not found: {character_id}")

    from_sector = character.sector

    if to_sector < 0:
        return rpc_failure("Sectors must be non-negative")

    if to_sector >= world.universe_graph.sector_count:
        return rpc_failure(f"Invalid to_sector: {to_sector}")

    path = world.universe_graph.find_path(from_sector, to_sector)
    if path is None:
        return rpc_failure(
            f"No path found from sector {from_sector} to sector {to_sector}"
        )

    # Emit course.plot event (already exists!)
    request_id = request["request_id"]
    await event_dispatcher.emit(
        "course.plot",
        {
            "source": build_event_source("plot_course", request_id),
            "from_sector": from_sector,
            "to_sector": to_sector,
            "path": path,
            "distance": len(path) - 1,
        },
        character_filter=[character_id],
    )

    # Return minimal success (REMOVED: redundant path data)
    return rpc_success()
```

**Testing:**

```python
# tests/test_plot_course.py

@pytest.mark.asyncio
async def test_plot_course_minimal_response(mock_world, mock_dispatcher):
    """Test plot_course returns minimal response, emits event."""
    character_id = "test_char"
    mock_world.characters[character_id] = MockCharacter(
        character_id, sector=0
    )
    mock_world.universe_graph.find_path.return_value = [0, 1, 2]

    request_payload = {
        "character_id": character_id,
        "to_sector": 2,
        "request_id": "req-course",
    }

    with patch('game-server.api.plot_course.event_dispatcher', mock_dispatcher):
        result = await handle(request_payload, mock_world)

    # Minimal response
    assert result == {"success": True}

    # Event emitted with path data
    mock_dispatcher.emit.assert_called_once()
    call_args = mock_dispatcher.emit.call_args
    assert call_args[0][0] == "course.plot"
    payload = call_args[0][1]
    assert payload["path"] == [0, 1, 2]
    assert payload["distance"] == 2
    assert payload["source"]["request_id"] == "req-course"
```

**Acceptance Criteria:**
- [ ] Handler returns minimal success/failure response
- [ ] Existing `course.plot` event unchanged
- [ ] No redundant data in RPC response
- [ ] `docs/event_catalog.md` confirms `course.plot` schema and source metadata
- [ ] Tests pass

---

### Ticket 3.4-3.6: Implement Remaining Map Events

**Similar pattern for:**
- **3.4:** `local_map_region` → emit `map.region`
- **3.5:** `list_known_ports` → emit `ports.list`
- **3.6:** `path_with_region` → emit `path.region`

**Template Implementation:**

```python
# game-server/api/local_map_region.py (example)

async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    character_id = request.get("character_id")
    if not character_id:
        return rpc_failure("Missing character_id")

    # ... validation logic ...

    # Build map data (existing logic)
    map_data = await build_local_map_region(
        world,
        character_id=character_id,
        center_sector=center_sector,
        max_hops=max_hops,
        max_sectors=max_sectors,
    )

    # Emit event
    request_id = request["request_id"]
    map_data["source"] = build_event_source(endpoint="local_map_region", request_id=request_id)
    await event_dispatcher.emit(
        "map.region",
        map_data,
        character_filter=[character_id],
    )

    return rpc_success()
```

**Acceptance Criteria (each ticket):**
- [ ] Handler returns minimal success/failure
- [ ] Emits appropriate event with data
- [ ] Event sent only to requesting character
- [ ] `docs/event_catalog.md` documents `map.region`, `ports.list`, and `path.region`
- [ ] Tests pass

---

## Phase 4: Update State-Modifying Endpoints

### Ticket 4.1: Emit status.snapshot on Join (join)

**Objective:** Convert join to emit status.snapshot event, remove character.joined event.

**Current Code Location:** `game-server/api/join.py`

**Architecture Notes:**
- Remove `character.joined` event emission (redundant)
- Replace return payload with `status.snapshot` event
- Keep `character.moved` event for rejoin with sector change
- `status.snapshot` provides all the information that character.joined provided and more

**Implementation:**

```python
# game-server/api/join.py (modify end of handle function)

async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if character_id is None or character_id == "":
        return rpc_failure("Invalid or missing character_id")

    # ... all existing join logic ...

    # REMOVE: character.joined event emission
    # Before:
    # if is_new_character:
    #     await event_dispatcher.emit("character.joined", {...})

    # Build status payload
    status_payload = await build_status_payload(world, character_id)
    request_id = request["request_id"]
    status_payload["source"] = build_event_source("join", request_id)

    # Emit status.snapshot event (NEW - replaces both return payload and character.joined)
    await event_dispatcher.emit(
        "status.snapshot",
        status_payload,
        character_filter=[character_id],
    )

    # Return minimal success (CHANGED from returning status_payload)
    return rpc_success()
```

**Testing:**

```python
# tests/test_join.py

@pytest.mark.asyncio
async def test_join_emits_status_snapshot(mock_world, mock_dispatcher):
    """Test join emits status.snapshot event."""
    with patch('game-server.api.join.event_dispatcher', mock_dispatcher):
        result = await handle(
            {"character_id": "new_char", "request_id": "req-join"},
            mock_world
        )

    assert result == {"success": True}

    # Verify status.snapshot event
    status_calls = [
        call for call in mock_dispatcher.emit.call_args_list
        if call[0][0] == "status.snapshot"
    ]
    assert len(status_calls) == 1

    payload = status_calls[0][0][1]
    assert "player" in payload
    assert "ship" in payload
    assert "sector" in payload
    assert payload["source"]["request_id"] == "req-join"
    assert status_calls[0][1]["character_filter"] == ["new_char"]

    # Verify character.joined is NOT emitted
    joined_calls = [
        call for call in mock_dispatcher.emit.call_args_list
        if call[0][0] == "character.joined"
    ]
    assert len(joined_calls) == 0
```

**Acceptance Criteria:**
- [ ] Handler returns minimal success/failure
- [ ] Emits `status.snapshot` event with full status
- [ ] Does NOT emit `character.joined` event
- [ ] `character.moved` event still emitted for rejoin with sector change
- [ ] `docs/event_catalog.md` documents `status.snapshot` correlation for join
- [ ] Tests pass

---

### Ticket 4.2: Enhance trade.executed Event

**Objective:** Add trade result details to trade.executed event.

**Current Code Location:** `game-server/api/trade.py`

**Current Event Payload:**
```python
# Currently emits minimal payload:
{
    "player": player_self(world, character_id),
    "ship": ship_self(world, character_id),
}
```

**Enhanced Event Payload:**
```python
# Should include trade details:
{
    "player": player_self(world, character_id),
    "ship": ship_self(world, character_id),
    "trade": {
        "trade_type": "buy",
        "commodity": "quantum_foam",
        "units": 100,
        "price_per_unit": 25,
        "total_price": 2500,
        "new_credits": 7500,
        "new_cargo": {"quantum_foam": 100, ...},
    }
}
```

**Implementation:**

```python
# game-server/api/trade.py

async def _execute_trade(...) -> dict:
    """Execute trade operation (must be called with port lock held)."""
    # ... existing trade logic ...

    if trade_type == "buy":
        # ... buy logic ...

        # Emit trade.executed event (ENHANCED)
        await event_dispatcher.emit(
            "trade.executed",
            {
                "player": player_self(world, character_id),
                "ship": ship_self(world, character_id),
                "trade": {  # NEW: trade details
                    "trade_type": "buy",
                    "commodity": commodity,
                    "units": quantity,
                    "price_per_unit": price_per_unit,
                    "total_price": total_price,
                    "new_credits": new_credits,
                    "new_cargo": updated_cargo,
                    "new_prices": new_prices,
                }
            },
            character_filter=[character_id],
        )

        # Emit port.update (unchanged)
        # ... existing port.update logic ...

        # Return minimal success (CHANGED)
        return rpc_success()
    else:
        # ... similar for sell ...
        return rpc_success()
```

**Testing:**

```python
# tests/test_trade.py

@pytest.mark.asyncio
async def test_trade_emits_enhanced_event(mock_world, mock_dispatcher):
    """Test trade emits enhanced trade.executed event."""
    character_id = "test_trader"

    with patch('game-server.api.trade.event_dispatcher', mock_dispatcher):
        result = await handle(
            {
                "character_id": character_id,
                "commodity": "quantum_foam",
                "quantity": 100,
                "trade_type": "buy",
            },
            mock_world,
            port_locks=None,
        )

    assert result == {"success": True}

    # Find trade.executed event
    trade_calls = [
        call for call in mock_dispatcher.emit.call_args_list
        if call[0][0] == "trade.executed"
    ]
    assert len(trade_calls) == 1

    payload = trade_calls[0][0][1]
    assert "trade" in payload
    assert payload["trade"]["commodity"] == "quantum_foam"
    assert payload["trade"]["units"] == 100
    assert payload["trade"]["trade_type"] == "buy"
```

**Acceptance Criteria:**
- [ ] Handler returns minimal success/failure
- [ ] `trade.executed` event includes full trade details
- [ ] `port.update` event unchanged
- [ ] `docs/event_catalog.md` documents enhanced `trade.executed`
- [ ] Tests pass

---

### Ticket 4.3-4.4: Enhance Warp Power Events

**Similar pattern for:**
- **4.3:** `recharge_warp_power` → enhance `warp.purchase` event
- **4.4:** `transfer_warp_power` → enhance `warp.transfer` event

**Template (recharge_warp_power):**

```python
# game-server/api/recharge_warp_power.py

async def handle(request: dict, world) -> dict:
    # ... validation and purchase logic ...

    # Emit enhanced warp.purchase event
    await event_dispatcher.emit(
        "warp.purchase",
        {
            "character_id": character_id,
            "sector": {"id": character.sector},
            "units": units_to_buy,
            "price_per_unit": price_per_unit,
            "total_cost": total_cost,
            "timestamp": timestamp,
            # NEW: additional details
            "new_warp_power": new_warp_power,
            "warp_power_capacity": warp_power_capacity,
            "new_credits": new_credits,
        },
        character_filter=[character_id],
    )

    # Emit status.update (already exists)
    status_payload = await build_status_payload(world, character_id)
    await event_dispatcher.emit(
        "status.update",
        status_payload,
        character_filter=[character_id]
    )

    return rpc_success()
```

**Acceptance Criteria (each ticket):**
- [ ] Handler returns minimal success/failure
- [ ] Enhanced event includes all necessary data
- [ ] `docs/event_catalog.md` documents updated `warp.purchase` / `warp.transfer`
- [ ] Tests pass

---

### Ticket 4.5: Simplify combat.initiate Response and Enhance combat.round_waiting

**Objective:** Convert combat.initiate to return minimal response; enhance combat.round_waiting to include initiator.

**Current Code Locations:**
- `game-server/api/combat_initiate.py`
- `game-server/combat/callbacks.py` (on_round_waiting)
- `game-server/combat/utils.py` (serialize_round_waiting_event)

**Architecture Notes:**
- `combat.initiate` currently returns full encounter details including `initiator`, `target`, `target_type`
- `combat.round_waiting` is already emitted via async task and contains most necessary data
- Add `initiator` field to `combat.round_waiting` event (round 1 only)
- Do not include `target` or `target_type` (not needed - participants array shows everyone)
- After round 1, `initiator` should be `null` or omitted

**Implementation Part 1: API Handler**

```python
# game-server/api/combat_initiate.py

from api.utils import rpc_success, rpc_failure

async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    target_id = request.get("target_id")
    target_type = (request.get("target_type") or "character").lower()

    if not character_id:
        return rpc_failure("Missing character_id")

    if character_id not in world.characters:
        return rpc_failure(f"Character '{character_id}' not found")

    # ... validation logic ...

    sector_id = initiator.sector
    payload = await start_sector_combat(
        world,
        sector_id=sector_id,
        initiator_id=character_id,  # This gets stored in encounter.context
        garrisons_to_include=None,
        reason="manual",
    )

    # Note: combat.round_waiting emitted by async task in start_sector_combat
    # The initiator is stored in encounter.context["initiator"] and will be
    # included in the round_waiting event for round 1

    # Return minimal success with combat_id (CHANGED from returning full payload)
    return rpc_success({"combat_id": payload["combat_id"]})
```

**Implementation Part 2: Update serialize_round_waiting_event**

```python
# game-server/combat/utils.py

async def serialize_round_waiting_event(
    world,
    encounter: CombatEncounter,
    viewer_id: Optional[str] = None,
) -> dict:
    """Serialize combat.round_waiting event.

    Returns dict with:
    - combat_id, sector, round
    - current_time, deadline
    - participants (array of character participants only)
    - garrison (singular object if present, else None)
    - initiator (character_id who started combat, round 1 only)
    """
    current_time = datetime.now(timezone.utc)

    participants: list[dict] = []
    ship_payload: Optional[dict] = None
    garrison = None
    actual_garrison = None

    # Fetch actual garrison if present in sector
    garrisons_in_sector = await _list_sector_garrisons(world, encounter.sector_id)
    if garrisons_in_sector:
        actual_garrison = garrisons_in_sector[0]

    for state in encounter.participants.values():
        # ... existing participant serialization ...
        if state.combatant_type == "character":
            participants.append(
                serialize_participant_for_event(
                    world,
                    state,
                    shield_integrity=shield_integrity,
                )
            )
            ship_candidate = _build_ship_payload(world, viewer_id, state)
            if ship_candidate is not None:
                ship_payload = ship_candidate
        elif state.combatant_type == "garrison":
            garrison = serialize_garrison_for_event(state, actual_garrison)

    payload = {
        "combat_id": encounter.combat_id,
        "sector": {"id": encounter.sector_id},
        "round": encounter.round_number,
        "current_time": current_time.isoformat(),
        "deadline": encounter.deadline.isoformat() if encounter.deadline else None,
        "participants": participants,
        "garrison": garrison,
    }

    # NEW: Add initiator field for round 1 only
    if encounter.round_number == 1:
        initiator_id = encounter.context.get("initiator") if encounter.context else None
        payload["initiator"] = initiator_id  # Will be character_id or None
    # After round 1, initiator is omitted (not set to null, just not included)

    if ship_payload:
        payload["ship"] = ship_payload
    return payload
```

**Testing:**

```python
# tests/test_combat_initiate.py

@pytest.mark.asyncio
async def test_combat_initiate_minimal_response(mock_world, mock_dispatcher):
    """Test combat.initiate returns minimal response."""
    with patch('game-server.api.combat_initiate.event_dispatcher', mock_dispatcher):
        result = await handle(
            {"character_id": "attacker", "target_id": "defender"},
            mock_world
        )

    # Verify minimal response
    assert result["success"] is True
    assert "combat_id" in result
    assert len(result) == 2  # Only success and combat_id

    # Verify combat.round_waiting was emitted (by start_sector_combat async task)
    round_waiting_calls = [
        call for call in mock_dispatcher.emit.call_args_list
        if call[0][0] == "combat.round_waiting"
    ]
    assert len(round_waiting_calls) == 1

    payload = round_waiting_calls[0][0][1]
    assert "combat_id" in payload
    assert "participants" in payload
    assert "sector" in payload
    assert "round" in payload

    # NEW: Verify initiator field present in round 1
    assert payload["round"] == 1
    assert "initiator" in payload
    assert payload["initiator"] == "attacker"


@pytest.mark.asyncio
async def test_combat_round_waiting_no_initiator_after_round_1(mock_world, mock_encounter):
    """Test combat.round_waiting does not include initiator after round 1."""
    # Setup encounter in round 2
    mock_encounter.round_number = 2
    mock_encounter.context = {"initiator": "attacker"}  # stored but not used

    payload = await serialize_round_waiting_event(
        mock_world,
        mock_encounter,
        viewer_id="attacker"
    )

    # Verify initiator NOT in payload for round 2+
    assert payload["round"] == 2
    assert "initiator" not in payload
```

**Acceptance Criteria:**
- [ ] Handler returns `{"success": True, "combat_id": "..."}`
- [ ] `combat.round_waiting` event includes `initiator` field in round 1
- [ ] `combat.round_waiting` event does NOT include `initiator` after round 1
- [ ] `initiator` is character_id of who started combat
- [ ] `docs/event_catalog.md` documents updated `combat.round_waiting`
- [ ] Tests pass

---

### Ticket 4.6: Implement combat.action_accepted Event

**Objective:** Add confirmation event when combat action is submitted.

**Current Code Location:** `game-server/api/combat_action.py`

**Implementation:**

```python
# game-server/api/combat_action.py

async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    combat_id = request.get("combat_id")
    action_raw = request.get("action")
    # ... validation ...

    outcome = await world.combat_manager.submit_action(
        combat_id=combat_id,
        combatant_id=character_id,
        action=action,
        commit=commit,
        target_id=target_id,
        destination_sector=destination_sector,
    )

    # NEW: Emit action accepted event
    await event_dispatcher.emit(
        "combat.action_accepted",
        {
            "combat_id": combat_id,
            "round": updated.round_number if updated else encounter.round_number,
            "action": action_raw,
            "round_resolved": outcome is not None,
        },
        character_filter=[character_id],
    )

    # Note: If round resolved, combat.round_resolved will be emitted by callback

    return rpc_success({"combat_id": combat_id})
```

**Acceptance Criteria:**
- [ ] Handler returns minimal success
- [ ] Emits `combat.action_accepted` event
- [ ] Event sent only to submitting character
- [ ] `docs/event_catalog.md` documents `combat.action_accepted`
- [ ] Tests pass

---

### Ticket 4.7-4.10: Implement Garrison and Salvage Events

**Similar pattern for:**
- **4.7:** `combat.leave_fighters` → emit `garrison.deployed`
- **4.8:** `combat.collect_fighters` → emit `garrison.collected`
- **4.9:** `combat.set_garrison_mode` → emit `garrison.mode_changed`
- **4.10:** `salvage.collect` → emit `salvage.collected`

**Template (garrison.deployed):**

```python
# game-server/api/combat_leave_fighters.py

async def handle(request: dict, world) -> dict:
    # ... validation and deployment logic ...

    # NEW: Emit garrison.deployed event
    await event_dispatcher.emit(
        "garrison.deployed",
        {
            "sector": sector,
            "garrison": serialize_garrison_for_client(
                world, updated, sector, current_character_id=character_id
            ),
            "fighters_remaining": remaining,
        },
        character_filter=[character_id],
    )

    # Existing sector.update event (unchanged)
    characters_in_sector = [...]
    for cid in characters_in_sector:
        sector_payload = await sector_contents(world, sector, current_character_id=cid)
        await event_dispatcher.emit(
            "sector.update",
            sector_payload,
            character_filter=[cid],
        )

    return rpc_success()
```

**Acceptance Criteria (each ticket):**
- [ ] Handler returns minimal success/failure
- [ ] Emits appropriate new event
- [ ] Existing events (sector.update) unchanged
- [ ] `docs/event_catalog.md` documents `garrison.deployed`, `garrison.collected`, `garrison.mode_changed`, and `salvage.collected`
- [ ] Tests pass

---

## Phase 5: Client and Test Updates

### Ticket 5.1: Update AsyncGameClient for Event-Based Responses

**Objective:** Update AsyncGameClient to handle event-based data flow.

**Current Code Location:** `utils/api_client.py`

**Architecture Notes:**
- AsyncGameClient methods currently return full payloads. Under the new contract they should return only the RPC acknowledgment (e.g., `{"success": true}`) and rely on event handlers for data updates.
- Keep the existing event-dispatch system so callers can register handlers or consume per-event queues without coupling responses to specific RPC calls.
- Preserve the summary formatter pipeline for incoming events; remove summaries from RPC acknowledgments since they no longer contain domain data.
- Provide lightweight helper utilities (e.g., `get_event_queue(event_name)`) for callers that prefer awaiting events, without baking synchronous expectations into the core client.
- No backward compatibility needed—remove legacy REST transport paths.

**Implementation Pattern:**

```python
# utils/api_client.py

class AsyncGameClient:
    def __init__(self, base_url: str, character_id: str):
        self.base_url = base_url
        self.character_id = character_id
        self._ws = None
        self._reader_task = None
        self._event_queues: dict[str, asyncio.Queue] = defaultdict(asyncio.Queue)
        self._handlers: dict[str, list[Callable[[dict], Awaitable[None]]]] = defaultdict(list)

    async def connect(self) -> None:
        ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        self._ws = await websockets.connect(f"{ws_url}/ws")
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def _reader_loop(self) -> None:
        async for raw in self._ws:
            message = json.loads(raw)
            if message.get("frame_type") == "event":
                event = message["event"]
                payload = message.get("payload", {})
                payload = self._apply_summary(event, payload)
                await self._event_queues[event].put(payload)
                await self._dispatch(event, payload)
            elif message.get("frame_type") == "rpc_response":
                await self._handle_rpc_response(message)

    async def my_status(self) -> dict[str, bool]:
        response = await self._send_rpc("my_status", {"character_id": self.character_id})
        if not response.get("success"):
            raise RPCError("my_status", response.get("status", 500), response["error"])
        return response  # callers observe subsequent status.snapshot event separately

    def get_event_queue(self, event_name: str) -> asyncio.Queue:
        return self._event_queues[event_name]
```

**Testing:**

```python
@pytest.mark.asyncio
async def test_my_status_triggers_event(test_client):
    queue = test_client.get_event_queue("status.snapshot")

    ack = await test_client.my_status()
    assert ack == {"success": True}

    payload = await asyncio.wait_for(queue.get(), timeout=1)
    assert payload["player"]["id"] == test_client.character_id
```

**Acceptance Criteria:**
- [ ] AsyncGameClient methods return only RPC acknowledgments.
- [ ] Event listener continues dispatching to registered handlers/queues.
- [ ] Helper accessors documented for consumers that await events manually.
- [ ] Tests validate both the RPC acknowledgment and the emitted event.

---

### Ticket 5.2: Update Integration Tests

**Objective:** Update integration tests to verify events instead of return values.

**Test Strategy:**
- Tests should mock EventDispatcher
- Verify RPC responses are minimal
- Verify events are emitted with correct payloads
- Verify events sent to correct recipients

**Sample Test Pattern:**

```python
# tests/test_integration_events.py

@pytest.mark.asyncio
async def test_join_flow_event_driven(test_server, mock_dispatcher):
    """Test join operation emits expected events."""
    character_id = "test_integration_char"

    # Send join RPC
    response = await send_rpc(
        test_server,
        "join",
        {"character_id": character_id}
    )

    # Verify minimal RPC response
    assert response == {"success": True}

    # Verify events emitted
    calls = mock_dispatcher.emit.call_args_list
    event_names = [call[0][0] for call in calls]

    # Should emit: status.snapshot (NOT character.joined)
    assert "status.snapshot" in event_names
    assert "character.joined" not in event_names

    # Verify status.snapshot payload
    status_calls = [c for c in calls if c[0][0] == "status.snapshot"]
    assert len(status_calls) == 1

    payload = status_calls[0][0][1]
    assert "player" in payload
    assert "ship" in payload
    assert "sector" in payload

    # Verify event sent to joining character
    assert status_calls[0][1]["character_filter"] == [character_id]


@pytest.mark.asyncio
async def test_trade_flow_event_driven(test_server, mock_dispatcher):
    """Test trade operation emits enhanced trade.executed event."""
    # ... setup character, port ...

    response = await send_rpc(
        test_server,
        "trade",
        {
            "character_id": "trader",
            "commodity": "quantum_foam",
            "quantity": 100,
            "trade_type": "buy"
        }
    )

    assert response == {"success": True}

    # Verify trade.executed event has trade details
    trade_calls = [
        c for c in mock_dispatcher.emit.call_args_list
        if c[0][0] == "trade.executed"
    ]
    assert len(trade_calls) == 1

    payload = trade_calls[0][0][1]
    assert "trade" in payload
    assert payload["trade"]["commodity"] == "quantum_foam"
    assert payload["trade"]["units"] == 100
```

**Acceptance Criteria:**
- [ ] All integration tests updated
- [ ] Tests verify minimal RPC responses
- [ ] Tests verify event emissions
- [ ] Tests verify event payloads
- [ ] Tests verify event recipients
- [ ] All tests pass

---

## Phase 6: Documentation

### Ticket 6.1: Update API and Event Documentation

**Objective:** Document new event-driven API architecture.

**Files to Create/Update:**
- `docs/api-reference.md` - Complete API reference
- `docs/event-reference.md` - Complete event reference
- `docs/websocket-protocol.md` - WebSocket protocol documentation

**Event Reference Template:**

```markdown
# Event Reference

## status.snapshot

**Emitted By:** `my_status` endpoint

**Recipients:** Requesting character only

**Payload:**
```json
{
  "player": {
    "id": "character_id",
    "name": "Character Name",
    "credits_on_hand": 10000,
    "credits_in_bank": 0
  },
  "source": {
    "type": "rpc",
    "method": "my_status",
    "request_id": "abc123",
    "timestamp": "2024-01-01T00:00:00Z"
  },
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "SS Enterprise",
    "cargo": {"quantum_foam": 50},
    "cargo_capacity": 100,
    "warp_power": 150,
    "warp_power_capacity": 200,
    "shields": 50,
    "max_shields": 50,
    "fighters": 100,
    "max_fighters": 100
  },
  "sector": {
    "id": 42,
    "adjacent_sectors": [41, 43, 44],
    "port": {...},
    "players": [...],
    "garrison": {...},
    "salvage": [...]
  }
}
```

**Usage Example:**
```python
# Send RPC request (returns only ack)
await client.send_rpc("my_status", {"character_id": "my_char"})

# Consume the resulting event from a queue or handler
queue = client.get_event_queue("status.snapshot")
event = await asyncio.wait_for(queue.get(), timeout=1)
print(f"Current sector: {event['sector']['id']}")
```
```

**Acceptance Criteria:**
- [ ] API reference documents all endpoints
- [ ] Event reference documents all events
- [ ] WebSocket protocol documented
- [ ] Examples provided for common flows
- [ ] Migration guide included

---

### Ticket 6.2: Update CLAUDE.md

**Objective:** Update project instructions for Claude Code.

**Sections to Update:**
1. API Endpoints - Note minimal responses
2. Event System - Document new events
3. Client Usage - Show event-driven patterns
4. Testing - Update test patterns

**Sample Updates:**

```markdown
## API Endpoints

All endpoints now return minimal success/failure responses:
- Success: `{"success": true}` or `{"success": true, "id": "..."}`
- Failure: `{"success": false, "error": "error message"}`

All operational data is delivered via WebSocket events.

### AsyncGameClient Usage

```python
# Connect with event-driven communication
client = AsyncGameClient(
    base_url="http://localhost:8000",
    character_id="my_char"
)
await client.connect()

# Call API methods (they await events internally)
status = await client.my_status()  # Waits for status.snapshot event
```

## Events Reference

See [docs/event-reference.md](docs/event-reference.md) for complete event documentation.

Common events:
- `status.snapshot` - Full status on demand or after join
- `movement.complete` - After move completes
- `trade.executed` - After trade succeeds
- `combat.round_resolved` - After combat round
```

**Acceptance Criteria:**
- [ ] CLAUDE.md updated with event-driven architecture
- [ ] Examples show correct usage patterns
- [ ] check_trade removal noted
- [ ] Admin/test endpoint exceptions noted

---

## Phase 7: NPC Updates and Cleanup (Future Work)

This phase will be completed **after** AsyncGameClient is fully tested and stable.

### Ticket 7.1: Update NPC Scripts for Event-Driven AsyncGameClient

**Objective:** Update NPC task agent and scripts to use the new event-driven AsyncGameClient.

**Files to Modify:**
- `npc/run_npc.py`
- Any other NPC-related scripts

**Implementation:**

```python
# npc/run_npc.py

async def main():
    # ... setup ...

    # AsyncGameClient now requires WebSocket connection
    client = AsyncGameClient(
        base_url=server_url,
        character_id=character_id
    )

    await client.connect()  # Connect WebSocket

    # ... rest of NPC logic unchanged ...

    await client.close()  # Clean up WebSocket
```

**Testing:**
```bash
# Manual test: Run NPC with event-driven client
export OPENAI_API_KEY="..."
uv run npc/run_npc.py test_npc "Move to sector 5"

# Verify:
# - NPC connects via WebSocket
# - NPC receives events
# - NPC completes task successfully
```

**Acceptance Criteria:**
- [ ] NPCs use event-driven AsyncGameClient
- [ ] NPCs connect to WebSocket on startup
- [ ] NPCs receive and process events correctly
- [ ] Manual testing confirms NPCs work end-to-end

---

### Ticket 7.2: Remove Old Terminal Viewers

**Objective:** Remove outdated terminal viewer scripts.

**Files to Delete:**
- `tools/firehose_viewer.py`
- `tools/character_viewer.py`

**Rationale:**
These viewers are outdated and need to be redesigned based on the new event-driven architecture. Remove them for now and create new monitoring tools as needed in the future.

**Implementation:**
```bash
git rm tools/firehose_viewer.py
git rm tools/character_viewer.py
```

**Acceptance Criteria:**
- [ ] `tools/firehose_viewer.py` removed
- [ ] `tools/character_viewer.py` removed
- [ ] No references to these files remain in codebase
- [ ] CLAUDE.md updated to remove references

---

### Ticket 7.3: Design New Monitoring Tools (Optional)

**Objective:** Design new event-driven monitoring and visualization tools.

**Considerations:**
- Use WebSocket event stream
- Display real-time game state
- Support filtering by event type, character, sector
- Consider web-based UI vs terminal-based UI

**This is optional future work to be scoped separately.**

---

## Summary

This implementation plan provides detailed tickets for all phases with:
- Sample code for each change
- Architecture notes
- Testing strategies
- Clear acceptance criteria

**Total Estimated Effort:**
- Phase 1: 2 days (Infrastructure setup)
- Phase 2: 1 day (Remove check_trade)
- Phase 2.5: 1 day (Remove combat.status and verify combat events)
- Phase 3: 2 days (Read-only endpoints)
- Phase 4: 3 days (State-modifying endpoints)
- Phase 5: 3 days (AsyncGameClient and test updates)
- Phase 6: 2 days (Documentation)
- **Total: 14 days**

**Future Work (Phase 7):**
- NPC script updates (2-3 days, after AsyncGameClient is stable)
- Remove old terminal viewers
- Design new monitoring/visualization tools as needed

**Next Steps:**
1. Review and approve this design
2. Create tracking issues for each ticket
3. Begin Phase 1 implementation
4. Iterate based on learnings from each phase

---

# Next Actions

## Before Starting Implementation

1. **Review this design document** with the team
2. **Confirm scope:** Verify all 24 API handlers are correctly documented
3. **Validate event list:** Ensure all 10 new events cover all use cases
4. **Check dependencies:** Verify server has WebSocket support at `/ws`
5. **Review AsyncGameClient:** Understand current implementation before refactoring

## Implementation Checklist

### Phase 1: Infrastructure (Day 1-2)
- [ ] Create `game-server/api/utils.py` with `rpc_success()` and `rpc_failure()`
- [ ] Add `emit_error_event()` helper
- [ ] Write unit tests for utilities
- [ ] **Checkpoint:** All handlers can import and use utilities

### Phase 2: Remove Endpoints (Day 3)
- [ ] Delete `check_trade` endpoint, client method, and tool
- [ ] Delete `combat.status` endpoint, client method, and tool
- [ ] Remove all references from codebase
- [ ] **Checkpoint:** Server starts, no import errors

### Phase 2.5: Verify Combat Events (Day 4)
- [ ] Add combat event emission to `join` handler
- [ ] Add combat event emission to `move` handler
- [ ] Write tests for both code paths
- [ ] **Checkpoint:** Integration tests pass for join/move into combat

### Phase 3: Read-Only Endpoints (Day 5-6)
- [ ] Update `my_status`, `my_map`, `plot_course`
- [ ] Update `local_map_region`, `list_known_ports`, `path_with_region`
- [ ] Write tests for each
- [ ] **Checkpoint:** All read-only endpoints return minimal responses and emit events

### Phase 4: State-Modifying Endpoints (Day 7-9)
- [ ] Update `join` (remove character.joined)
- [ ] Update `trade`, `recharge_warp_power`, `transfer_warp_power`
- [ ] Update `combat.initiate` (add initiator to round_waiting)
- [ ] Update `combat.action` (add action_accepted event)
- [ ] Update garrison endpoints (deployed, collected, mode_changed)
- [ ] Update `salvage.collect`
- [ ] **Checkpoint:** All endpoints event-driven, server tests pass

### Phase 5: Client Updates (Day 10-12)
- [ ] Refactor AsyncGameClient with WebSocket-only transport
- [ ] Ensure `_event_listener()` dispatches to handlers and per-event queues
- [ ] Provide helper API for consumers to obtain event queues (optional)
- [ ] Update all client methods to return minimal RPC acknowledgments
- [ ] Document recommended client-side event handling patterns
- [ ] **Checkpoint:** Client tests pass, can join/move/trade using event-driven flow

### Phase 6: Test Updates (Day 12)
- [ ] Update all integration tests
- [ ] Verify events emitted correctly
- [ ] Verify event recipients correct
- [ ] Add shared pytest helper for asserting `character_filter` (and metadata) on mocked emits
- [ ] **Checkpoint:** Full test suite passes

### Phase 7: Documentation (Day 13-14)
- [ ] Create `docs/api-reference.md`
- [ ] Create `docs/event-reference.md`
- [ ] Create `docs/websocket-protocol.md`
- [ ] Update `CLAUDE.md`
- [ ] **Checkpoint:** Documentation complete

### Phase 8: Final Validation
- [ ] Run full test suite
- [ ] Manual testing: join, move, trade, combat
- [ ] Verify no data in RPC responses (except success/error)
- [ ] Verify all events emitted with correct payloads
- [ ] **Checkpoint:** Ready for production

## Post-Implementation (Phase 7 - Future)

- [ ] Update NPC scripts
- [ ] Remove old terminal viewers
- [ ] Design new monitoring tools
- [ ] Consider event replay mechanism
- [ ] Consider event subscription filtering

## Key Success Criteria

✅ **All RPC responses contain only** `{success: true/false, error?: "..."}`
✅ **All game data flows through events**
✅ **Tests verify events, not return values**
✅ **AsyncGameClient works end-to-end**
✅ **No backward compatibility code remaining**

---

**Document Status:** Ready for review and implementation
**Last Updated:** 2025-10-15
**Author:** Design document for Gradient Bang event-driven API refactoring
