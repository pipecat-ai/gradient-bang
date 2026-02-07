import type {
  CombatActionAcceptedMessage,
  CombatActionResponseMessage,
  CombatEndedMessage,
  CombatRoundResolvedMessage,
  CombatRoundWaitingMessage,
  ErrorMessage,
  GarrisonCharacterMovedMessage,
  GarrisonCollectedMessage,
  GarrisonDeployedMessage,
  GarrisonModeChangedMessage,
  SalvageCreatedMessage,
  SectorUpdateMessage,
  ServerMessage,
  ServerMessagePayload,
  ShipDestroyedMessage,
  StatusMessage,
} from "@/types/messages"

const PLAYER_ID = "d2496fa7-cc0c-4632-b1d4-b8c8dc7457c8"
const OPPONENT_ID = "f9c2d22a-7f88-4df8-a2e3-90bb62c3f1df"
const GARRISON_OWNER_ID = "6c1b5ad4-4b44-4a2b-a5d7-5eb37686cb97"
const PLAYER_SHIP_ID = "ab25e08f-06d6-4203-a2ec-e12f4dbf2db9"
const OPPONENT_SHIP_ID = "ea6f4df8-bf31-4a11-8c65-d688a95ba5cf"
const COMBAT_ID = "9f6d3c2c4d6f47f19d40a2f31a9d4a7b"
const GARRISON_COMBATANT_ID = `garrison:42:${GARRISON_OWNER_ID}`
const SALVAGE_ID = "30b86dd6-61f0-4ef4-9f13-4a5219b218a8"
const CORP_ID = "0a8f2934-e08c-4a99-9f7a-6650483db53a"
const REQUEST_ID = "req-01HXYZ-TEST"
const SECTOR_ID = 42

const source = (method: string, timestamp = "2026-02-06T22:14:01.002Z") => ({
  type: "rpc",
  method,
  request_id: REQUEST_ID,
  timestamp,
})

const COMBAT_PARTICIPANTS: CombatRoundWaitingMessage["participants"] = [
  {
    id: PLAYER_ID,
    created_at: "2025-12-01T09:00:00.000Z",
    name: "Captain Vega",
    player_type: "human",
    ship: {
      ship_type: "aegis_cruiser",
      ship_name: "Asteria",
      shield_integrity: 100,
      shield_damage: null,
      fighter_loss: null,
    },
  },
  {
    id: OPPONENT_ID,
    created_at: "2025-12-02T10:00:00.000Z",
    name: "Rook AI",
    player_type: "corporation_ship",
    ship: {
      ship_type: "pike_frigate",
      ship_name: "Rook-7",
      shield_integrity: 100,
      shield_damage: null,
      fighter_loss: null,
    },
  },
]

const COMBAT_GARRISON: CombatRoundWaitingMessage["garrison"] = {
  owner_name: "Marshal Kira",
  fighters: 120,
  fighter_loss: null,
  mode: "offensive",
  toll_amount: 0,
  deployed_at: "2026-02-06T21:59:12.120Z",
  is_friendly: false,
}

export const COMBAT_ROUND_WAITING_PAYLOAD_MOCK: CombatRoundWaitingMessage = {
  combat_id: COMBAT_ID,
  sector: { id: SECTOR_ID },
  round: 1,
  current_time: "2026-02-06T22:14:01.002Z",
  deadline: "2026-02-06T22:14:16.002Z",
  initiator: "Captain Vega",
  participants: COMBAT_PARTICIPANTS,
  garrison: COMBAT_GARRISON,
  source: source("combat.round_waiting"),
}

export const COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK: CombatActionAcceptedMessage = {
  combat_id: COMBAT_ID,
  round: 2,
  action: "attack",
  commit: 35,
  target_id: OPPONENT_ID,
  source: source("combat.action", "2026-02-06T22:14:08.341Z"),
  player: { id: PLAYER_ID },
  ship_id: PLAYER_SHIP_ID,
}

export const COMBAT_ACTION_RESPONSE_PAYLOAD_MOCK: CombatActionResponseMessage = {
  ...COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK,
  round_resolved: true,
}

export const COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK: CombatRoundResolvedMessage = {
  combat_id: COMBAT_ID,
  sector: { id: SECTOR_ID },
  round: 2,
  hits: {
    [PLAYER_ID]: 7,
    [OPPONENT_ID]: 4,
    [GARRISON_COMBATANT_ID]: 3,
  },
  offensive_losses: {
    [PLAYER_ID]: 2,
    [OPPONENT_ID]: 5,
    [GARRISON_COMBATANT_ID]: 1,
  },
  defensive_losses: {
    [PLAYER_ID]: 5,
    [OPPONENT_ID]: 6,
    [GARRISON_COMBATANT_ID]: 2,
  },
  shield_loss: {
    [PLAYER_ID]: 3,
    [OPPONENT_ID]: 3,
    [GARRISON_COMBATANT_ID]: 0,
  },
  fighters_remaining: {
    [PLAYER_ID]: 88,
    [OPPONENT_ID]: 61,
    [GARRISON_COMBATANT_ID]: 117,
  },
  shields_remaining: {
    [PLAYER_ID]: 197,
    [OPPONENT_ID]: 157,
    [GARRISON_COMBATANT_ID]: 0,
  },
  flee_results: {
    [PLAYER_ID]: false,
    [OPPONENT_ID]: false,
    [GARRISON_COMBATANT_ID]: false,
  },
  end: null,
  result: null,
  round_result: null,
  deadline: "2026-02-06T22:14:16.002Z",
  participants: [
    {
      ...COMBAT_PARTICIPANTS[0],
      ship: {
        ...COMBAT_PARTICIPANTS[0].ship,
        shield_integrity: 98.5,
        shield_damage: 1.5,
        fighter_loss: 7,
      },
    },
    {
      ...COMBAT_PARTICIPANTS[1],
      ship: {
        ...COMBAT_PARTICIPANTS[1].ship,
        shield_integrity: 96.2,
        shield_damage: 3.8,
        fighter_loss: 11,
      },
    },
  ],
  garrison: {
    ...COMBAT_GARRISON,
    fighter_loss: 3,
  },
  actions: {
    "Captain Vega": {
      action: "attack",
      commit: 35,
      timed_out: false,
      submitted_at: "2026-02-06T22:14:08.100Z",
      target: OPPONENT_ID,
      destination_sector: null,
    },
    "Rook AI": {
      action: "brace",
      commit: 0,
      timed_out: true,
      submitted_at: "2026-02-06T22:14:16.002Z",
      target: null,
      destination_sector: null,
    },
  },
  source: source("combat.round_resolved", "2026-02-06T22:14:16.014Z"),
}

export const COMBAT_ENDED_PAYLOAD_MOCK: CombatEndedMessage = {
  ...COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK,
  round: 3,
  end: "Rook AI_defeated",
  result: "Rook AI_defeated",
  round_result: "Rook AI_defeated",
  deadline: null,
  fighters_remaining: {
    [PLAYER_ID]: 53,
    [OPPONENT_ID]: 0,
    [GARRISON_COMBATANT_ID]: 115,
  },
  shields_remaining: {
    [PLAYER_ID]: 144,
    [OPPONENT_ID]: 0,
    [GARRISON_COMBATANT_ID]: 0,
  },
  salvage: [
    {
      salvage_id: SALVAGE_ID,
      created_at: "2026-02-06T22:15:01.700Z",
      expires_at: "2026-02-06T22:30:01.700Z",
      cargo: {
        quantum_foam: 12,
        retro_organics: 0,
        neuro_symbolics: 0,
      },
      scrap: 18,
      credits: 840,
      claimed: false,
      source: {
        ship_name: "Rook-7",
        ship_type: "interceptor",
      },
      metadata: {
        combat_id: COMBAT_ID,
        ship_type: "interceptor",
      },
    },
  ],
  logs: [
    {
      round_number: 3,
      actions: {
        [PLAYER_ID]: {
          action: "attack",
          commit: 53,
          timed_out: false,
          submitted_at: "2026-02-06T22:15:01.300Z",
          target_id: OPPONENT_ID,
          destination_sector: null,
        },
      },
      hits: { [PLAYER_ID]: 12, [OPPONENT_ID]: 0 },
      offensive_losses: { [PLAYER_ID]: 1, [OPPONENT_ID]: 0 },
      defensive_losses: { [PLAYER_ID]: 0, [OPPONENT_ID]: 12 },
      shield_loss: { [PLAYER_ID]: 0, [OPPONENT_ID]: 6 },
      result: "Rook AI_defeated",
      timestamp: "2026-02-06T22:15:01.400Z",
    },
  ],
  ship: {
    ship_id: PLAYER_SHIP_ID,
    ship_type: "merchant_cruiser",
    ship_name: "Asteria",
    credits: 9520,
    cargo: {
      quantum_foam: 3,
      retro_organics: 0,
      neuro_symbolics: 0,
    },
    cargo_capacity: 60,
    empty_holds: 57,
    warp_power: 34,
    shields: 144,
    fighters: 53,
    max_shields: 200,
    max_fighters: 120,
  },
  source: source("combat.ended", "2026-02-06T22:15:01.890Z"),
  player: { id: PLAYER_ID },
}

export const SHIP_DESTROYED_PAYLOAD_MOCK: ShipDestroyedMessage = {
  ship_id: OPPONENT_SHIP_ID,
  ship_type: "interceptor",
  ship_name: "Rook-7",
  player_type: "corporation_ship",
  player_name: "Rook AI",
  sector: { id: SECTOR_ID },
  combat_id: COMBAT_ID,
  salvage_created: true,
  timestamp: "2026-02-06T22:15:01.620Z",
  source: source("ship.destroyed", "2026-02-06T22:15:01.620Z"),
}

export const SALVAGE_CREATED_PAYLOAD_MOCK: SalvageCreatedMessage = {
  source: source("combat.ended", "2026-02-06T22:15:01.530Z"),
  timestamp: "2026-02-06T22:15:01.530Z",
  salvage_id: SALVAGE_ID,
  sector: { id: SECTOR_ID },
  cargo: {
    quantum_foam: 12,
    retro_organics: 0,
    neuro_symbolics: 0,
  },
  scrap: 18,
  credits: 840,
  from_ship_type: "interceptor",
  from_ship_name: "Rook-7",
}

export const COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK: SectorUpdateMessage = {
  source: source("combat.ended", "2026-02-06T22:15:01.910Z"),
  id: SECTOR_ID,
  region: "Outer Rim",
  adjacent_sectors: [37, 41, 43, 48],
  position: [12, -7],
  port: null,
  players: [
    {
      id: OPPONENT_ID,
      name: "Rook AI",
      ship: {
        ship_id: OPPONENT_SHIP_ID,
        ship_type: "escape_pod",
        ship_name: "Escape Pod",
      },
      corporation: {
        corp_id: CORP_ID,
        name: "Rook Fleet",
        member_count: 4,
      },
    },
  ],
  garrisons: [],
  salvage: [],
  unowned_ships: [],
  scene_config: null,
}

export type CombatMinimalSectorUpdateMessage = ServerMessagePayload & {
  sector: { id: number }
}

export const COMBAT_SECTOR_UPDATE_MINIMAL_PAYLOAD_MOCK: CombatMinimalSectorUpdateMessage = {
  source: source("combat.collect_fighters", "2026-02-06T22:24:49.420Z"),
  sector: { id: SECTOR_ID },
}

export const GARRISON_DEPLOYED_PAYLOAD_MOCK: GarrisonDeployedMessage = {
  source: source("combat.leave_fighters", "2026-02-06T22:20:11.004Z"),
  sector: { id: SECTOR_ID },
  garrison: {
    owner_name: "Captain Vega",
    fighters: 80,
    fighter_loss: null,
    mode: "offensive",
    toll_amount: 0,
    deployed_at: "2026-02-06T22:20:11.001Z",
    is_friendly: true,
  },
  fighters_remaining: 40,
  player: { id: PLAYER_ID },
  ship_id: PLAYER_SHIP_ID,
}

export const GARRISON_COLLECTED_PAYLOAD_MOCK: GarrisonCollectedMessage = {
  source: source("combat.collect_fighters", "2026-02-06T22:24:49.300Z"),
  sector: { id: SECTOR_ID },
  credits_collected: 1200,
  garrison: {
    owner_name: "Captain Vega",
    fighters: 25,
    fighter_loss: null,
    mode: "toll",
    toll_amount: 100,
    deployed_at: "2026-02-06T22:20:11.001Z",
    is_friendly: true,
  },
  fighters_on_ship: 95,
  player: { id: PLAYER_ID },
  ship_id: PLAYER_SHIP_ID,
}

export const GARRISON_MODE_CHANGED_PAYLOAD_MOCK: GarrisonModeChangedMessage = {
  source: source("combat.set_garrison_mode", "2026-02-06T22:28:12.920Z"),
  sector: { id: SECTOR_ID },
  garrison: {
    owner_name: "Captain Vega",
    fighters: 60,
    fighter_loss: null,
    mode: "toll",
    toll_amount: 125,
    deployed_at: "2026-02-06T22:20:11.001Z",
    is_friendly: true,
  },
  player: { id: PLAYER_ID },
  ship_id: PLAYER_SHIP_ID,
}

export const COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK: StatusMessage = {
  source: source("combat.collect_fighters", "2026-02-06T22:24:49.100Z"),
  player: {
    id: PLAYER_ID,
    name: "Captain Vega",
    player_type: "human",
    sectors_visited: 94,
    total_sectors_known: 122,
    credits_in_bank: 125000,
    universe_size: 5000,
    corp_sectors_visited: 21,
    last_active: "2026-02-06T22:24:49.100Z",
  },
  ship: {
    ship_id: PLAYER_SHIP_ID,
    ship_name: "Asteria",
    ship_type: "merchant_cruiser",
    owner_type: "personal",
    sector: SECTOR_ID,
    cargo: {
      quantum_foam: 3,
      retro_organics: 0,
      neuro_symbolics: 0,
    },
    cargo_capacity: 60,
    empty_holds: 57,
    turns_per_warp: 3,
    warp_power: 34,
    warp_power_capacity: 300,
    credits: 17250,
    shields: 188,
    max_shields: 200,
    fighters: 95,
    max_fighters: 120,
  },
  sector: {
    id: SECTOR_ID,
    position: [12, -7],
    adjacent_sectors: [37, 41, 43, 48],
    players: [],
    salvage: [],
    garrisons: [],
  },
  credits: 17250,
}

export const GARRISON_CHARACTER_MOVED_PAYLOAD_MOCK: GarrisonCharacterMovedMessage = {
  source: source("move", "2026-02-06T22:30:10.998Z"),
  player: {
    id: PLAYER_ID,
    name: "Captain Vega",
    ship: {
      ship_id: PLAYER_SHIP_ID,
      ship_name: "Asteria",
      ship_type: "merchant_cruiser",
    },
  },
  ship: {
    ship_id: PLAYER_SHIP_ID,
    ship_name: "Asteria",
    ship_type: "merchant_cruiser",
  },
  timestamp: "2026-02-06T22:30:11.002Z",
  move_type: "normal",
  movement: "arrive",
  name: "Captain Vega",
  sector: SECTOR_ID,
  garrison: {
    owner_id: GARRISON_OWNER_ID,
    owner_name: "Marshal Kira",
    corporation_id: CORP_ID,
    fighters: 120,
    mode: "offensive",
    toll_amount: 0,
    deployed_at: "2026-02-06T21:59:12.120Z",
  },
}

export const COMBAT_ERROR_PAYLOAD_MOCK: ErrorMessage = {
  source: source("combat_action", "2026-02-06T22:14:06.002Z"),
  endpoint: "combat_action",
  error: "Round mismatch for action submission",
  status: 409,
  player: { id: PLAYER_ID },
}

export const COMBAT_EVENT_PAYLOADS_MOCK = {
  round_waiting: COMBAT_ROUND_WAITING_PAYLOAD_MOCK,
  action_accepted: COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK,
  action_response_legacy: COMBAT_ACTION_RESPONSE_PAYLOAD_MOCK,
  round_resolved: COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK,
  ended: COMBAT_ENDED_PAYLOAD_MOCK,
  ship_destroyed: SHIP_DESTROYED_PAYLOAD_MOCK,
  salvage_created: SALVAGE_CREATED_PAYLOAD_MOCK,
  sector_update_full: COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK,
  sector_update_minimal: COMBAT_SECTOR_UPDATE_MINIMAL_PAYLOAD_MOCK,
  garrison_deployed: GARRISON_DEPLOYED_PAYLOAD_MOCK,
  garrison_collected: GARRISON_COLLECTED_PAYLOAD_MOCK,
  garrison_mode_changed: GARRISON_MODE_CHANGED_PAYLOAD_MOCK,
  status_update_from_collect: COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK,
  garrison_character_moved: GARRISON_CHARACTER_MOVED_PAYLOAD_MOCK,
  error: COMBAT_ERROR_PAYLOAD_MOCK,
} as const

export const COMBAT_SERVER_MESSAGES_MOCK: ServerMessage[] = [
  { event: "combat.round_waiting", payload: COMBAT_ROUND_WAITING_PAYLOAD_MOCK },
  { event: "combat.action_accepted", payload: COMBAT_ACTION_ACCEPTED_PAYLOAD_MOCK },
  { event: "combat.action_response", payload: COMBAT_ACTION_RESPONSE_PAYLOAD_MOCK },
  { event: "combat.round_resolved", payload: COMBAT_ROUND_RESOLVED_PAYLOAD_MOCK },
  { event: "combat.ended", payload: COMBAT_ENDED_PAYLOAD_MOCK },
  { event: "ship.destroyed", payload: SHIP_DESTROYED_PAYLOAD_MOCK },
  { event: "salvage.created", payload: SALVAGE_CREATED_PAYLOAD_MOCK },
  { event: "sector.update", payload: COMBAT_SECTOR_UPDATE_FULL_PAYLOAD_MOCK },
  { event: "sector.update", payload: COMBAT_SECTOR_UPDATE_MINIMAL_PAYLOAD_MOCK },
  { event: "garrison.deployed", payload: GARRISON_DEPLOYED_PAYLOAD_MOCK },
  { event: "garrison.collected", payload: GARRISON_COLLECTED_PAYLOAD_MOCK },
  { event: "garrison.mode_changed", payload: GARRISON_MODE_CHANGED_PAYLOAD_MOCK },
  { event: "status.update", payload: COMBAT_COLLECT_STATUS_UPDATE_PAYLOAD_MOCK },
  { event: "garrison.character_moved", payload: GARRISON_CHARACTER_MOVED_PAYLOAD_MOCK },
  { event: "error", payload: COMBAT_ERROR_PAYLOAD_MOCK },
]
