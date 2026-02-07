// --- Server / Inbound Messages

export interface PlayerIdentity {
  id: string
  name?: string
  player_type?: "human" | "npc" | "corporation_ship"
}

export interface ServerMessage {
  event: string
  payload: ServerMessagePayload
  summary?: string
  tool_name?: string
  task_id?: string
}

export interface ServerMessagePayload {
  source?: {
    method: string
    request_id: string
    timestamp: string
    type: string
  }
  player?: PlayerIdentity
  ship_id?: string
  [key: string]: unknown
}

export interface ErrorMessage extends ServerMessagePayload {
  error: string
  endpoint?: string
}

export interface TaskOutputMessage extends ServerMessagePayload {
  text: string
  task_message_type: TaskType
}

export interface TaskCompleteMessage extends ServerMessagePayload {
  was_cancelled: boolean
}

export interface TaskStartMessage extends ServerMessagePayload {
  task_id: string
  task_description?: string
  task_status?: string
  actor_character_id?: string
  actor_character_name?: string
  task_scope?: "player_ship" | "corp_ship"
  ship_id?: string
  ship_name?: string | null
  ship_type?: string | null
}

export interface TaskFinishMessage extends ServerMessagePayload {
  task_id: string
  task_summary?: string
  task_status?: string
  actor_character_id?: string
  actor_character_name?: string
  task_scope?: "player_ship" | "corp_ship"
  ship_id?: string
  ship_name?: string | null
  ship_type?: string | null
}

export interface TaskStartMessage extends ServerMessagePayload {
  task_id: string
  task_description?: string
  task_status?: string
  actor_character_id?: string
  actor_character_name?: string
  task_scope?: "player_ship" | "corp_ship"
  ship_id?: string
  ship_name?: string | null
  ship_type?: string | null
}

export interface TaskFinishMessage extends ServerMessagePayload {
  task_id: string
  task_summary?: string
  task_status?: string
  actor_character_id?: string
  actor_character_name?: string
  task_scope?: "player_ship" | "corp_ship"
  ship_id?: string
  ship_name?: string | null
  ship_type?: string | null
}
export interface IncomingChatMessage extends ServerMessagePayload, ChatMessage {}

export interface StatusMessage extends ServerMessagePayload {
  player: PlayerSelf
  ship: ShipSelf
  sector: Sector
  corporation?: Corporation
}

export interface MovementStartMessage extends ServerMessagePayload {
  sector: Sector
  hyperspace_time: number
}

export interface MovementCompleteMessage extends ServerMessagePayload {
  ship: ShipSelf
  player: PlayerSelf
  first_visit?: boolean
}

export interface MapLocalMessage extends ServerMessagePayload {
  sectors: MapData
  center_sector: number
  total_sectors: number
  total_unvisited: number
  total_visited: number
}

export interface CoursePlotMessage extends ServerMessagePayload {
  from_sector: number
  to_sector: number
  path: number[]
  distance: number
}

export interface WarpPurchaseMessage extends ServerMessagePayload {
  character_id: string
  sector: Sector
  units: number
  price_per_unit: number
  total_cost: number
  timestamp: string
  new_warp_power: number
  warp_power_capacity: number
  new_credits: number
}

export interface PortUpdateMessage extends ServerMessagePayload {
  sector: Sector
}

export interface CharacterMovedMessage extends ServerMessagePayload {
  player: Player
  ship: Ship
  timestamp: string
  move_type: string
  name: string
  movement?: "depart" | "arrive"
  sector?: number | { id: number }
}

export interface KnownPortListMessage extends ServerMessagePayload {
  from_sector: number
  ports: Port[]
  total_ports_found: number
  searched_sectors: number
}

export interface BankTransactionMessage extends ServerMessagePayload {
  character_id: string
  sector: Sector
  direction: "deposit" | "withdraw"
  amount: number
  timestamp: string
  credits_on_hand_before: number
  credits_on_hand_after: number
  credits_in_bank_before: number
  credits_in_bank_after: number
}

export interface TradeExecutedMessage extends ServerMessagePayload {
  player: PlayerSelf
  ship: ShipSelf
  trade: {
    trade_type: "buy" | "sell"
    commodity: Resource
    units: number
    price_per_unit: number
    total_price: number
    new_credits: number
    new_cargo: Record<Resource, number>
    new_prices: Record<Resource, number>
  }
}

export interface SectorUpdateMessage extends ServerMessagePayload, Sector {}

export interface SalvageCreatedMessage extends ServerMessagePayload {
  action?: string
  sector: { id: number }
  salvage_details?: Salvage
  dumped_cargo?: Record<Resource, number>
  timestamp?: string

  // combat_finalization salvage.created shape
  salvage_id?: string
  cargo?: Record<Resource, number>
  scrap?: number
  credits?: number
  from_ship_type?: string
  from_ship_name?: string
}

export interface SalvageCollectedMessage extends ServerMessagePayload {
  sector: Sector
  salvage_details: Salvage
  timestamp: string
}

export interface TransferMessageBase extends ServerMessagePayload {
  transfer_direction: "received" | "sent"
  from: Player
  to: Player
  sector: Sector
  timestamp: string
}

export interface CreditsTransferMessage extends TransferMessageBase {
  transfer_details: {
    credits: number
  }
}

export interface WarpTransferMessage extends TransferMessageBase {
  transfer_details: {
    warp_power: number
  }
}

export type CombatActionType = "attack" | "brace" | "flee" | "pay"

export interface CombatParticipantShipSnapshot {
  ship_type: string
  ship_name: string
  shield_integrity: number
  shield_damage: number | null
  fighter_loss: number | null
}

export interface CombatParticipantSnapshot {
  // Some clients still key participants by id; round_waiting may not include this.
  id?: string
  name: string
  created_at: string
  player_type: PlayerType
  ship: CombatParticipantShipSnapshot
}

export interface CombatGarrisonSnapshot {
  id?: string
  name?: string
  owner_name: string
  fighters: number
  shields?: number
  shield_integrity?: number
  fighter_loss: number | null
  mode: "offensive" | "defensive" | "toll"
  toll_amount: number
  deployed_at: string | null
  is_friendly?: boolean
}

export interface CombatRoundActionSnapshot {
  action: CombatActionType
  commit: number
  timed_out: boolean
  submitted_at: string
  target?: string | null
  target_id?: string | null
  destination_sector?: number | null
}

export interface CombatRoundLogMessage {
  round_number: number
  actions: Record<string, CombatRoundActionSnapshot>
  hits: Record<string, number>
  offensive_losses: Record<string, number>
  defensive_losses: Record<string, number>
  shield_loss: Record<string, number>
  result: string | null
  timestamp: string
}

export interface CombatActionAcceptedMessage extends ServerMessagePayload {
  combat_id: string
  round: number
  action: CombatActionType
  commit: number
  target_id: string | null
}

/**
 * @deprecated Legacy alias. Current edge functions emit `combat.action_accepted`.
 */
export interface CombatActionResponseMessage extends CombatActionAcceptedMessage {
  round_resolved?: boolean
}

export interface CombatRoundWaitingMessage extends ServerMessagePayload {
  combat_id: string
  sector: { id: number }
  participants: CombatParticipantSnapshot[]
  garrison?: CombatGarrisonSnapshot | null
  round: number
  deadline: string | null
  current_time: string
  initiator?: string
}

export interface CombatRoundResolvedMessage extends ServerMessagePayload {
  combat_id: string
  sector: { id: number }
  round: number
  hits: Record<string, number>
  offensive_losses: Record<string, number>
  defensive_losses: Record<string, number>
  shield_loss: Record<string, number>
  fighters_remaining: Record<string, number>
  shields_remaining: Record<string, number>
  flee_results: Record<string, boolean>
  actions?: Record<string, CombatRoundActionSnapshot>
  participants: CombatParticipantSnapshot[]
  garrison: CombatGarrisonSnapshot | null
  deadline: string | null
  end: string | null
  result: string | null
  round_result?: string | null
}

export interface CombatEndedShipSnapshot {
  ship_id: string
  ship_type: string
  ship_name: string
  credits: number
  cargo: Record<Resource, number>
  cargo_capacity: number
  empty_holds: number
  warp_power: number
  shields: number
  fighters: number
  max_shields: number
  max_fighters: number
}

export interface CombatEndedMessage extends CombatRoundResolvedMessage {
  salvage: Salvage[]
  logs: CombatRoundLogMessage[]
  ship?: CombatEndedShipSnapshot
}

export interface GarrisonDeployedMessage extends ServerMessagePayload {
  sector: { id: number }
  garrison: CombatGarrisonSnapshot
  fighters_remaining: number
}

export interface GarrisonCollectedMessage extends ServerMessagePayload {
  sector: { id: number }
  credits_collected: number
  garrison: CombatGarrisonSnapshot | null
  fighters_on_ship: number
}

export interface GarrisonModeChangedMessage extends ServerMessagePayload {
  sector: { id: number }
  garrison: CombatGarrisonSnapshot
}

export interface GarrisonCharacterMovedMessage extends CharacterMovedMessage {
  garrison: {
    owner_id: string
    owner_name: string
    corporation_id: string | null
    fighters: number
    mode: "offensive" | "defensive" | "toll"
    toll_amount: number
    deployed_at: string | null
  }
}

export interface ShipDestroyedMessage extends ServerMessagePayload {
  ship_id: string
  ship_type: string
  ship_name: string | null
  player_type: "human" | "corporation_ship"
  player_name: string
  sector: { id: number }
  combat_id: string
  salvage_created: boolean
  timestamp?: string
}

// --- Task History Messages

export interface TaskHistoryMessage extends ServerMessagePayload {
  tasks: TaskHistoryEntry[]
  total_count: number
}

// --- Chat History Messages

export interface ChatHistoryMessage extends ServerMessagePayload {
  messages: ChatMessage[]
  total_count: number
}

export interface ShipsListMessage extends ServerMessagePayload {
  ships: ShipSelf[]
}

// --- Event Query Messages (for task events)

export interface EventQueryEntry {
  __event_id: number
  timestamp: string
  direction: string
  event: string
  payload: Record<string, unknown>
  sender: string | null
  receiver: string | null
  sector: number | null
  corporation_id: string | null
  task_id: string | null
  meta: Record<string, unknown> | null
}

export interface EventQueryMessage extends ServerMessagePayload {
  events: EventQueryEntry[]
  count: number
  has_more: boolean
  next_cursor: number | null
  scope: "personal" | "corporation"
}

export interface CorporationCreatedMessage extends ServerMessagePayload {
  name: string
  corp_id: string
  timestamp: string
  founder_id: string
  invite_code: string
  member_count: number
}

export interface CorporationDisbandedMessage extends ServerMessagePayload {
  reason: string
  corp_id: string
  corp_name: string
  timestamp?: string
}

export interface CorporationShipPurchaseMessage extends ServerMessagePayload {
  sector: number
  corp_id: string
  ship_id: string
  buyer_id: string
  corp_name: string
  ship_name: string
  ship_type: string
  timestamp: string
  buyer_name: string
  purchase_price: number
}

export interface LLMTaskMessage extends ServerMessagePayload {
  name: string
}
