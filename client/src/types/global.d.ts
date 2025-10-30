declare global {
  // --- PLAYER

  interface PlayerBase {
    id: string;
    last_active?: string;
    name: string;
  }

  interface PlayerSelf extends PlayerBase {
    credits_in_bank: number;
    credits_on_hand: number;
    created_at: string;
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
    ship_type: string;
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
    credits: number;
    cargo: Record<Resource, number>;
    cargo_capacity: number;
    empty_holds: number;
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

  interface Salvage {
    salvage_id: string;

    cargo?: Record<Resource, number>;
    credits?: number;
    scrap?: number;

    collected?: {
      cargo: Record<Resource, number>;
      scrap?: number;
      credits?: number;
    };
    remaining?: {
      cargo: Record<Resource, number>;
      scrap?: number;
      credits?: number;
    };
    expires_at?: string;
    fully_collected?: boolean;
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
    hops_from_center?: number;
    position: [number, number];
    visited?: string;
    port?: string;
    region?: string;
    lanes: MapLane[];
    is_mega?: boolean;
  }

  interface MapLane {
    to: number;
    two_way: boolean;
    hyperlane?: boolean;
  }

  interface CoursePlot {
    from_sector: number;
    to_sector: number;
    path: number[];
    distance: number;
  }

  // --- HISTORY

  interface MovementHistory {
    timestamp: string;
    from: number;
    to: number;
    port: boolean;
  }

  // --- UI

  type UIState = "idle" | "moving" | "combat" | "paused";
  type UIScreen = "self" | "messaging" | "trading" | "map" | "tasks" | "combat";
  type UIModal = "settings" | undefined;

  // --- COMBAT

  interface CombatSession {
    combat_id: string;
    initiator: string;
    participants: Player[];
    round: number;
    deadline: string;
    current_time: string;
  }

  interface CombatAction {
    combat_id: string;
    action: "brace" | "attack" | "flee";
    commit?: number;
    round?: number;
    target_id?: string;
    to_sector?: number;
  }

  interface CombatRound {
    combat_id: string;
    sector: Sector;
    round: number;

    hits: Record<string, number>; // player_id -> number of hits
    offensive_losses: Record<string, number>; // player_id -> number of offensive losses
    defensive_losses: Record<string, number>; // player_id -> number of defensive losses
    shield_loss: Record<string, number>; // player_id -> number of shield losses
    flee_results: Record<string, boolean>; // player_id -> true if they fled successfully, false if they failed to flee
    actions: Record<string, CombatAction>; // player_id -> CombatAction

    end: string;
    result: string;
  }

  // --- MISC

  interface Task {
    id: string;
    summary: string;
    timestamp: string;
  }

  interface LogEntry {
    type: string;
    message: string;

    timestamp?: string; // Note: set by the store
    meta?: Record<string, unknown>; // Note: set by the store
  }

  interface ChatMessage {
    id: number;
    type: "direct" | "broadcast";
    from_name: string;
    content: string;
    to_name?: string;
    timestamp: string;
    timestamp_client?: number;
  }
}

export {};
