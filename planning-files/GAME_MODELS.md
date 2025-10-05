# Models

## Base

```ts
interface ServerMessage {
  delta?: Record<string, unknown>;
  event: string;
  payload: unknown;
  summary?: string;
  tool_name?: string;
}
```

## System

Client only

```typescript
interface Settings {
  ambienceVolume: number;
  disabledAmbience: false;
  disabledSoundFX: false;
  disableMusic: false;
  disableRemoteAudio: false;
  enableMic: true;
  musicVolume: number;
  qualityPreset: "text" | "low" | "medium" | "high";
  remoteAudioVolume: number;
  renderStarfield: true;
  soundFXVolume: number;
  startMuted: false;
}
```

## Player

```ts
interface PlayerBase {
  created_at: string;
  id: string;
  last_active?: string;
  name: string;
}

// Local player 
interface PlayerSelf extends PlayerBase {
  credits: number;
  credits_in_bank: number;
  credits_in_hand: number;
}

// Remote player / npc
interface Player extends PlayerBase {
  player_type: "npc" | "human";
  ship: Ship;
}
```

## Resource

```ts
type Resource = "EQ" | "FO" | "OG";
```

## Ship

```ts
interface Ship {
  fighters?: number; // nullable, shown for `Player` only when in combat
  shields?: number;  // nullable, shown for `Player` only when in combat
  ship_name: string;
  ship_type: ShipType;
}

interface ShipType {
  id: string;
  max_cargo: number; // total max cargo capacity (was `cargo_capacity`)
  max_fighters: number;
  max_holds: number;
  max_shields: number;
  max_warp_power: number;
  name: string;
}

interface ShipSelf extends Ship {
  cargo: Record<Resource, number>;
  cargo_capacity: number; // was `cargo_used`
  holds: number;
  warp_power: number;
  warp_power_capacity: number;
}
```

## Region & Sector

```ts
interface Region {
  id:
    | "core_worlds"
    | "trade_federation"
    | "frontier"
    | "pirate_space"
    | "neutral_zone";
  name: string;
  safe: boolean;
}

interface Sector {
  adjacent_sectors?: number[];
  id: number;
  last_visited?: string;
  planets?: Planet[];
  players?: Player[];
  port?: Port;
  region: Region;
  scene_config?: unknown;
}

interface Planet {
  class_code: string;
  class_name: string;
  id: number;
}
```

## Port

Ports use the same data model if current or distant. Client determines whether prices and stock are live or last seen via `observed_at` (`null` if live.)

```ts
interface PortBase {
  code: string;
}

interface Port extends PortBase {
  max_capacity: Record<Resource, number>;
  observed_at?: string;
  stock: Record<Resource, number>;
  warp_power_depot?: PortWarpPowerDepot;
}

interface PortWarpPowerDepot {
  note?: string;
  price_per_unit: number;
}

```

## Map

```ts
interface MapNode {
  id: number;
  lanes: MapLane[];
  position: [number, number];
  sector: Sector;
  visited: boolean;
}

interface MapLane {
  hyperlane: boolean;
  to: number;
  two_way: boolean;
}
```

## History

```ts
interface MovementHistory {
  from: number;
  port?: PortBase;
  timestamp?: string;
  to: number;
}

interface DiscoveredPorts {
 ports: Sector[]
}
```

## UI

Note: client only

```ts
export interface UIState {
  active_modal?:
    | "trade"
    | "ship"
    | "self"
    | "player"
    | "map"
    | "combat";
  highlight_element_id?: string;
  state: "idle" | "warping" | "moving" | "plotting" | "trading";
}
```

## Task

## Trade

## Message

## Combat