# Event Catalog (Supabase)

This catalog describes events emitted by Supabase edge functions. **Source of truth** is the edge-function code under `deployment/supabase/functions/**` and the shared emit helpers in `deployment/supabase/functions/_shared/events.ts`.

## Where Events Come From

- Edge functions emit events by calling the helpers in `_shared/events.ts`.
- Event payloads are built in shared helpers such as:
  - `_shared/status.ts` (status snapshots + player/ship payloads)
  - `_shared/map.ts` (map/local/sector payloads)
  - `_shared/combat_*` (combat participants + outcomes)
  - `_shared/corporations.ts` (corporation payloads)

## Common Event Types

These are the primary events consumed by the voice agent and NPC tooling (see `src/gradientbang/pipecat_server/voice_task_manager.py`).

- `status.snapshot`
- `status.update`
- `sector.update`
- `course.plot`
- `path.region`
- `movement.start`
- `movement.complete`
- `map.knowledge`
- `map.region`
- `map.local`
- `map.update`
- `ports.list`
- `character.moved`
- `trade.executed`
- `port.update`
- `fighter.purchase`
- `warp.purchase`
- `warp.transfer`
- `credits.transfer`
- `garrison.deployed`
- `garrison.collected`
- `garrison.mode_changed`
- `salvage.collected`
- `salvage.created`
- `bank.transaction`
- `combat.round_waiting`
- `combat.round_resolved`
- `combat.ended`
- `combat.action_accepted`
- `ship.destroyed`
- `ship.renamed`
- `corporation.created`
- `corporation.ship_purchased`
- `corporation.member_joined`
- `corporation.member_left`
- `corporation.member_kicked`
- `corporation.disbanded`
- `chat.message`
- `event.query`
- `ships.list`
- `task.start`
- `task.finish`
- `task.cancel`
- `error`

## Updating This Catalog

If you add or rename events:

1. Update the emitting edge function(s).
2. Add the new event type to `VoiceTaskManager._event_names` if the voice agent should consume it.
3. Update this list if the event is user-facing.

## Payloads

### `status.update` | `status.snapshot`

```tsx
{
  scope: "player" | "corporation",
  ship: {
    ship_id: string,
    ship_name: string,
    ship_type: string,
    cargo?: {
      quantum_foam: number,
      retro_organics: number,
      neuro_symbolics: number,
    },
    credits?: number,
    shields?: number,
    fighters?: number,
    warp_power?: number,
    warp_power_capacity?: number,
    empty_holds?: number,
    max_shields?: number,
    max_fighters?: number,
    cargo_capacity?: number,
    turns_per_warp?: number,
  },
  player: {
    id: string,
    name: string,
    created_at: string,
    last_active: string,
    player_type: "human" | "npc" | "corporation_ship",
    universe_size: number,
    credits_in_bank: number,
    sectors_visited: number,
    total_sectors_known: number,
    corp_sectors_visited: number | null,
  },
  corporation: {
    name: string,
    corp_id: string,
    joined_at: string,
    member_count: number,
  } | null,
  sector: {
    id: number,
    region?: string,
    position: [number, number],
    adjacent_sectors: number[],
    scene_config?: unknown,
    port?: {
      id: number,
      code: string,
      mega?: boolean,
      stock: {
        quantum_foam?: number,
        retro_organics?: number,
        neuro_symbolics?: number,
      },
      prices: {
        quantum_foam?: number,
        retro_organics?: number,
        neuro_symbolics?: number,
      },
      port_class?: number,
      observed_at?: string,
    },
    players?: [
      {
        id: string,
        name: string,
        player_type: "human" | "npc" | "corporation_ship",
        ship: {
          ship_id: string,
          ship_name: string,
          ship_type: string,
        },
        corporation: {
          name: string,
          corp_id: string,
          joined_at: string,
          member_count: number
        } | null,
        created_at: string | null,
      },
    ],
    salvage?: [
      {
        salvage_id: string,
        cargo: {
          quantum_foam?: number,
          retro_organics?: number,
          neuro_symbolics?: number,
        },
        scrap: number,
        source: {
          ship_name: string,
          ship_type: string,
        },
        claimed: boolean,
        credits: number,
        metadata: Record<string, unknown>,
        created_at: string,
        expires_at: string,
      }
    ],
    garrison?: {
      owner_id: string,
      owner_name: string,
      fighters: number,
      mode: "offensive" | "defensive" | "toll",
      toll_amount: number,
      toll_balance: number,
      is_friendly: boolean,
    } | null,
    unowned_ships?: [
      {
        ship_id: string,
        ship_type: string,
        ship_name: string,
        owner_type: string | null,
        cargo: {
          quantum_foam?: number,
          retro_organics?: number,
          neuro_symbolics?: number,
        },
        shields: number,
        fighters: number,
        owner_id: string | null,
        became_unowned: string,
        former_owner_name: string,
      }
    ],
  },
  source?: {
    type: string,
    method: string,
    request_id: string,
    timestamp: string,
  },
}
```

### `sector.update`

```tsx
{
  id: number,
  region?: string,
  position: [number, number],
  adjacent_sectors: number[],
  scene_config?: unknown,
  port?: {
    id: number,
    code: string,
    mega?: boolean,
    stock: {
      quantum_foam?: number,
      retro_organics?: number,
      neuro_symbolics?: number,
    },
    prices: {
      quantum_foam?: number,
      retro_organics?: number,
      neuro_symbolics?: number,
    },
    port_class?: number,
    observed_at?: string,
  },
  players?: [
    {
      id: string,
      name: string,
      player_type: "human" | "npc" | "corporation_ship",
      ship: {
        ship_id: string,
        ship_name: string,
        ship_type: string,
      },
      corporation: {
        name: string,
        corp_id: string,
        joined_at: string,
        member_count: number
      } | null,
      created_at: string | null,
    },
  ],
  salvage?: [
    {
      salvage_id: string,
      cargo: {
        quantum_foam?: number,
        retro_organics?: number,
        neuro_symbolics?: number,
      },
      scrap: number,
      source: {
        ship_name: string,
        ship_type: string,
      },
      claimed: boolean,
      credits: number,
      metadata: Record<string, unknown>,
      created_at: string,
      expires_at: string,
    }
  ],
  garrison?: {
    owner_id: string,
    owner_name: string,
    fighters: number,
    mode: "offensive" | "defensive" | "toll",
    toll_amount: number,
    toll_balance: number,
    is_friendly: boolean,
  } | null,
  unowned_ships?: [
    {
      ship_id: string,
      ship_type: string,
      ship_name: string,
      owner_type: string | null,
      cargo: {
        quantum_foam?: number,
        retro_organics?: number,
        neuro_symbolics?: number,
      },
      shields: number,
      fighters: number,
      owner_id: string | null,
      became_unowned: string,
      former_owner_name: string,
    }
  ],
  source?: {
    type: string,
    method: string,
    request_id: string,
    timestamp: string,
  },
  __task_id?: string,
}
```

### `map.local`

```tsx
{
  sectors: [
    {
      id: number,
      scope?: "player" | "corp" | "both",
      region?: string | null,
      position: [number, number],
      adjacent_sectors: number[],
      hops_from_center: number,
      port: {
        code: string
        mega?: boolean
      } | null,
      lanes: [
        {
          to: number,
          two_way: boolean
        }
      ],
      visited: boolean,
      last_visited?: string,
    }
  ],
  center_sector: number,
  total_sectors: number,
  total_visited: number,
  total_unvisited: number,
}
```

### `map.region`

```tsx
{
  sectors: [
    {
      id: number,
      scope?: "player" | "corp" | "both",
      region?: string | null,
      position: [number, number],
      adjacent_sectors: number[],
      hops_from_center: number,
      port: {
        code: string
        mega?: boolean
      } | null,
      lanes: [
        {
          to: number,
          two_way: boolean
        }
      ],
      visited: boolean,
      last_visited?: string,
    }
  ],
  center_sector: number,
  total_sectors: number,
  total_visited: number,
  total_unvisited: number,
}
```

### map.update

```tsx
{
  sectors: [
    {
      id: number,
      scope?: "player" | "corp" | "both",
      region?: string | null,
      position: [number, number],
      adjacent_sectors: number[],
      hops_from_center: number,
      port: {
        code: string
        mega?: boolean
      } | null,
      lanes: [
        {
          to: number,
          two_way: boolean
        }
      ],
      visited: boolean,
      last_visited?: string,
    }
  ],
  center_sector: number,
  total_sectors: number,
  total_visited: number,
  total_unvisited: number,
  __task_id?: string,
}
```

### `course.plot`

```tsx
{
  scope?: "player" | "corp" | "both",
  path: number[],
  distance: number,
  to_sector: number,
  from_sector: number,
}
```

### `salvage.collected`

```tsx
{
  action: "collected",
  scope?: "player" | "corporation",
  sector: { id: number },
  source: {
    type: "rpc",
    method: string,
    timestamp: string,
    request_id: string,
  },
  timestamp: string,
  salvage_details: {
    salvage_id: string,
    collected: {
      cargo: {
        quantum_foam?: number,
        retro_organics?: number,
        neuro_symbolics?: number,
      },
      credits: number,
    },
    remaining: {
      cargo: {
        quantum_foam?: number,
        retro_organics?: number,
        neuro_symbolics?: number,
      },
      scrap: number,
    },
    fully_collected: boolean,
  },
  __task_id?: string,
}
```

### `salvage.created`

```tsx
{
  action: "dumped",
  scope?: "player" | "corporation",
  salvage_details: {
    salvage_id: string,
    cargo: {
      quantum_foam?: number,
      retro_organics?: number,
      neuro_symbolics?: number,
    },
    scrap: number,
    credits: number,
    expires_at: string,
  },
  sector: { id: number },
  timestamp: string,
  source: {
    type: "rpc",
    method: string,
    timestamp: string,
    request_id: string,
  },
  salvage_id?: string,
  cargo?: {
    quantum_foam?: number,
    retro_organics?: number,
    neuro_symbolics?: number,
  },
  scrap?: number,
  credits?: number,
  from_ship_type?: string,
  from_ship_name?: string,
}
```

### `ships.list`

```tsx
{
  ships: [
    {
      ship_id: string,
      ship_name: string,
      ship_type: string,
      owner_type: "personal" | "corporation",
      sector: number | null,
      cargo: {
        quantum_foam: number,
        retro_organics: number,
        neuro_symbolics: number,
      },
      credits: number,
      shields: number,
      max_shields: number,
      fighters: number,
      max_fighters: number,
      warp_power: number,
      warp_power_capacity: number,
      cargo_capacity: number,
      current_task_id: string | null,
    }
  ],
  source?: {
    type: "rpc",
    method: string,
    timestamp: string,
    request_id: string,
  },
}
```
