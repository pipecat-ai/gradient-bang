declare global {
  // --- PLAYER
  interface PlayerBase {
    created_at: string;
    id: string;
    last_active?: string;
    name: string;
  }

  interface PlayerSelf extends PlayerBase {
    credits_in_bank: number;
    credits_on_hand: number;
  }

  interface Player extends PlayerBase {
    player_type: "npc" | "human";
    ship: Ship;
  }

  // --- RESOURCE
  type Resource = "neuro_symbolics" | "quantum_foam" | "retro_organics";
  type ResourceList = Resource[];

  // --- SHIP
  interface Ship {
    fighters?: number;
    shields?: number;
    ship_name: string;
    ship_type: ShipType;
  }

  interface ShipType {
    id: string;
    max_cargo: number;
    max_fighters: number;
    max_holds: number;
    max_shields: number;
    max_warp_power: number;
    name: string;
  }

  interface ShipSelf extends Ship {
    cargo: Record<Resource, number>;
    cargo_used: number;
    cargo_capacity: number;
    holds: number;
    warp_power: number;
    warp_power_capacity: number;
  }

  // --- REGION AND SECTOR
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

    // Not yet implemented
    garrisons?: [];
    salvage?: [];
  }

  interface Planet {
    class_code: string;
    class_name: string;
    id: number;
  }

  // --- PORT
  interface PortBase {
    code: string;
  }

  interface Port extends PortBase {
    max_capacity: Record<Resource, number>;
    observed_at?: string;
    stock: Record<Resource, number>;
    prices: Record<Resource, number>;
    warp_power_depot?: PortWarpPowerDepot;
  }

  interface PortWarpPowerDepot {
    note?: string;
    price_per_unit: number;
  }

  // --- MAP
  type MapData = MapSectorNode[];

  interface MapSectorNode {
    id: number;
    position: [number, number];
    visited?: boolean;
    port?: string;
    region?: string;
    lanes: MapLane[];
  }

  interface MapLane {
    to: number;
    two_way: boolean;
    hyperlane?: boolean;
  }

  // --- HISTORY

  interface MovementHistory {
    timestamp: string;
    from: number;
    to: number;
    port: boolean;
  }

  // --- UI
  type UIState = "idle" | "moving" | "autopilot" | "combat" | "paused";
  type UIScreen = "self" | "messaging" | "trading" | "map" | "tasks" | "combat";
  type UIModal = "settings" | undefined;

  // --- ACTIVITY

  interface LogEntry {
    type: string;
    message: string;

    timestamp?: string; // Note: set by the store
    meta?: Record<string, unknown>; // Note: set by the store
  }
}

export {};
