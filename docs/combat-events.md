# Combat Events (Supabase Functions)

## Scope
This document is based on the current Supabase edge-function combat flow in `deployment/supabase/functions`:
- Core: `combat_initiate`, `combat_action`, `combat_tick`
- Shared combat runtime: `_shared/combat_resolution.ts`, `_shared/combat_engine.ts`, `_shared/combat_events.ts`, `_shared/combat_finalization.ts`
- Garrison combat paths: `combat_leave_fighters`, `combat_collect_fighters`, `combat_set_garrison_mode`, `_shared/garrison_combat.ts`
- Auto-join and auto-engage hooks: `join`, `move`

## Combat Flow (How It Works)
1. Combat starts from `combat_initiate`, auto-engage on move/join (`_shared/garrison_combat.ts`), or offensive garrison deploy (`combat_leave_fighters`).
2. A `combat.round_waiting` event is emitted with round state and deadline.
3. Players submit actions via `combat_action` (`attack`, `brace`, `flee`, `pay`), and receive `combat.action_accepted`.
4. A round resolves when everyone required has acted or deadline expires (`combat_tick` also resolves overdue rounds).
5. On each resolution, `combat.round_resolved` is emitted.
6. If combat continues, shields regenerate and another `combat.round_waiting` is emitted.
7. If combat ends, finalization runs (escape pod conversion, salvage, ship destruction, garrison updates), then `combat.ended` is emitted to participants, plus sector-level follow-up events.

Runtime defaults:
- Round timeout: `COMBAT_ROUND_TIMEOUT` (default `15` seconds)
- Shield regen between rounds: `SHIELD_REGEN_PER_ROUND` (default `10`)

## Event Quick Map
| Event | Sent When | Recipients |
|---|---|---|
| `combat.round_waiting` | Combat starts, new round begins, or join replay for active combat | Usually sector + corp visibility; join replay is direct to joining character |
| `combat.action_accepted` | `combat_action` accepted and stored | Direct to acting character |
| `combat.round_resolved` | A round resolves | Sector + corp visibility |
| `combat.ended` | Combat reaches terminal state | Direct to each participant only (personalized payload) |
| `ship.destroyed` | A character participant is defeated | Sector + defeated ship's corp visibility |
| `salvage.created` | Defeated ship produced salvage | Sector visibility |
| `sector.update` (full) | After `combat.ended` finalization | Sector visibility |
| `garrison.deployed` | Fighters deployed as garrison | Direct to deployer |
| `garrison.collected` | Fighters collected from garrison | Direct to collector |
| `garrison.mode_changed` | Garrison mode changed | Direct to owner |
| `status.update` (combat-adjacent) | Toll payout credited during `combat_collect_fighters` | Direct to collector |
| `sector.update` (minimal) | Garrison collect/mode-change sector notification | Sector visibility |
| `garrison.character_moved` (combat-adjacent) | Character moved in a sector with garrisons | Garrison owner + garrison corp members |
| `error` | Combat/garrison endpoint validation, auth, or rate-limit failures | Direct to caller |

## Payload Notes
- Events emitted through `emitCharacterEvent`/`pgEmitCharacterEvent` inject `player.id` if missing.
- Ship-scoped direct events may also inject top-level `ship_id` when no `ship` block exists.
- `combat.round_waiting`/`combat.round_resolved` sector broadcasts use `recordEventWithRecipients`, so they do not auto-inject `player`.
- `combat.action_response` is not emitted by current edge functions; emitted event is `combat.action_accepted`.
- In `combat.round_resolved`, `actions` map keys are participant display names (not IDs).

---

## 1) `combat.round_waiting`
Sent when:
- New combat encounter is created
- Combat continues to next round after resolution
- Character joins an already-active combat in `join` flow

### Example payload
```json
{
  "combat_id": "9f6d3c2c4d6f47f19d40a2f31a9d4a7b",
  "sector": { "id": 42 },
  "round": 1,
  "current_time": "2026-02-06T22:14:01.002Z",
  "deadline": "2026-02-06T22:14:16.002Z",
  "initiator": "Captain Vega",
  "participants": [
    {
      "created_at": "2025-12-01T09:00:00.000Z",
      "name": "Captain Vega",
      "player_type": "human",
      "ship": {
        "ship_type": "merchant_cruiser",
        "ship_name": "Asteria",
        "shield_integrity": 100,
        "shield_damage": null,
        "fighter_loss": null
      }
    },
    {
      "created_at": "2025-12-02T10:00:00.000Z",
      "name": "Rook AI",
      "player_type": "corporation_ship",
      "ship": {
        "ship_type": "interceptor",
        "ship_name": "Rook-7",
        "shield_integrity": 100,
        "shield_damage": null,
        "fighter_loss": null
      }
    }
  ],
  "garrison": {
    "owner_name": "Marshal Kira",
    "fighters": 120,
    "fighter_loss": null,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "2026-02-06T21:59:12.120Z"
  },
  "source": {
    "type": "rpc",
    "method": "combat.round_waiting",
    "request_id": "req-01HXYZ9M7P0W",
    "timestamp": "2026-02-06T22:14:01.002Z"
  }
}
```

### Mock payload template
```json
{
  "combat_id": "<combat_id>",
  "sector": { "id": 0 },
  "round": 1,
  "current_time": "<iso_time>",
  "deadline": "<iso_time_or_null>",
  "initiator": "<optional_initiator_name_or_id>",
  "participants": [
    {
      "created_at": "<iso_time>",
      "name": "<participant_name>",
      "player_type": "human",
      "ship": {
        "ship_type": "<ship_type>",
        "ship_name": "<ship_name>",
        "shield_integrity": 100,
        "shield_damage": null,
        "fighter_loss": null
      }
    }
  ],
  "garrison": null,
  "source": {
    "type": "rpc",
    "method": "combat.round_waiting",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  }
}
```

---

## 2) `combat.action_accepted`
Sent when:
- `combat_action` validates and stores a submitted action

### Example payload
```json
{
  "combat_id": "9f6d3c2c4d6f47f19d40a2f31a9d4a7b",
  "round": 2,
  "action": "attack",
  "commit": 35,
  "target_id": "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df",
  "source": {
    "type": "rpc",
    "method": "combat.action",
    "request_id": "req-01HXYZA20M2N",
    "timestamp": "2026-02-06T22:14:08.341Z"
  },
  "player": { "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8" },
  "ship_id": "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9"
}
```

### Mock payload template
```json
{
  "combat_id": "<combat_id>",
  "round": 1,
  "action": "attack",
  "commit": 10,
  "target_id": "<target_combatant_id_or_null>",
  "source": {
    "type": "rpc",
    "method": "combat.action",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "player": { "id": "<character_id>" },
  "ship_id": "<ship_id>"
}
```

---

## 3) `combat.round_resolved`
Sent when:
- A round resolves (all required actions submitted, or deadline timeout)

### Example payload
```json
{
  "combat_id": "9f6d3c2c4d6f47f19d40a2f31a9d4a7b",
  "sector": { "id": 42 },
  "round": 1,
  "hits": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 7,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 4,
    "garrison:42:6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97": 3
  },
  "offensive_losses": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 2,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 5,
    "garrison:42:6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97": 1
  },
  "defensive_losses": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 5,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 6,
    "garrison:42:6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97": 2
  },
  "shield_loss": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 3,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 3,
    "garrison:42:6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97": 0
  },
  "fighters_remaining": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 88,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 61,
    "garrison:42:6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97": 117
  },
  "shields_remaining": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 197,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 157,
    "garrison:42:6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97": 0
  },
  "flee_results": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": false,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": false,
    "garrison:42:6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97": false
  },
  "end": null,
  "result": null,
  "deadline": "2026-02-06T22:14:16.002Z",
  "round_result": null,
  "participants": [
    {
      "created_at": "2025-12-01T09:00:00.000Z",
      "name": "Captain Vega",
      "player_type": "human",
      "ship": {
        "ship_type": "merchant_cruiser",
        "ship_name": "Asteria",
        "shield_integrity": 98.5,
        "shield_damage": 1.5,
        "fighter_loss": 7
      }
    }
  ],
  "garrison": {
    "owner_name": "Marshal Kira",
    "fighters": 120,
    "fighter_loss": 3,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "2026-02-06T21:59:12.120Z"
  },
  "actions": {
    "Captain Vega": {
      "action": "attack",
      "commit": 35,
      "timed_out": false,
      "submitted_at": "2026-02-06T22:14:08.100Z",
      "target": "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df",
      "destination_sector": null
    },
    "Rook AI": {
      "action": "brace",
      "commit": 0,
      "timed_out": true,
      "submitted_at": "2026-02-06T22:14:16.002Z",
      "target": null,
      "destination_sector": null
    }
  },
  "source": {
    "type": "rpc",
    "method": "combat.round_resolved",
    "request_id": "req-01HXYZA20M2N",
    "timestamp": "2026-02-06T22:14:16.014Z"
  }
}
```

### Mock payload template
```json
{
  "combat_id": "<combat_id>",
  "sector": { "id": 0 },
  "round": 1,
  "hits": {},
  "offensive_losses": {},
  "defensive_losses": {},
  "shield_loss": {},
  "fighters_remaining": {},
  "shields_remaining": {},
  "flee_results": {},
  "end": null,
  "result": null,
  "deadline": "<iso_time_or_null>",
  "round_result": null,
  "participants": [],
  "garrison": null,
  "actions": {},
  "source": {
    "type": "rpc",
    "method": "combat.round_resolved",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  }
}
```

---

## 4) `combat.ended`
Sent when:
- Round resolution returns a terminal outcome (`victory`, `stalemate`, `mutual_defeat`, `*_defeated`, `*_fled`, `toll_satisfied`)
- Emitted once per participant with personalized `ship` block

### Example payload
```json
{
  "combat_id": "9f6d3c2c4d6f47f19d40a2f31a9d4a7b",
  "sector": { "id": 42 },
  "round": 3,
  "hits": {},
  "offensive_losses": {},
  "defensive_losses": {},
  "shield_loss": {},
  "fighters_remaining": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 53,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 0
  },
  "shields_remaining": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": 144,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": 0
  },
  "flee_results": {
    "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": false,
    "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df": false
  },
  "end": "Rook AI_defeated",
  "result": "Rook AI_defeated",
  "deadline": null,
  "round_result": "Rook AI_defeated",
  "participants": [],
  "garrison": null,
  "actions": {},
  "salvage": [
    {
      "salvage_id": "30b86dd6-61f0-4ef4-9f13-4a5219b218a8",
      "created_at": "2026-02-06T22:15:01.700Z",
      "expires_at": "2026-02-06T22:30:01.700Z",
      "cargo": {
        "quantum_foam": 12
      },
      "scrap": 18,
      "credits": 840,
      "claimed": false,
      "source": {
        "ship_name": "Rook-7",
        "ship_type": "interceptor"
      },
      "metadata": {
        "combat_id": "9f6d3c2c4d6f47f19d40a2f31a9d4a7b",
        "ship_type": "interceptor"
      }
    }
  ],
  "logs": [
    {
      "round_number": 3,
      "actions": {
        "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8": {
          "action": "attack",
          "commit": 53,
          "timed_out": false,
          "target_id": "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df",
          "destination_sector": null,
          "submitted_at": "2026-02-06T22:15:01.300Z"
        }
      },
      "hits": {},
      "offensive_losses": {},
      "defensive_losses": {},
      "shield_loss": {},
      "result": "Rook AI_defeated",
      "timestamp": "2026-02-06T22:15:01.400Z"
    }
  ],
  "ship": {
    "ship_id": "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9",
    "ship_type": "merchant_cruiser",
    "ship_name": "Asteria",
    "credits": 9520,
    "cargo": {
      "quantum_foam": 3,
      "retro_organics": 0,
      "neuro_symbolics": 0
    },
    "cargo_capacity": 60,
    "empty_holds": 57,
    "warp_power": 34,
    "shields": 144,
    "fighters": 53,
    "max_shields": 200,
    "max_fighters": 120
  },
  "source": {
    "type": "rpc",
    "method": "combat.ended",
    "request_id": "req-01HXYZA20M2N",
    "timestamp": "2026-02-06T22:15:01.890Z"
  },
  "player": { "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8" }
}
```

### Mock payload template
```json
{
  "combat_id": "<combat_id>",
  "sector": { "id": 0 },
  "round": 1,
  "hits": {},
  "offensive_losses": {},
  "defensive_losses": {},
  "shield_loss": {},
  "fighters_remaining": {},
  "shields_remaining": {},
  "flee_results": {},
  "end": "<terminal_result>",
  "result": "<terminal_result>",
  "deadline": null,
  "round_result": "<terminal_result>",
  "participants": [],
  "garrison": null,
  "actions": {},
  "salvage": [],
  "logs": [],
  "ship": {
    "ship_id": "<ship_id>",
    "ship_type": "<ship_type>",
    "ship_name": "<ship_name>",
    "credits": 0,
    "cargo": {
      "quantum_foam": 0,
      "retro_organics": 0,
      "neuro_symbolics": 0
    },
    "cargo_capacity": 0,
    "empty_holds": 0,
    "warp_power": 0,
    "shields": 0,
    "fighters": 0,
    "max_shields": 0,
    "max_fighters": 0
  },
  "source": {
    "type": "rpc",
    "method": "combat.ended",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "player": { "id": "<character_id>" }
}
```

---

## 5) `ship.destroyed`
Sent when:
- A defeated character combatant is finalized (human or corporation_ship)

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "ship.destroyed",
    "request_id": "req-01HXYZA20M2N",
    "timestamp": "2026-02-06T22:15:01.620Z"
  },
  "timestamp": "2026-02-06T22:15:01.620Z",
  "ship_id": "ea6f4df8-bf31-4a11-8c65-d688a95ba5cf",
  "ship_type": "interceptor",
  "ship_name": "Rook-7",
  "player_type": "corporation_ship",
  "player_name": "Rook AI",
  "sector": { "id": 42 },
  "combat_id": "9f6d3c2c4d6f47f19d40a2f31a9d4a7b",
  "salvage_created": true
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "ship.destroyed",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "timestamp": "<iso_time>",
  "ship_id": "<ship_id>",
  "ship_type": "<ship_type>",
  "ship_name": "<ship_name_or_null>",
  "player_type": "human",
  "player_name": "<character_name>",
  "sector": { "id": 0 },
  "combat_id": "<combat_id>",
  "salvage_created": false
}
```

---

## 6) `salvage.created`
Sent when:
- Combat finalization creates salvage from a destroyed ship

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.ended",
    "request_id": "req-01HXYZA20M2N",
    "timestamp": "2026-02-06T22:15:01.530Z"
  },
  "timestamp": "2026-02-06T22:15:01.530Z",
  "salvage_id": "30b86dd6-61f0-4ef4-9f13-4a5219b218a8",
  "sector": { "id": 42 },
  "cargo": {
    "quantum_foam": 12
  },
  "scrap": 18,
  "credits": 840,
  "from_ship_type": "interceptor",
  "from_ship_name": "Rook-7"
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.ended",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "timestamp": "<iso_time>",
  "salvage_id": "<salvage_id>",
  "sector": { "id": 0 },
  "cargo": {},
  "scrap": 0,
  "credits": 0,
  "from_ship_type": "<ship_type>",
  "from_ship_name": "<ship_name>"
}
```

---

## 7) `sector.update` (post-combat full snapshot)
Sent when:
- Immediately after `combat.ended` finalization

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.ended",
    "request_id": "req-01HXYZA20M2N",
    "timestamp": "2026-02-06T22:15:01.910Z"
  },
  "id": 42,
  "region": "Outer Rim",
  "adjacent_sectors": [37, 41, 43, 48],
  "position": [12, -7],
  "port": null,
  "players": [
    {
      "id": "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df",
      "name": "Rook AI",
      "player_type": "corporation_ship",
      "ship": {
        "ship_id": "ea6f4df8-bf31-4a11-8c65-d688a95ba5cf",
        "ship_type": "escape_pod",
        "ship_name": "Escape Pod"
      }
    }
  ],
  "garrison": null,
  "salvage": [],
  "unowned_ships": [],
  "scene_config": null
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.ended",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "id": 0,
  "region": null,
  "adjacent_sectors": [],
  "position": [0, 0],
  "port": null,
  "players": [],
  "garrison": null,
  "salvage": [],
  "unowned_ships": [],
  "scene_config": null
}
```

---

## 8) `garrison.deployed`
Sent when:
- `combat_leave_fighters` successfully deploys fighters into a sector garrison

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.leave_fighters",
    "request_id": "req-01HXYZC2Y9TB",
    "timestamp": "2026-02-06T22:20:11.004Z"
  },
  "sector": { "id": 42 },
  "garrison": {
    "owner_name": "Captain Vega",
    "fighters": 80,
    "fighter_loss": null,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "2026-02-06T22:20:11.001Z",
    "is_friendly": true
  },
  "fighters_remaining": 40,
  "player": { "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8" },
  "ship_id": "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9"
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.leave_fighters",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "sector": { "id": 0 },
  "garrison": {
    "owner_name": "<owner_name>",
    "fighters": 0,
    "fighter_loss": null,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "<iso_time_or_null>",
    "is_friendly": true
  },
  "fighters_remaining": 0,
  "player": { "id": "<character_id>" },
  "ship_id": "<ship_id>"
}
```

---

## 9) `garrison.collected`
Sent when:
- `combat_collect_fighters` returns fighters from a garrison to a ship

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.collect_fighters",
    "request_id": "req-01HXYZD9Q5P1",
    "timestamp": "2026-02-06T22:24:49.300Z"
  },
  "sector": { "id": 42 },
  "credits_collected": 1200,
  "garrison": {
    "owner_name": "Captain Vega",
    "fighters": 25,
    "fighter_loss": null,
    "mode": "toll",
    "toll_amount": 100,
    "deployed_at": "2026-02-06T22:20:11.001Z",
    "is_friendly": true
  },
  "fighters_on_ship": 95,
  "player": { "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8" },
  "ship_id": "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9"
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.collect_fighters",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "sector": { "id": 0 },
  "credits_collected": 0,
  "garrison": null,
  "fighters_on_ship": 0,
  "player": { "id": "<character_id>" },
  "ship_id": "<ship_id>"
}
```

---

## 10) `garrison.mode_changed`
Sent when:
- `combat_set_garrison_mode` successfully changes mode (`offensive`, `defensive`, `toll`)

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.set_garrison_mode",
    "request_id": "req-01HXYZEGYRXK",
    "timestamp": "2026-02-06T22:28:12.920Z"
  },
  "sector": { "id": 42 },
  "garrison": {
    "owner_name": "Captain Vega",
    "fighters": 60,
    "fighter_loss": null,
    "mode": "toll",
    "toll_amount": 125,
    "deployed_at": "2026-02-06T22:20:11.001Z",
    "is_friendly": true
  },
  "player": { "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8" },
  "ship_id": "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9"
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.set_garrison_mode",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "sector": { "id": 0 },
  "garrison": {
    "owner_name": "<owner_name>",
    "fighters": 0,
    "fighter_loss": null,
    "mode": "defensive",
    "toll_amount": 0,
    "deployed_at": "<iso_time_or_null>",
    "is_friendly": true
  },
  "player": { "id": "<character_id>" },
  "ship_id": "<ship_id>"
}
```

---

## 11) `status.update` (from `combat_collect_fighters`)
Sent when:
- Toll credits are paid out during garrison collection (`toll_balance > 0`)

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.collect_fighters",
    "request_id": "req-01HXYZD9Q5P1",
    "timestamp": "2026-02-06T22:24:49.100Z"
  },
  "sector": { "id": 42 },
  "credits": 17250,
  "ship": {
    "ship_id": "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9",
    "ship_type": "merchant_cruiser",
    "credits": 17250,
    "current_fighters": 95
  },
  "player": { "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8" }
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.collect_fighters",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "sector": { "id": 0 },
  "credits": 0,
  "ship": {
    "ship_id": "<ship_id>",
    "ship_type": "<ship_type>",
    "credits": 0,
    "current_fighters": 0
  },
  "player": { "id": "<character_id>" }
}
```

---

## 12) `sector.update` (minimal garrison-change notification)
Sent when:
- `combat_collect_fighters` or `combat_set_garrison_mode` triggers a lightweight sector notification

Current shape is minimal (`sector.id`) and does not include a full sector snapshot.

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.collect_fighters",
    "request_id": "req-01HXYZD9Q5P1",
    "timestamp": "2026-02-06T22:24:49.420Z"
  },
  "sector": { "id": 42 }
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "combat.collect_fighters",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "sector": { "id": 0 }
}
```

---

## 13) `garrison.character_moved` (combat-adjacent)
Sent when:
- A character enters/leaves a sector with garrisons (movement observer path)

### Example payload
```json
{
  "player": {
    "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8",
    "name": "Captain Vega"
  },
  "ship": {
    "ship_id": "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9",
    "ship_name": "Asteria",
    "ship_type": "merchant_cruiser"
  },
  "timestamp": "2026-02-06T22:30:11.002Z",
  "move_type": "normal",
  "movement": "arrive",
  "name": "Captain Vega",
  "sector": 42,
  "source": {
    "type": "rpc",
    "method": "move",
    "request_id": "req-01HXYZG8BD8M",
    "timestamp": "2026-02-06T22:30:10.998Z"
  },
  "garrison": {
    "owner_id": "6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97",
    "owner_name": "Marshal Kira",
    "corporation_id": "0a8f2934-e08c-4a99-9f7a-6650483db53a",
    "fighters": 120,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "2026-02-06T21:59:12.120Z"
  }
}
```

### Mock payload template
```json
{
  "player": { "id": "<character_id>", "name": "<character_name>" },
  "ship": {
    "ship_id": "<ship_id>",
    "ship_name": "<ship_name>",
    "ship_type": "<ship_type>"
  },
  "timestamp": "<iso_time>",
  "move_type": "normal",
  "movement": "arrive",
  "name": "<character_name>",
  "sector": 0,
  "source": {
    "type": "rpc",
    "method": "move",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "garrison": {
    "owner_id": "<owner_character_id>",
    "owner_name": "<owner_name>",
    "corporation_id": "<corp_id>",
    "fighters": 0,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "<iso_time_or_null>"
  }
}
```

---

## 14) `error` (combat/garrison calls)
Sent when:
- Combat/garrison endpoints reject request (validation, authorization, rate-limit, runtime errors)

### Example payload
```json
{
  "source": {
    "type": "rpc",
    "method": "combat_action",
    "request_id": "req-01HXYZA20M2N",
    "timestamp": "2026-02-06T22:14:06.002Z"
  },
  "endpoint": "combat_action",
  "error": "Round mismatch for action submission",
  "status": 409,
  "player": { "id": "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8" }
}
```

### Mock payload template
```json
{
  "source": {
    "type": "rpc",
    "method": "<endpoint_method>",
    "request_id": "<request_id>",
    "timestamp": "<iso_time>"
  },
  "endpoint": "<endpoint_method>",
  "error": "<error_message>",
  "status": 400,
  "player": { "id": "<character_id>" }
}
```

---

## Optional Test Wrapper (Event + Payload)
If you want to mock the event stream with explicit event type:

```json
{
  "event": "combat.round_waiting",
  "payload": {
    "combat_id": "<combat_id>",
    "sector": { "id": 0 },
    "round": 1,
    "participants": [],
    "deadline": "<iso_time>",
    "current_time": "<iso_time>"
  }
}
```

