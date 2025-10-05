# Events

## status

### `status.join` | `status.update`

Dispatched after local client connects and is in ready state, or used to rehydrate client with entire game state.

```json
{
    "local_map": [ // type: `MapNode[]`
        {
            "id": 0,
            "lanes": [ // type: `MapLane[]`
                {
                    "hyperlane": false,
                    "to": 4,
                    "two_way": true
                },
                {
                    // ...
                }
            ],
            "position": [
                0,
                0
            ],
            "sector": { // type: `Sector`
                "adjacent_sectors": [
                    4,
                    6,
                    9
                ],
                "id": 0,
                "planets": [],
                "port": { // type: `Port`
                    "code": "BSS",
                    "max_capacity": { // type: `Record<Resource, number>`
                        "EQ": 10,
                        "FO": 10,
                        "OG": 10
                    },
                    "observed_at": "2025-09-21T18:04:12.123456Z",
                    "stock": { // type: `Record<Resource, number>`
                        "EQ": 10,
                        "FO": 10,
                        "OG": 10
                    },
                    "warp_power_depot": { // type: `PortWarpPowerDepot`
                        "note": "",
                        "price_per_unit": 100
                    }
                },
                "region": { // type: `Region`
                    "id": 0,
                    "name": "core_worlds",
                    "safe": true
                },
                "scene_config": {}
            },
            "visited": true
        },
        {
            // ...
        }
    ],
    "movement_history": [ // type: `MovementHistory[]`
        {
            "from": 0,
            "port": { // type: `PortBase`
                "code": "BSS"
            },
            "timestamp": "2025-09-21T18:04:12.123456Z",
            "to": 1
        },
        {
            // ...
        }
    ],
    "player": { // type: `PlayerSelf`
        "created_at": "2025-09-21T18:04:12.123456Z",
        "credits": 0,
        "credits_in_bank": 0,
        "credits_in_hand": 0,
        "id": "1",
        "last_active": "2025-09-21T18:04:12.123456Z",
        "name": "TraderJ"
    },
    "sector": { // type: `Sector`
        "adjacent_sectors": [
            4,
            6,
            9
        ],
        "id": 0,
        "last_visited": "2025-09-21T18:04:12.123456Z",
        "planets": [ // type: `Planet[]`
            {
                "class_code": "H",
                "class_name": "Habitable",
                "id": 11
            }
        ],
        "players": [ // type: `Player[]`
            {
                "created_at": "2025-09-21T18:04:12.123456Z",
                "id": "2",
                "name": "Trader K",
                "player_type": "human",
                "ship": { // type: `Ship`
                    "ship_name": "Rocinante",
                    "ship_type": { // type: `ShipType`
                        "id": "kestrel_courier",
                        "max_cargo": 1000,
                        "max_fighters": 300,
                        "max_holds": 1,
                        "max_shields": 100,
                        "max_warp_power": 300,
                        "name": "Kestrel Courier"
                    }
                }
            }
        ],
        "port": { // type: `Port`
            "code": "BSS",
            "max_capacity": { // type: `Record<Resource, number>`
                "EQ": 10,
                "FO": 10,
                "OG": 10
            },
            "stock": { // type: `Record<Resource, number>`
                "EQ": 10,
                "FO": 10,
                "OG": 10
            },
            "warp_power_depot": { // type: `PortWarpPowerDepot`
                "note": "",
                "price_per_unit": 100
            }
        },
        "region": { // type: `Region`
            "id": 0,
            "name": "core_worlds",
            "safe": true
        },
        "scene_config": {}
    },
    "ship": { // type: `ShipSelf`
        "cargo": { // type: `Record<Resource, number>`
            "EQ": 0,
            "FO": 0,
            "OG": 0
        },
        "cargo_capacity": 0,
        "fighters": 0,
        "holds": 1,
        "shields": 100,
        "ship_name": "Serenity",
        "ship_type": { // type: `ShipType`
            "id": "kestrel_courier",
            "max_cargo": 1000,
            "max_fighters": 300,
            "max_holds": 1,
            "max_shields": 100,
            "max_warp_power": 300,
            "name": "Kestrel Courier"
        },
        "warp_power": 300,
        "warp_power_capacity": 300
    }
}
```