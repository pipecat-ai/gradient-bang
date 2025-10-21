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
