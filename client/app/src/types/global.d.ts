declare global {
  // --- PLAYER

  interface PlayerBase {
    id: string
    name: string
    created_at?: string
  }

  interface PlayerSelf extends PlayerBase {
    player_type: "human" | "npc" | "corporation_ship"
    sectors_visited: number
    total_sectors_known: number
    credits_in_bank: number
    corp_sectors_visited?: number
    universe_size: number
    last_active?: string
  }

  interface Player extends PlayerBase {
    player_type: "npc" | "human" | "corporation_ship"
    ship: Ship
    corporation?: Corporation
  }

  // --- CORPORATION

  interface Corporation {
    corp_id: string
    name: string
    member_count: number
    joined_at?: string
    timestamp?: string
    founder_id?: string
    invite_code?: string
    member_count?: number
  }

  // --- RESOURCE

  type Resource = "neuro_symbolics" | "quantum_foam" | "retro_organics"
  type ResourceList = Resource[]

  // --- SHIP

  interface Ship {
    ship_id: string
    ship_name: string
    ship_type: string
    fighters?: number
    shields?: number
    max_shields?: number
    max_fighters?: number
    owner_type?: "personal" | "corporation" | "unowned"
    current_task_id?: string | null
    sector?: number
  }

  interface ShipSelf extends Ship {
    cargo: Record<Resource, number>
    cargo_capacity: number
    empty_holds: number
    turns_per_warp: number
    warp_power: number
    warp_power_capacity: number
    credits: number
  }

  interface ShipDefinition {
    ship_type: string
    display_name: string
    cargo_holds: number
    warp_power_capacity: number
    turns_per_warp: number
    shields: number
    fighters: number
    base_value: number
    stats: Map<string, unknown>
    purchase_price: number
  }

  interface ShipUnowned extends Ship {
    owner_id: string
    owner_type: "unowned"
    became_unowned: string
    former_owner_name: string
    cargo: Record<Resource, number>
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
    id: "core_worlds" | "trade_federation" | "frontier" | "pirate_space" | "neutral_zone"
    name: string
    safe: boolean
  }

  interface Sector {
    id: number
    adjacent_sectors?: number[]
    position: [number, number]
    last_visited?: string
    planets?: Planet[]
    players?: Player[]
    port?: Port
    region?: string
    unowned_ships?: ShipUnowned[]
    last_visited?: string
    salvage?: Salvage[]
    scene_config?: unknown

    // Not yet implemented
    garrison?: Garrison[] | null
  }

  interface Planet {
    class_code: string
    class_name: string
    id: number
  }

  interface Salvage {
    salvage_id: string
    source?: {
      ship_name: string
      ship_type: string
    }
    cargo?: Record<Resource, number>
    credits?: number
    scrap?: number
    claimed?: boolean
    metadata?: Record<string, unknown>
    created_at?: string

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
    mega?: boolean
    stock: Record<Resource, number>
    prices: Record<Resource, number>
    port_class?: number
    observed_at?: string

    //warp_power_depot?: PortWarpPowerDepot
  }

  // interface PortWarpPowerDepot {
  //   note?: string
  //   price_per_unit: number
  // }

  // --- MAP

  type MapData = MapSectorNode[]

  interface MapSectorNode {
    id: number
    port?: PortBase | null
    lanes: MapLane[]
    scope?: "player" | "corp" | "both"
    region?: string
    visited?: boolean
    position: [number, number]
    last_visited?: string
    adjacent_sectors?: number[]
    hops_from_center?: number
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
    scope?: "player" | "corporation"
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
  type UIScreen = "map" | "ship-details"
  type UIPanel = "sector" | "player" | "trade" | "tasks" | "corp" | "logs"
  type UIModal = "settings" | "leaderboard" | "signup" | "character_select" | undefined

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
    | "CANCELLED"

  interface Task {
    id: string
    summary: string
    type: TaskType
    timestamp: string
  }

  interface ActiveTask {
    task_id: string
    task_description?: string
    started_at: string
    actor_character_id?: string
    actor_character_name?: string
    task_scope?: "player_ship" | "corp_ship"
    ship_id?: string
    ship_name?: string | null
    ship_type?: string | null
  }

  interface TaskSummary extends ActiveTask {
    task_status: "completed" | "cancelled" | "failed"
    task_summary: string
  }

  interface TaskOutput {
    task_id: string
    text: string
    task_message_type: TaskType
  }

  export interface TaskHistoryEntry {
    task_id: string
    started: string // ISO8601
    ended: string | null // null if running
    start_instructions: string
    end_summary: string | null
    end_status?: string | null
    actor_character_id?: string
    actor_character_name?: string
    task_scope?: "player_ship" | "corp_ship"
    ship_id?: string
    ship_name?: string | null
    ship_type?: string | null
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

  interface LeaderboardTrading {
    name: string
    total_trades: number
    total_trade_volume: number
    ports_visited: number
  }

  interface LeaderboardExploration {
    name: string
    sectors_visited: number
    first_visit: string
  }

  interface LeaderboardResponse {
    wealth: LeaderboardWealth[]
    trading: LeaderboardTrading[]
    exploration: LeaderboardExploration[]
    territory: LeaderboardTerritory[]
  }

  interface CharacterSelectResponse {
    character_id: string
    name: string
    created_at: string
    last_active: string
    is_npc: boolean
  }

  // --- CONVERSATION

  export type ConversationMessageRole = "user" | "assistant" | "system" | "tool"
  export interface ConversationMessagePart {
    text: string | ReactNode
    final: boolean
    createdAt: string
  }

  export interface ConversationMessage {
    role: ConversationMessageRole
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
