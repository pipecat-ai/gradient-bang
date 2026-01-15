declare global {
  // --- PLAYER

  interface PlayerBase {
    id: string
    last_active?: string
    name: string
    created_at?: string
  }

  interface PlayerSelf extends PlayerBase {
    credits_in_bank: number
    sectors_visited: number
    universe_size: number
  }

  interface Player extends PlayerBase {
    player_type: "npc" | "human"
    ship: Ship
  }

  // --- RESOURCE

  type Resource = "neuro_symbolics" | "quantum_foam" | "retro_organics"
  type ResourceList = Resource[]

  // --- SHIP

  interface Ship {
    ship_name: string
    ship_type: string
    fighters?: number
    shields?: number

    max_shields?: number
    max_fighters?: number
  }

  interface ShipType {
    id: string
    name: string
    max_cargo: number
    max_fighters: number
    max_holds: number
    max_shields: number
    max_warp_power: number
  }

  interface ShipSelf extends Ship {
    cargo: Record<Resource, number>
    cargo_capacity: number
    empty_holds: number
    warp_power: number
    warp_power_capacity: number
    credits: number
  }

  // --- GARRISON

  interface Garrison {
    id: string
    fighters: number
    fighter_loss: number
    mode: "offensive" | "defensive" | "toll"
    toll_amount: number
    deployed_at?: string
  }

  // --- REGION AND SECTOR
  interface Region {
    id:
      | "core_worlds"
      | "trade_federation"
      | "frontier"
      | "pirate_space"
      | "neutral_zone"
    name: string
    safe: boolean
  }

  interface Sector {
    adjacent_sectors?: number[]
    id: number
    last_visited?: string
    planets?: Planet[]
    players?: Player[]
    port?: Port
    region?: Region
    scene_config?: unknown

    // Not yet implemented
    garrisons?: Garrison[]
    salvage?: Salvage[]
  }

  interface Planet {
    class_code: string
    class_name: string
    id: number
  }

  interface Salvage {
    salvage_id: string
    source?: Ship

    cargo?: Record<Resource, number>
    credits?: number
    scrap?: number

    collected?: {
      cargo: Record<Resource, number>
      scrap?: number
      credits?: number
    }
    remaining?: {
      cargo: Record<Resource, number>
      scrap?: number
      credits?: number
    }
    expires_at?: string
    fully_collected?: boolean
  }

  // --- PORT

  interface PortBase {
    code: string
  }

  interface Port extends PortBase {
    // max_capacity: Record<Resource, number>;
    code: string
    observed_at?: string | null
    stock: Record<Resource, number>
    prices: Record<Resource, number>
    warp_power_depot?: PortWarpPowerDepot
  }

  interface PortWarpPowerDepot {
    note?: string
    price_per_unit: number
  }

  // --- MAP

  type MapData = MapSectorNode[]

  interface MapSectorNode {
    id: number
    hops_from_center?: number
    position: [number, number]
    adjacent_sectors?: number[]
    visited?: boolean
    port?: string
    region?: string
    lanes: MapLane[]
    is_mega?: boolean
    last_visited?: string
  }

  interface MapLane {
    to: number
    two_way: boolean
    hyperlane?: boolean
  }

  interface CoursePlot {
    from_sector: number
    to_sector: number
    path: number[]
    distance: number
  }

  // --- HISTORY

  interface MovementHistory {
    timestamp: string
    from: number
    to: number
    port: boolean
    last_visited?: string
  }

  // --- UI

  type UIState = "idle" | "moving" | "combat" | "paused"
  type UIScreen = "self" | "messaging" | "trading" | "map" | "tasks" | "combat"
  type UIModal =
    | "settings"
    | "leaderboard"
    | "signup"
    | "character_select"
    | undefined

  // --- COMBAT

  interface CombatSession {
    combat_id: string
    initiator: string
    participants: Player[]
    round: number
    deadline: string
    current_time: string
  }

  interface CombatAction {
    combat_id: string
    action: "brace" | "attack" | "flee"
    commit?: number
    round?: number
    target_id?: string
    to_sector?: number
  }

  interface CombatRound {
    combat_id: string
    sector: Sector
    round: number

    hits: Record<string, number> // player_id -> number of hits
    offensive_losses: Record<string, number> // player_id -> number of offensive losses
    defensive_losses: Record<string, number> // player_id -> number of defensive losses
    shield_loss: Record<string, number> // player_id -> number of shield losses
    flee_results: Record<string, boolean> // player_id -> true if they fled successfully, false if they failed to flee
    actions: Record<string, CombatAction> // player_id -> CombatAction

    end: string
    result: string
  }

  // --- MISC

  type TaskType =
    | "STEP"
    | "ACTION"
    | "EVENT"
    | "MESSAGE"
    | "ERROR"
    | "FAILED"
    | "COMPLETE"
    | "FINISHED"

  interface Task {
    id: string
    summary: string
    type: TaskType
    timestamp: string
  }

  interface LogEntry {
    type: string
    message: string

    timestamp?: string // Note: set by the store
    timestamp_client?: number // Note: set by the store
    signature?: string // Note: derived via utility for stacking
    meta?: Record<string, unknown> // Note: set by the store
  }

  interface ChatMessage {
    id: number
    type: "direct" | "broadcast"
    from_name: string
    content: string
    to_name?: string
    timestamp: string
  }

  interface LeaderboardWealth {
    name: string
    bank_credits: number
    ship_credits: number
    cargo_value: number
    ships_owned: number
    ship_value: number
    total_wealth: number
  }

  interface LeaderboardResponse {
    wealth: LeaderboardWealth[]
  }

  interface CharacterSelectResponse {
    character_id: string
    name: string
    created_at: string
    last_active: string
    is_npc: boolean
  }

  // --- CONVERSATION

  export interface ConversationMessagePart {
    text: string | ReactNode
    final: boolean
    createdAt: string
  }

  export interface ConversationMessage {
    role: "user" | "assistant" | "system"
    final?: boolean
    parts: ConversationMessagePart[]
    createdAt: string
    updatedAt?: string
  }

  /**
   * Text mode for conversation display
   */
  export type TextMode = "llm" | "tts"
}

export {}
