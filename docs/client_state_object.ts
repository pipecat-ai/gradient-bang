//----- Types -----//

export interface Player {
  id: string;
  name: string;
  created_at: string;
  last_active?: string;
}

export interface PlayerLocal extends Player {
  credits: number;
}

export interface PlayerRemote extends Player {
  player_type: "npc" | "human";
  ship: ShipBase;
}

export interface Settings {
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

export interface ShipBase {
  ship_name: string;
  ship_type: { id: string; name: string };
}

export interface Ship extends ShipBase {
  cargo: Record<Resource, number>;
  cargo_capacity: number;
  cargo_used: number;
  warp_power: number;
  warp_power_capacity: number;
  shields: number;
  max_shields: number;
  fighters: number;
  max_fighters: number;
}

export interface Region {
  id: number;
  name:
    | "core_worlds"
    | "trade_federation"
    | "frontier"
    | "pirate_space"
    | "neutral_zone";
  safe: boolean;
}

export interface SectorBase {
  id: number;
  region: Region;
  adjacent_sectors?: number[];
  last_visited?: string;
}

export interface Sector extends SectorBase {
  port?: Port; // Show last known port state
  planets?: Planet[];
}

export interface SectorCurrent extends SectorBase {
  port?: Port; // Show current port state
  players?: PlayerRemote[];
  planets?: Planet[];
  // Nice to have sooner rather than later for persistence FX
  scene_config: Partial<GalaxyStarfieldConfig>;
}

export interface Planet {
  id: number;
  class_code: string;
  class_name: string;
}

export type Resource = "EQ" | "FO" | "OG";

export interface PortBase {
  code: string;
}

export interface Port extends PortBase {
  stock: Record<Resource, number>; // can be current or last known
  max_capacity: Record<Resource, number>; // can be current or last known
  warp_power_depot?: PortWarpPowerDepot; // can be current or last known
  observed_at?: string;
}

export interface PortWarpPowerDepot {
  price_per_unit: number;
  note?: string;
}

export interface MapNode {
  id: number;
  position: [number, number];
  sector: Sector;
  lanes: MapLane[];
  visited: boolean;
}

export interface MapLane {
  to: number;
  two_way: boolean;
  hyperlane: boolean;
}

export interface MovementHistory {
  from: Sector;
  to: Sector;
  port?: PortBase;
  timestamp?: string;
}

export interface UIState {
  state: "idle" | "warping" | "moving" | "plotting" | "trading"; // Note: client configured
  active_modal?: "trade" | "ship" | "player" | "remote_player" | "map";
  highlight_element_id?: string;
}

//----- Gradient Bang State Schema -----//

export interface GradientBangStateSchema {
  // Client configured
  settings: Settings;
  ui: UIState;

  // Core
  player: PlayerLocal;
  ship: Ship;
  sector: SectorCurrent;

  // Map
  map_local: MapNode[]; // minimap (subset of entire map)
  map_discovered: MapNode[]; // universe map of all discovered sectors
  map_plot?: MapNode[]; // subset with proposed flight path (if plotting)

  // Movement
  movement_history: MovementHistory[];

  // Trades
  // Tasks
  // Messages
  // Combat
}
