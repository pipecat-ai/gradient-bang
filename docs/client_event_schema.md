## status

### `status.join`
Sent by bot after local client connects and is in ready state.

Formerly `status.init`

```json
{
  
  "player": {  // type: `PlayerLocal`
    "id": 1,
    "name": "TraderJ",
    "credits": 0,
    "created_at": "2025-09-21T18:04:12.123456Z",
    "last_active": "2025-09-21T18:04:12.123456Z",
  },
  "ship": { // type: `Ship`
    "ship_name": "Serenity",
    "ship_type": { // type: `ShipType`
        "id": "kestrel_courier",
        "name": "Kestrel Courier"
    },
    "cargo": { // type: `Cargo`
        "FO": 0,
        "OG": 0,
        "EQ": 0
    },
    "cargo_capacity": 1000,
    "cargo_used": 0,
    "warp_power": 0,
    "warp_power_capacity": 0,
    "shields": 0,
    "max_shields": 0,
    "fighters": 0,
    "max_fighters": 0
  },
"sector": { // type: `SectorCurrent`
    "id": 0,
    "region": { // type: `Region`
        "id": 0,
        "name": "Core Worlds",
        "safe": true
    },
    "adjacent_sectors": [4, 6, 9],
    "port": { // type: `Port`
        "code": "BSS",
        "stock": { // type: Record<Resource, number>
            "FO": 10,
            "OG": 10,
            "EQ": 10
        },
        "max_capacity": { // type: Record<Resource, number>
            "FO": 10,
            "OG": 10,
            "EQ": 10
        },
        "warp_power_depot": { // type: PortWarpPowerDepot; 
            "price_per_unit": 100,
            "note": ""
        }
    },
    "players": [ // type: `PlayerRemote`
        {
            "id": 1,
            "name": "Trader K",
            "created_at": "2025-09-21T18:04:12.123456Z",
            "player_type": "human",
            "ship": { // type: `ShipBase`
                "ship_name": "Rocinate",
                "ship_type": { // type: `ShipType`
                    "id": "kestrel_courier",
                    "name": "Kestrel Courier"
                },
            }
        }
    ],
    "planets": [ // type: `Planet`
        { 
            "id": 11,
            "class_code": "H",
            "class_name": "Habitable"
        }
    ],
    "scene_config": {},
    "last_visited": "2025-09-21T18:04:12.123456Z",

  // Map
  //map_local: MapNode[]; // minimap (subset of entire map)
  //map_discovered: MapNode[]; // universe map of all discovered sectors
  //map_plot?: MapNode[]; // subset with proposed flight path (if plotting)

  // Movement
  //movement_history: MovementHistory[];
}
```
