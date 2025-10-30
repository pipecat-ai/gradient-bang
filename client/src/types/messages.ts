export interface ServerMessage {
  event: string;
  payload: ServerMessagePayload;
  summary?: string;
  tool_name?: string;
}

export interface ServerMessagePayload {
  source?: {
    method: string;
    request_id: string;
    timestamp: string;
    type: string;
  };
  [key: string]: unknown;
}

export interface ErrorMessage extends ServerMessagePayload {
  error: string;
  endpoint?: string;
}

export interface TaskOutputMessage extends ServerMessagePayload {
  text: string;
  task_message_type:
    | "STEP"
    | "ACTION"
    | "EVENT"
    | "MESSAGE"
    | "ERROR"
    | "FINISHED";
}

export interface IncomingChatMessage
  extends ServerMessagePayload,
    ChatMessage {}

export interface StatusMessage extends ServerMessagePayload {
  player: PlayerSelf;
  ship: ShipSelf;
  sector: Sector;
}

export interface MovementStartMessage extends ServerMessagePayload {
  sector: Sector;
  hyperspace_time: number;
}

export interface MovementCompleteMessage extends ServerMessagePayload {
  ship: ShipSelf;
  player: PlayerSelf;
}

export interface MapLocalMessage extends ServerMessagePayload {
  sectors: MapData;
  center_sector: number;
  total_sectors: number;
  total_unvisited: number;
  total_visited: number;
}

export interface CoursePlotMessage extends ServerMessagePayload {
  from_sector: number;
  to_sector: number;
  path: number[];
  distance: number;
}

export interface WarpPurchaseMessage extends ServerMessagePayload {
  character_id: string;
  sector: Sector;
  units: number;
  price_per_unit: number;
  total_cost: number;
  timestamp: string;
  new_warp_power: number;
  warp_power_capacity: number;
  new_credits: number;
}

export interface PortUpdateMessage extends ServerMessagePayload {
  sector: Sector;
}

export interface CharacterMovedMessage extends ServerMessagePayload {
  name: string;
  ship_type: string;
  timestamp: string;
  move_type: string;
  movement?: "depart" | "arrive";
  player_type?: "npc" | "human";
}

export interface KnownPortListMessage extends ServerMessagePayload {
  from_sector: number;
  ports: Port[];
  total_ports_found: number;
  searched_sectors: number;
}

export interface BankTransactionMessage extends ServerMessagePayload {
  character_id: string;
  sector: Sector;
  direction: "deposit" | "withdraw";
  amount: number;
  timestamp: string;
  credits_on_hand_before: number;
  credits_on_hand_after: number;
  credits_in_bank_before: number;
  credits_in_bank_after: number;
}

export interface SectorUpdateMessage extends ServerMessagePayload, Sector {}

export interface SalvageCreatedMessage extends ServerMessagePayload {
  action?: string;
  sector: Sector;
  salvage_details: Salvage;
  dumped_cargo?: Record<Resource, number>;
}

export interface SalvageCollectedMessage extends ServerMessagePayload {
  sector: Sector;
  salvage_details: Salvage;
  timestamp: string;
}

export interface TransferMessageBase extends ServerMessagePayload {
  transfer_direction: "received" | "sent";
  from: Player;
  to: Player;
  sector: Sector;
  timestamp: string;
}

export interface CreditsTransferMessage extends TransferMessageBase {
  transfer_details: {
    credits: number;
  };
}

export interface WarpTransferMessage extends TransferMessageBase {
  transfer_details: {
    warp_power: number;
  };
}

export interface CombatActionResponseMessage extends ServerMessagePayload {
  combat_id: string;
  round: number;
  action: "attack" | "brace" | "flee";
  round_resolved: boolean;
  target_id: string;
}

export interface CombatRoundWaitingMessage extends ServerMessagePayload {
  combat_id: string;
  sector: Sector;
  participants: Player[];
  round: number;
  deadline: string;
  current_time: string;
  initiator?: string;
}

export interface CombatRoundResolvedMessage
  extends ServerMessagePayload,
    CombatRound {}
