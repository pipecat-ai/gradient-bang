# Complete Event Catalog

This document catalogs all WebSocket events emitted by the Gradient Bang game server during gameplay, with typical payloads showing all fields.

## Combat Events

### combat.started *(removed October 7, 2025)*
**Status:** No longer emitted. Clients should treat the first `combat.round_waiting` event as confirmation that combat has begun.
**Previous payload:** Legacy dictionary of participants that included `max_fighters`/`max_shields` fields.

### combat.round_waiting
**When emitted:** When a combat round begins and is waiting for player actions
**Who receives it:** All character participants in the combat (character_filter)
**Source:** `/game-server/combat/callbacks.py:91`

**Payload example:** *(participants_map removed October 7, 2025)*
```json
{
  "combat_id": "a3f2b9c1d4e5f6",
  "sector": {"id": 42},
  "round": 2,
  "current_time": "2025-10-07T14:25:00.000Z",
  "deadline": "2025-10-07T14:30:00.000Z",
  "participants": [
    {
      "created_at": "2025-10-07T12:00:00.000Z",
      "name": "trader",
      "player_type": "human",
      "ship": {
        "ship_type": "kestrel_courier",
        "ship_name": "Kestrel Courier",
        "shield_integrity": 85.0,
        "shield_damage": null,
        "fighter_loss": null
      }
    },
    {
      "created_at": "2025-10-07T11:30:00.000Z",
      "name": "pirate",
      "player_type": "human",
      "ship": {
        "ship_type": "sparrow_scout",
        "ship_name": "Sparrow Scout",
        "shield_integrity": 100.0,
        "shield_damage": null,
        "fighter_loss": null
      }
    }
  ],
  "garrison": {
    "owner_name": "defender",
    "fighters": 30,
    "fighter_loss": null,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "2025-10-07T10:00:00.000Z"
  },
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "Kestrel Courier",
    "cargo": {
      "quantum_foam": 45,
      "retro_organics": 10,
      "neuro_symbolics": 5
    },
    "cargo_capacity": 120,
    "warp_power": 37,
    "warp_power_capacity": 50,
    "shields": 120,
    "max_shields": 150,
    "fighters": 45,
    "max_fighters": 50
  }
}
```

**Notes:**
- `ship` contains the same structure as other status-bearing events (`status.update`, `movement.complete`) but only for the receiving character. Other combatants see summary data (shield percentages, losses).
- Garrisons now expose `owner_name` and omit `toll_balance` for privacy.

### combat.round_resolved
**When emitted:** When a combat round is resolved and damage is calculated
**Who receives it:** All current participants plus recently fled characters (character_filter)
**Source:** `/game-server/combat/callbacks.py:197`

**Payload example:**
```json
{
  "combat_id": "a3f2b9c1d4e5f6",
  "sector": {"id": 42},
  "round": 2,
  "participants": [
    {
      "created_at": "2025-10-07T12:00:00.000Z",
      "name": "trader",
      "player_type": "human",
      "ship": {
        "ship_type": "kestrel_courier",
        "ship_name": "Kestrel Courier",
        "shield_integrity": 70.0,
        "shield_damage": -15.0,
        "fighter_loss": 5
      }
    },
    {
      "created_at": "2025-10-07T11:30:00.000Z",
      "name": "pirate",
      "player_type": "human",
      "ship": {
        "ship_type": "sparrow_scout",
        "ship_name": "Sparrow Scout",
        "shield_integrity": 95.0,
        "shield_damage": -5.0,
        "fighter_loss": 2
      }
    }
  ],
  "garrison": {
    "owner_name": "defender",
    "fighters": 25,
    "fighter_loss": 5,
    "mode": "offensive",
    "toll_amount": 0,
    "deployed_at": "2025-10-07T10:00:00.000Z"
  },
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "Kestrel Courier",
    "cargo": {
      "quantum_foam": 40,
      "retro_organics": 10,
      "neuro_symbolics": 5
    },
    "cargo_capacity": 120,
    "warp_power": 35,
    "warp_power_capacity": 50,
    "shields": 80,
    "max_shields": 150,
    "fighters": 42,
    "max_fighters": 50
  }
}
```

**Notes:**
- `ship` mirrors the status payload for the viewing character; deltas for opponents remain percentage-based.
- `garrison` remains a singular object even when present alongside character participants.

### combat.ended
**When emitted:** When combat concludes (all opponents destroyed, all fled, or timeout)
**Who receives it:** All remaining participants (character_filter). Fled characters receive their own separate combat.ended event immediately upon fleeing.
**Source:** `/game-server/combat/callbacks.py:359` (main) and `/game-server/combat/callbacks.py:289` (fled character version)

**Payload example (for remaining participants):**
```json
{
  "combat_id": "a3f2b9c1d4e5f6",
  "sector": {"id": 42},
  "participants": [
    {
      "created_at": "2025-10-07T12:00:00.000Z",
      "name": "trader",
      "player_type": "human",
      "ship": {
        "ship_type": "kestrel_courier",
        "ship_name": "Kestrel Courier",
        "shield_integrity": 65.0,
        "shield_damage": -10.0,
        "fighter_loss": 8
      }
    },
    {
      "created_at": "2025-10-07T11:30:00.000Z",
      "name": "pirate",
      "player_type": "human",
      "ship": {
        "ship_type": "sparrow_scout",
        "ship_name": "Pirate's Revenge",
        "shield_integrity": 0.0,
        "shield_damage": -100.0,
        "fighter_loss": 50
      }
    }
  ],
  "garrison": null,
  "salvage": [
    {
      "salvage_id": "salv_abc123",
      "sector_id": 42,
      "cargo": {
        "quantum_foam": 20,
        "retro_organics": 15,
        "neuro_symbolics": 10
      },
      "scrap": 50,
      "source": {
        "ship_name": "Pirate's Revenge",
        "ship_type": "sparrow_scout"
      }
    }
  ],
  "logs": [],
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "Kestrel Courier",
    "cargo": {
      "quantum_foam": 38,
      "retro_organics": 10,
      "neuro_symbolics": 5
    },
    "cargo_capacity": 120,
    "warp_power": 33,
    "warp_power_capacity": 50,
    "shields": 65,
    "max_shields": 150,
    "fighters": 42,
    "max_fighters": 50
  }
}
```

**Notes:**
- Salvage containers include the defeated ship's public metadata; no victor IDs or credit totals leak.
- The recipient's own `ship` block is included with full fighter/shield counts.

**Payload example (for fled character):**
```json
{
  "combat_id": "a3f2b9c1d4e5f6",
  "sector": {"id": 42},
  "result": "fled",
  "round": 3,
  "fled_to_sector": 43,
  "salvage": []
}
```

## Movement Events

### course.plot
***When emitted:*** When plot_course is called
***Who receives it:*** The moving character only (character_filter)
***Source:*** `/game-server/api/plot_course.py:156`

**Payload example:**
```json
{
    "from_sector": 1000,
    "to_sector": 1307,
    "path": [
        1000,
        1203,
        962,
        1307
    ],
    "distance": 3
}
```

### movement.complete
**When emitted:** When a character exits hyperspace and arrives at destination
**Who receives it:** The moving character only (character_filter)
**Source:** `/game-server/api/move.py:180`

**Payload example:**
```json
{
  "player": {
    "created_at": "2025-10-07T12:00:00.000Z",
    "last_active": "2025-10-07T14:25:30.000Z",
    "id": "trader",
    "name": "trader",
    "credits_on_hand": 15000,
    "credits_in_bank": 0
  },
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "Kestrel Courier",
    "cargo": {
      "quantum_foam": 50,
      "retro_organics": 30,
      "neuro_symbolics": 20
    },
    "cargo_capacity": 100,
    "warp_power": 47,
    "warp_power_capacity": 50,
    "shields": 85,
    "max_shields": 100,
    "fighters": 45,
    "max_fighters": 50
  },
  "sector": {
    "id": 43,
    "adjacent_sectors": [42, 44, 50, 51],
    "port": {
      "code": "BSB",
      "prices": {
        "quantum_foam": {"buy_price": null, "sell_price": 12},
        "retro_organics": {"buy_price": 18, "sell_price": null},
        "neuro_symbolics": {"buy_price": null, "sell_price": 25}
      },
      "stock": {
        "quantum_foam": 500,
        "retro_organics": 300,
        "neuro_symbolics": 200
      },
      "observed_at": null
    },
    "players": [
      {
        "created_at": "2025-10-07T11:00:00.000Z",
        "name": "merchant",
        "player_type": "human",
        "ship": {
          "ship_type": "atlas_freighter",
          "ship_name": "Atlas Freighter"
        }
      }
    ],
    "garrison": null,
    "salvage": []
  }
}
```

### map.local
**When emitted:** When a character needs updated local map data (after movement completion)
**Who receives it:** The character who just moved (character_filter)
**Source:** `/game-server/api/move.py:197`

**Payload example:**
```json
{
  "center_sector": 43,
  "max_hops": 4,
  "sectors": {
    "42": {
      "sector_id": 42,
      "position": [95.2, 198.7],
      "visited": true,
      "port": {
        "code": "SBB",
        "observed_at": "2025-10-07T14:20:00.000Z"
      },
      "players": ["pirate"],
      "planets": [],
      "garrisons": [
        {
          "owner_name": "Defender",
          "fighters": 30,
          "mode": "offensive",
          "is_friendly": false
        }
      ]
    },
    "43": {
      "sector_id": 43,
      "position": [100.5, 200.3],
      "visited": true,
      "port": {
        "code": "BSB",
        "observed_at": null
      },
      "players": ["trader", "merchant"],
      "planets": [],
      "garrisons": []
    },
    "44": {
      "sector_id": 44,
      "position": [105.1, 202.0],
      "visited": false
    }
  },
  "lanes": [
    {"from": 42, "to": 43, "two_way": true, "hyperlane": false},
    {"from": 43, "to": 44, "two_way": true, "hyperlane": false},
    {"from": 43, "to": 50, "two_way": false, "hyperlane": true}
  ]
}
```

### character.moved
**When emitted:** When a character moves between sectors (for observers)
**Who receives it:**
- **Departure:** All characters in the old sector (excluding the mover)
- **Arrival:** All characters in the new sector (excluding the mover, not in hyperspace)

**Source:** `/game-server/api/move.py:139` (departure), `/game-server/api/move.py:276` (arrival)

**Payload example (departure):**
```json
{
  "name": "trader",
  "ship_type": "kestrel_courier",
  "timestamp": "2025-10-07T14:25:00.000Z",
  "move_type": "normal",
  "movement": "depart"
}
```

**Payload example (arrival):**
```json
{
  "name": "trader",
  "ship_type": "kestrel_courier",
  "timestamp": "2025-10-07T14:25:02.000Z",
  "move_type": "normal",
  "movement": "arrive"
}
```

**Payload example (teleport via join):**
```json
{
  "name": "trader",
  "ship_type": "kestrel_courier",
  "timestamp": "2025-10-07T14:25:00.000Z",
  "move_type": "teleport",
  "movement": "arrive"
}
```

## Trading Events

### trade.executed
**When emitted:** When a character completes a buy or sell trade at a port
**Who receives it:** The character who executed the trade (character_filter)
**Source:** `/game-server/api/trade.py:138` (buy) and `/game-server/api/trade.py:215` (sell)

**Payload example:**
```json
{
  "player": {
    "created_at": "2025-10-07T12:00:00.000Z",
    "last_active": "2025-10-07T14:26:00.000Z",
    "id": "trader",
    "name": "trader",
    "credits_on_hand": 14400,
    "credits_in_bank": 0
  },
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "Kestrel Courier",
    "cargo": {
      "quantum_foam": 70,
      "retro_organics": 30,
      "neuro_symbolics": 20
    },
    "cargo_capacity": 100,
    "warp_power": 47,
    "warp_power_capacity": 50,
    "shields": 85,
    "max_shields": 100,
    "fighters": 45,
    "max_fighters": 50
  }
}
```

### port.update
**When emitted:** When port inventory/prices change due to trading activity
**Who receives it:** All characters in the sector where the port is located (character_filter)
**Source:** `/game-server/api/trade.py:157` (buy) and `/game-server/api/trade.py:234` (sell)

**Payload example:**
```json
{
  "sector": {"id": 43},
  "updated_at": "2025-10-07T14:26:00.000Z",
  "port": {
    "code": "BSB",
    "prices": {
      "quantum_foam": {"buy_price": null, "sell_price": 13},
      "retro_organics": {"buy_price": 18, "sell_price": null},
      "neuro_symbolics": {"buy_price": null, "sell_price": 25}
    },
    "stock": {
      "quantum_foam": 480,
      "retro_organics": 300,
      "neuro_symbolics": 200
    },
    "observed_at": null
  }
}
```

## Warp Power Events

### warp.purchase
**When emitted:** When a character purchases warp power at sector 0 depot
**Who receives it:** The character who purchased warp power (character_filter)
**Source:** `/game-server/api/recharge_warp_power.py:78`

**Payload example:**
```json
{
  "character_id": "trader",
  "sector": {"id": 0},
  "units": 25,
  "price_per_unit": 2,
  "total_cost": 50,
  "timestamp": "2025-10-07T14:27:00.000Z"
}
```

### warp.transfer
**When emitted:** When warp power is transferred between two characters
**Who receives it:** Both the sender and receiver characters (character_filter)
**Source:** `/game-server/api/transfer_warp_power.py:70`

**Payload example:**
```json
{
  "from_character_id": "trader",
  "to_character_id": "merchant",
  "sector": {"id": 43},
  "units": 10,
  "timestamp": "2025-10-07T14:28:00.000Z"
}
```

## Status Events

### status.update
**When emitted:** When a character's status changes (after combat rounds, trades, warp purchases, fighter collection, etc.)
**Who receives it:** The specific character whose status changed (character_filter)
**Source:**
- `/game-server/combat/callbacks.py:60` (after combat rounds)
- `/game-server/api/recharge_warp_power.py:92` (after warp purchase)
- `/game-server/api/transfer_warp_power.py:84` (after warp transfer)
- Multiple other locations after state-changing operations

**Payload example:**
```json
{
  "player": {
    "created_at": "2025-10-07T12:00:00.000Z",
    "last_active": "2025-10-07T14:28:30.000Z",
    "id": "trader",
    "name": "trader",
    "credits_on_hand": 14350,
    "credits_in_bank": 0
  },
  "ship": {
    "ship_type": "kestrel_courier",
    "ship_name": "Kestrel Courier",
    "cargo": {
      "quantum_foam": 70,
      "retro_organics": 30,
      "neuro_symbolics": 20
    },
    "cargo_capacity": 100,
    "warp_power": 37,
    "warp_power_capacity": 50,
    "shields": 85,
    "max_shields": 100,
    "fighters": 45,
    "max_fighters": 50
  },
  "sector": {
    "id": 43,
    "adjacent_sectors": [42, 44, 50, 51],
    "port": {
      "code": "BSB",
      "prices": {
        "quantum_foam": {"buy_price": null, "sell_price": 13},
        "retro_organics": {"buy_price": 18, "sell_price": null},
        "neuro_symbolics": {"buy_price": null, "sell_price": 25}
      },
      "stock": {
        "quantum_foam": 480,
        "retro_organics": 300,
        "neuro_symbolics": 200
      },
      "observed_at": null
    },
    "players": [
      {
        "created_at": "2025-10-07T11:00:00.000Z",
        "name": "merchant",
        "player_type": "human",
        "ship": {
          "ship_type": "atlas_freighter",
          "ship_name": "Atlas Freighter"
        }
      }
    ],
    "garrison": null,
    "salvage": []
  }
}
```

## Sector Events

### sector.update
**When emitted:** When sector contents change (salvage collected, combat ended)
**Who receives it:** All characters in the affected sector (character_filter)
**Source:**
- `/game-server/api/salvage_collect.py:64` (after salvage collection)
- `/game-server/combat/callbacks.py:380` (after combat ended)

**Payload example:**
```json
{
  "id": 42,
  "adjacent_sectors": [41, 43, 49, 50],
  "port": null,
  "players": [
    {
      "created_at": "2025-10-07T11:30:00.000Z",
      "name": "pirate",
      "player_type": "human",
      "ship": {
        "ship_type": "sparrow_scout",
        "ship_name": "Sparrow Scout"
      }
    }
  ],
  "garrison": null,
  "salvage": [
    {
      "salvage_id": "salv_xyz789",
      "created_at": "2025-10-07T14:24:00.000Z",
      "expires_at": "2025-10-07T14:39:00.000Z",
      "cargo": {
        "retro_organics": 25
      },
      "scrap": 20,
      "credits": 0,
      "claimed": false,
      "source": {
        "ship_name": "Unknown Ship",
        "ship_type": "kestrel_courier"
      },
      "metadata": {
        "combat_id": "example-combat"
      }
    }
  ]
}
```

## Connection Events

### character.joined
**When emitted:** When a character joins the game for the first time in a session
**Who receives it:** Broadcast to all connected clients (no character_filter)
**Source:** `/game-server/api/join.py:77`

**Payload example:**
```json
{
  "character_id": "trader",
  "sector": {"id": 0},
  "timestamp": "2025-10-07T12:00:00.000Z"
}
```

## Event Filter Summary

Most events use `character_filter` to target specific characters:

- **Broadcast (no filter):** `character.joined`
- **Single character:** `movement.start`, `movement.complete`, `map.local`, `trade.executed`, `warp.purchase`, `status.update`
- **Multiple specific characters:** `warp.transfer` (sender + receiver), `status.update` (after combat to all participants)
- **Sector observers (excluding actor):** `character.moved` (observers in old/new sectors)
- **Sector observers (all):** `port.update`, `sector.update`
- **Combat participants:** `combat.round_waiting`, `combat.round_resolved`, `combat.ended`

## Privacy Considerations

The new combat event serialization (implemented in `/game-server/combat/utils.py`) is privacy-aware:
- Combat events show ship names and shield percentages, but not exact fighter counts
- Cargo and credit information is never revealed to opponents
- Character IDs are shown for ownership but player display names can be different
- Garrison details (mode, toll) are revealed to participants in combat with that garrison
