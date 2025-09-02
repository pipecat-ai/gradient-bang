# Gradient Bang API Endpoints Documentation

## Server Information

### GET /
**File Location:** server.py:389-397  
**Purpose:** Root endpoint showing server status  
**Arguments:** None  
**Returns:**
```json
{
  "name": "Gradient Bang",
  "version": "0.1.0",
  "status": "running",
  "sectors": 5000
}
```

## Navigation

### POST /api/plot_course
**File Location:** server.py:400-433  
**Purpose:** Calculate shortest path between two sectors  
**Arguments:**
- `from`: int (source sector, ≥0)
- `to`: int (destination sector, ≥0)

**Returns:**
```json
{
  "from_sector": 42,
  "to_sector": 100,
  "path": [42, 45, 67, 89, 100],
  "distance": 4
}
```

### POST /api/move
**File Location:** server.py:601-681  
**Purpose:** Move character to adjacent sector (consumes warp power)  
**Arguments:**
- `character_id`: string
- `to`: int (destination sector, must be adjacent)

**Returns:** Full CharacterStatus object (see /api/join for structure)

## Character Management

### POST /api/join
**File Location:** server.py:493-591  
**Purpose:** Add new character to game or update existing character's position  
**Arguments:**
- `character_id`: string (1-100 chars)
- `ship_type`: string (optional, for new characters)
- `credits`: int (optional, credit override)
- `sector`: int (optional, starting/teleport sector)

**Returns:**
```json
{
  "id": "trader",
  "sector": 0,
  "last_active": "2025-08-15T10:30:00Z",
  "sector_contents": {
    "port": {
      "class": 1,
      "code": "BSS",
      "buys": ["fuel_ore"],
      "sells": ["organics", "equipment"],
      "stock": {"FO": 200, "OG": 800, "EQ": 500},
      "max_capacity": {"FO": 1000, "OG": 1000, "EQ": 1000},
      "prices": {"fuel_ore": 45, "organics": 32, "equipment": 120}
    },
    "planets": [
      {
        "id": "P001",
        "class_code": "M",
        "class_name": "Earth-type"
      }
    ],
    "other_players": [
      {
        "character_id": "explorer",
        "ship_type": "cruiser",
        "ship_name": "Corporate Cruiser"
      }
    ],
    "adjacent_sectors": [1, 2, 3, 4, 5]
  },
  "ship": {
    "ship_type": "merchant",
    "ship_name": "Merchant Freighter",
    "cargo": {"fuel_ore": 10, "organics": 20, "equipment": 5},
    "cargo_capacity": 65,
    "cargo_used": 35,
    "warp_power": 85,
    "warp_power_capacity": 100,
    "shields": 400,
    "max_shields": 400,
    "fighters": 20,
    "max_fighters": 20,
    "credits": 5000
  }
}
```

### POST /api/my_status
**File Location:** server.py:690-702  
**Purpose:** Get current character status and sector contents  
**Arguments:**
- `character_id`: string

**Returns:** Same CharacterStatus structure as /api/join

### POST /api/my_map
**File Location:** server.py:711-715  
**Purpose:** Get character's accumulated map knowledge  
**Arguments:**
- `character_id`: string

**Returns:**
```json
{
  "character_id": "trader",
  "visited_sectors": {
    "0": {
      "sector_id": 0,
      "port": {
        "class": 1,
        "code": "BSS",
        "buys": ["fuel_ore"],
        "sells": ["organics", "equipment"]
      },
      "planets": [],
      "adjacent_sectors": [1, 2, 3, 4, 5]
    }
  },
  "known_ports": {
    "0": {
      "class": 1,
      "code": "BSS"
    }
  },
  "ship_config": {
    "ship_type": "merchant",
    "cargo": {"fuel_ore": 10, "organics": 20, "equipment": 5},
    "current_warp_power": 85,
    "current_shields": 400,
    "current_fighters": 20
  },
  "credits": 5000
}
```

## Trading

### POST /api/check_trade
**File Location:** server.py:738-864  
**Purpose:** Preview trade transaction without executing  
**Arguments:**
- `character_id`: string
- `commodity`: string ("fuel_ore", "organics", or "equipment")
- `quantity`: int (>0)
- `trade_type`: string ("buy" or "sell")

**Returns:**
```json
{
  "can_trade": true,
  "price_per_unit": 45,
  "total_price": 450,
  "error": null,
  "current_credits": 5000,
  "current_cargo": {"fuel_ore": 10, "organics": 20, "equipment": 5},
  "cargo_capacity": 65,
  "cargo_used": 35
}
```

### POST /api/trade
**File Location:** server.py:891-1145  
**Purpose:** Execute trade transaction (buy or sell commodities)  
**Arguments:**
- `character_id`: string
- `commodity`: string ("fuel_ore", "organics", or "equipment")
- `quantity`: int (>0)
- `trade_type`: string ("buy" or "sell")

**Returns:**
```json
{
  "success": true,
  "trade_type": "buy",
  "commodity": "fuel_ore",
  "quantity": 10,
  "price_per_unit": 45,
  "total_price": 450,
  "new_credits": 4550,
  "new_cargo": {"fuel_ore": 20, "organics": 20, "equipment": 5},
  "port_stock": {"FO": 190, "OG": 800, "EQ": 500},
  "port_max_capacity": {"FO": 1000, "OG": 1000, "EQ": 1000},
  "new_prices": {"fuel_ore": 46, "organics": 32, "equipment": 120}
}
```

## Warp Power Management

### POST /api/recharge_warp_power
**File Location:** server.py:1166-1269  
**Purpose:** Recharge warp power at sector 0 depot (fixed price: 2 credits/unit)  
**Arguments:**
- `character_id`: string
- `units`: int (>0, number of warp power units)

**Returns:**
```json
{
  "success": true,
  "units_bought": 15,
  "price_per_unit": 2,
  "total_cost": 30,
  "new_warp_power": 100,
  "warp_power_capacity": 100,
  "new_credits": 4970,
  "message": "Successfully bought 15 warp power units for 30 credits at sector 0 depot"
}
```

### POST /api/transfer_warp_power
**File Location:** server.py:1288-1382  
**Purpose:** Transfer warp power between players in same sector  
**Arguments:**
- `from_character_id`: string
- `to_character_id`: string
- `units`: int (>0)

**Returns:**
```json
{
  "success": true,
  "units_transferred": 25,
  "from_warp_power_remaining": 60,
  "to_warp_power_current": 50,
  "message": "Successfully transferred 25 warp power units from trader to explorer"
}
```

## Port Management (Admin)

### POST /api/reset_ports
**File Location:** server.py:1385-1409  
**Purpose:** Reset all ports to initial state (WARNING: deletes all trade history)  
**Arguments:** None

**Returns:**
```json
{
  "success": true,
  "message": "Reset 500 ports to initial state",
  "ports_reset": 500
}
```

### POST /api/regenerate_ports
**File Location:** server.py:1417-1448  
**Purpose:** Partially regenerate port inventories (simulates restocking)  
**Arguments:**
- `fraction`: float (0.0-1.0, default 0.25)

**Returns:**
```json
{
  "success": true,
  "message": "Regenerated 500 ports with 25.0% of max capacity",
  "ports_regenerated": 500,
  "fraction": 0.25
}
```

## Real-time Events

### WebSocket /api/firehose
**File Location:** server.py:1451-1461  
**Purpose:** Real-time game event stream via WebSocket  
**Connection:** WebSocket connection to ws://server:8000/api/firehose

**Event Types:**

#### Connection Event
```json
{
  "type": "connected",
  "message": "Connected to Gradient Bang firehose",
  "timestamp": "2025-08-15T10:30:00Z"
}
```

#### Join Event
```json
{
  "type": "join",
  "character_id": "trader",
  "sector": 0,
  "timestamp": "2025-08-15T10:30:00Z"
}
```

#### Movement Event
```json
{
  "type": "movement",
  "character_id": "trader",
  "from_sector": 0,
  "to_sector": 1,
  "timestamp": "2025-08-15T10:30:00Z"
}
```

#### Admin Move Event
```json
{
  "type": "admin_move",
  "character_id": "trader",
  "from_sector": 0,
  "to_sector": 100,
  "timestamp": "2025-08-15T10:30:00Z",
  "note": "Character moved via join endpoint"
}
```

#### Trade Event
```json
{
  "type": "trade",
  "character_id": "trader",
  "sector": 45,
  "trade_type": "buy",
  "commodity": "fuel_ore",
  "quantity": 10,
  "price_per_unit": 45,
  "total_price": 450,
  "timestamp": "2025-08-15T10:30:00Z"
}
```

#### Warp Power Purchase Event
```json
{
  "type": "warp_power_purchase",
  "character_id": "trader",
  "sector": 0,
  "units": 15,
  "price_per_unit": 2,
  "total_cost": 30,
  "timestamp": "2025-08-15T10:30:00Z"
}
```

#### Warp Power Transfer Event
```json
{
  "type": "warp_power_transfer",
  "from_character_id": "trader",
  "to_character_id": "explorer",
  "sector": 42,
  "units": 25,
  "timestamp": "2025-08-15T10:30:00Z"
}
```

#### Port Reset Event
```json
{
  "type": "port_reset",
  "ports_reset": 500,
  "timestamp": "2025-08-15T10:30:00Z"
}
```

#### Port Regeneration Event
```json
{
  "type": "port_regeneration",
  "ports_regenerated": 500,
  "fraction": 0.25,
  "timestamp": "2025-08-15T10:30:00Z"
}
```

## Important Notes

1. **Character Creation**: Characters are automatically created when they first join
2. **Warp Power**: Movement between sectors consumes warp power based on ship type
3. **Trading**: Prices are dynamically calculated based on port inventory levels
4. **Sector 0 Special**: Has a warp power depot for refueling at fixed price
5. **Map Knowledge**: Characters accumulate map knowledge as they explore
6. **Port Inventories**: Persist across server restarts, can be reset or regenerated
7. **Real-time Updates**: All major actions broadcast events via WebSocket firehose
