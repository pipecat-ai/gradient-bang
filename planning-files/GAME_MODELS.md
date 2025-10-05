# Models

## System

Note: client only

```typescript
interface Settings {
  startMuted: false;
  enableMic: true;
  disableRemoteAudio: false;
  remoteAudioVolume: number;
  disabledSoundFX: false;
  soundFXVolume: number;
  disabledAmbience: false;
  ambienceVolume: number;
  disableMusic: false;
  musicVolume: number;
  renderStarfield: true;
  qualityPreset: "text" | "low" | "medium" | "high";
}

```

## Player

```ts
interface PlayerBase {
  id: string;
  name: string;
  created_at: string;
  last_active?: string;
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
  ship_name: string;
  ship_type: ShipType;
  shields?: number;  // nullable, shown for `Player` only when in combat
  fighters?: number; // nullable, shown for `Player` only when in combat
}

interface ShipType {
  id: string;
  name: string;
  max_holds: number;
  max_shields: number;
  max_fighters: number;
  max_cargo: number; // total max cargo capacity (was `cargo_capacity`)
  max_warp_power: number;
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
  id: number;
  name:
    | "core_worlds"
    | "trade_federation"
    | "frontier"
    | "pirate_space"
    | "neutral_zone";
  safe: boolean;
}

interface Sector {
  id: number;
  region: Region;
  adjacent_sectors?: number[];

  port?: Port;
  planets?: Planet[];
  players?: Player[];

  scene_config: unknown;
  last_visited?: string;
}

interface Planet {
  id: number;
  class_code: string;
  class_name: string;
}
```

## Port

Ports use the same data model if current or distant. Client determines whether prices and stock are live or last seen via `observed_at` (`null` if live.)

```ts
interface PortBase {
  code: string;
}

interface Port extends PortBase {
  stock: Record<Resource, number>;
  max_capacity: Record<Resource, number>;
  warp_power_depot?: PortWarpPowerDepot;
  observed_at?: string;
}

interface PortWarpPowerDepot {
  price_per_unit: number;
  note?: string;
}

```

## Map

```ts
interface MapNode {
  id: number;
  position: [number, number];
  sector: Sector;
  lanes: MapLane[];
  visited: boolean;
}

interface MapLane {
  to: number;
  two_way: boolean;
  hyperlane: boolean;
}
```

## Logs & History

```ts
interface Log{
  summary: text;
  timestamp: string;
}

interface MovementHistory {
  from: number;
  to: number;
  port?: PortBase;
  timestamp?: string;
}

interface DiscoveredPorts {
 ports: Sector[]
}
```

## UI

Note: client only

```ts
export interface UIState {
  state: "idle" | "warping" | "moving" | "plotting" | "trading";
  active_modal?:
    | "trade"
    | "ship"
    | "self"
    | "player"
    | "map"
    | "combat";
  highlight_element_id?: string;
}
```

## Task

## Trade

## Message

## Combat