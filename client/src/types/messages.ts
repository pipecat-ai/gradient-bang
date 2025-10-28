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

export interface WarpTransferMessage extends ServerMessagePayload {
  from_character_id: string;
  to_character_id: string;
  sector: Sector;
  units: number;
  timestamp: string;
  from_warp_power_remaining: number;
  to_warp_power_current: number;
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
  sector: Sector;
  salvage: Salvage;
  dumped_cargo?: Record<Resource, number>;
}

export interface SalvageCollectedMessage extends ServerMessagePayload {
  sector: Sector;
  salvage: Salvage;
  collected: {
    cargo: Record<Resource, number>;
    credits: number;
  };
  salvage_removed: boolean;
  cargo_after: Record<Resource, number>;
  credits_after: number;
}

export interface CreditsTransferMessage extends ServerMessagePayload {
  from_character_id: string;
  to_character_id: string;
  sector: Sector;
  amount: number;
  timestamp: string;
  from_balance_before: number;
  from_balance_after: number;
  to_balance_before: number;
  to_balance_after: number;
}
