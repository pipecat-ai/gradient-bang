declare global {
  // --- PLAYER

  type PlayerType = "human" | "npc" | "corporation_ship"

  interface PlayerBase {
    id: string
    name: string
    created_at?: string
  }

  interface PlayerSelf extends PlayerBase {
    player_type: PlayerType
    sectors_visited: number
    total_sectors_known: number
    credits_in_bank: number
    corp_sectors_visited?: number
    universe_size: number
    last_active?: string
  }

  interface Player extends PlayerBase {
    ship: Ship
    corporation?: Corporation
    player_type?: PlayerType
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
    owner_type: "unowned"
    became_unowned: string
    former_owner_name: string
    cargo: Record<Resource, number>
  }
  // --- GARRISON

  interface Garrison {
    mode: "offensive" | "defensive" | "toll"
    owner_id: string
    owner_name: string
    fighters: number
    fighter_loss: number
    deployed_at?: string
    toll_balance?: number
    toll_amount: number
    is_friendly?: boolean
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
    port?: PortBase | null
    garrison?: Garrison
    region?: string
    unowned_ships?: ShipUnowned[]
    last_visited?: string
    salvage?: Salvage[]
    scene_config?: unknown
  }

  interface SectorHistory {
    sector: Sector
    updated_at?: string
    last_visited?: string
    hops_from_start?: number
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
    mega?: boolean
    port_class?: number
    observed_at?: string
  }

  interface Port extends PortBase {
    // max_capacity: Record<Resource, number>;
    code: string
    mega?: boolean
    stock: Record<Resource, number>
    prices: Record<Resource, number>
  }

  type PortLike =
    | PortBase
    | Port
    | {
        port_code?: unknown
        mega?: unknown
        [key: string]: unknown
      }
    | string
    | null
    | undefined

  // --- MAP

  type MapData = MapSectorNode[]

  interface MapSectorGarrison {
    player_id: string
    corporation_id: string | null
  }

  interface MapSectorNode {
    id: number
    port?: PortBase | null
    lanes: MapLane[]
    source?: "player" | "corp" | "both"
    region?: string
    visited?: boolean
    position: [number, number]
    last_visited?: string
    adjacent_sectors?: number[]
    hops_from_center?: number
    garrison?: MapSectorGarrison | null
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
  type UIMode = "tasks" | "map"
  type UIScreen = "ship-details" | "combat-results"
  type UIPanel = "sector" | "player" | "trade" | "task_history" | "corp" | "logs" | "task_stream"
  type UIModal =
    | "settings"
    | "leaderboard"
    | "signup"
    | "character_select"
    | "disconnect"
    | undefined

  // --- COMBAT

  type CombatActionType = "brace" | "attack" | "flee" | "pay"

  interface CombatParticipantShip {
    ship_type: string
    ship_name: string
    shield_integrity: number
    shield_damage?: number | null
    fighter_loss?: number | null
  }

  interface CombatParticipant {
    id?: string
    name: string
    created_at: string
    player_type: PlayerType
    ship: CombatParticipantShip
  }

  interface CombatGarrison {
    id?: string
    name?: string
    owner_name: string
    fighters: number
    fighter_loss: number | null
    mode: "offensive" | "defensive" | "toll"
    toll_amount: number
    deployed_at: string | null
    is_friendly?: boolean
  }

  interface CombatSession {
    combat_id: string
    initiator?: string
    participants: CombatParticipant[]
    garrison?: CombatGarrison | null
    round: number
    deadline: string | null
    current_time: string
  }

  interface CombatAction {
    action: CombatActionType
    commit: number
    timed_out: boolean
    submitted_at: string
    target?: string | null
    target_id?: string | null
    destination_sector?: number | null
  }

  interface CombatActionReceipt {
    combat_id: string
    round: number
    action: CombatActionType
    commit: number
    target_id: string | null
    round_resolved?: boolean
  }

  interface CombatRoundLog {
    round_number: number
    actions: Record<string, CombatAction>
    hits: Record<string, number>
    offensive_losses: Record<string, number>
    defensive_losses: Record<string, number>
    shield_loss: Record<string, number>
    damage_mitigated?: Record<string, number>
    result: string | null
    timestamp: string
  }

  interface CombatRound {
    combat_id: string
    sector: { id: number }
    round: number

    hits: Record<string, number> // player_id -> number of hits
    offensive_losses: Record<string, number> // player_id -> number of offensive losses
    defensive_losses: Record<string, number> // player_id -> number of defensive losses
    shield_loss: Record<string, number> // player_id -> number of shield losses
    damage_mitigated: Record<string, number> // player_id -> mitigated damage from shield/brace mechanics
    fighters_remaining: Record<string, number>
    shields_remaining: Record<string, number>
    flee_results: Record<string, boolean> // player_id -> true if they fled successfully, false if they failed to flee
    actions?: Record<string, CombatAction> // participant display name -> CombatAction
    participants: CombatParticipant[]
    garrison: CombatGarrison | null

    deadline: string | null
    end: string | null
    result: string | null
    round_result?: string | null
  }

  interface CombatEndedRound extends CombatRound {
    salvage: Salvage[]
    logs: CombatRoundLog[]
    ship?: ShipSelf
  }

  type CombatIncomingAttack = {
    attackerName: string
    fightersCommitted: number
  }

  type CombatPersonalRoundResult = {
    round: number
    action: string
    outcome: string
    target: string | null
    hits: number
    offensiveLosses: number
    defensiveLosses: number
    shieldLoss: number
    damageMitigated: number
    fightersRemaining: number | null
    shieldsRemaining: number | null
    fleeSuccess: boolean | null
    incomingAttacks: CombatIncomingAttack[]
  }

  type CombatAttackTargetOption = {
    key: string
    id: string | null
    name: string | null
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

  export interface TradeHistoryEntry {
    timestamp?: string
    sector: number
    commodity: Resource
    units: number
    price_per_unit: number
    total_price: number
    is_buy: boolean
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
