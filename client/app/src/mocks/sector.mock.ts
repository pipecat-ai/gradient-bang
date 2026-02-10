import { faker } from "@faker-js/faker"

import type { CharacterMovedMessage } from "@/types/messages"
import { SHIP_DEFINITIONS } from "@/types/ships"

const PLAYER_TYPES: PlayerType[] = ["human", "npc", "corporation_ship"]

const CORP_NAME_PREFIXES = [
  "Stellar", "Quantum", "Nova", "Apex", "Void",
  "Nebula", "Crimson", "Shadow", "Iron", "Obsidian",
]
const CORP_NAME_SUFFIXES = [
  "Industries", "Syndicate", "Collective", "Corp", "Alliance",
  "Trading Co.", "Enterprises", "Holdings", "Group", "Federation",
]

export function createRandomCorporation(): Corporation {
  const prefix = faker.helpers.arrayElement(CORP_NAME_PREFIXES)
  const suffix = faker.helpers.arrayElement(CORP_NAME_SUFFIXES)
  return {
    corp_id: faker.string.uuid(),
    name: `${prefix} ${suffix}`,
    member_count: faker.number.int({ min: 1, max: 50 }),
    joined_at: faker.date.recent({ days: 30 }).toISOString(),
  }
}

function pickRandomShipDef() {
  return faker.helpers.arrayElement(SHIP_DEFINITIONS)
}

export function createRandomPlayer(): Player {
  const playerType = faker.helpers.arrayElement(PLAYER_TYPES)
  const id = faker.string.uuid()
  const shipDef = pickRandomShipDef()
  const name =
    playerType === "corporation_ship"
      ? `Corp Ship [${id.slice(0, 6)}]`
      : faker.person.fullName()

  // Corp ships always have a corporation, humans sometimes do, NPCs never
  const hasCorp =
    playerType === "corporation_ship"
      ? true
      : playerType === "human"
        ? faker.datatype.boolean()
        : false

  return {
    id,
    name,
    player_type: playerType,
    corporation: hasCorp ? createRandomCorporation() : undefined,
    ship: {
      ship_id: faker.string.uuid(),
      ship_name: shipDef.display_name,
      ship_type: shipDef.ship_type,
      fighters: faker.number.int({ min: 0, max: shipDef.fighters }),
      shields: faker.number.int({ min: 0, max: shipDef.shields }),
      owner_type:
        playerType === "corporation_ship"
          ? "corporation"
          : playerType === "npc"
            ? "personal"
            : "personal",
    },
  }
}

export function createRandomUnownedShip(): ShipUnowned {
  const shipDef = pickRandomShipDef()
  return {
    ship_id: faker.string.uuid(),
    ship_name: shipDef.display_name,
    ship_type: shipDef.ship_type,
    fighters: faker.number.int({ min: 0, max: shipDef.fighters }),
    shields: faker.number.int({ min: 0, max: shipDef.shields }),
    owner_type: "unowned",
    became_unowned: faker.date.recent({ days: 7 }).toISOString(),
    former_owner_name: faker.person.fullName(),
    cargo: {
      quantum_foam: faker.number.int({ min: 0, max: 50 }),
      retro_organics: faker.number.int({ min: 0, max: 50 }),
      neuro_symbolics: faker.number.int({ min: 0, max: 50 }),
    },
  }
}

export const SECTOR_MOCK: Sector = {
  id: 1,
  position: [0, 0],
  planets: [],
  port: undefined,
  players: [],
  garrisons: [],
  salvage: [],
}
export const SECTOR_FULL_MOCK: Sector = {
  id: 1611,
  region: "Federation Space",
  port: {
    code: "SSS",
    observed_at: "2026-02-03T20:00:00.010227+00:00",
    stock: {
      quantum_foam: 100000,
      retro_organics: 100000,
      neuro_symbolics: 100000,
    },
    prices: {
      quantum_foam: 19,
      retro_organics: 8,
      neuro_symbolics: 30,
    },
    port_class: 7,
  },
  players: [
    {
      id: "aff49e24-9051-45ce-aebd-b7f830c13a25",
      name: "Corp Ship [aff49e]",
      ship: {
        ship_id: "aff49e24-9051-45ce-aebd-b7f830c13a25",
        ship_name: "Pirate Probe 2",
        ship_type: "autonomous_probe",
        owner_type: "corporation",
      },
    },
    {
      id: "5dd14b09-22b6-483d-a312-78d0e6a31fa6",
      name: "Corp Ship [5dd14b]",
      ship: {
        ship_id: "5dd14b09-22b6-483d-a312-78d0e6a31fa6",
        ship_name: "Pirate Probe 3",
        ship_type: "autonomous_probe",
        owner_type: "corporation",
      },
    },
    {
      id: "d5244788-314b-40c9-8aa5-00c82c02f351",
      name: "Corp Ship [d52447]",
      ship: {
        ship_id: "d5244788-314b-40c9-8aa5-00c82c02f351",
        ship_name: "Autonomous Probe",
        ship_type: "autonomous_probe",
        owner_type: "corporation",
      },
    },
    {
      id: "d7499f1a-e1e1-45b9-ac6e-f9a2a10c88db",
      name: "Mal Reynolds",
      ship: {
        ship_id: "6f0a9445-a69b-4490-af5b-b2fcb5679924",
        ship_name: "Kestrel Courier",
        ship_type: "kestrel_courier",
        owner_type: "personal",
      },
    },
  ],
  salvage: [
    {
      cargo: {
        quantum_foam: 0,
        retro_organics: 1,
        neuro_symbolics: 0,
      },
      scrap: 0,
      source: {
        ship_name: "Destroy The Things",
        ship_type: "bulwark_destroyer",
      },
      claimed: false,
      credits: 0,
      metadata: {},
      created_at: "2026-02-03T23:02:00.981Z",
      expires_at: "2026-02-03T23:17:00.981Z",
      salvage_id: "fd06dfb3-9d79-432d-b0f7-4b886759dc47",
    },
  ],
  garrisons: [],
  position: [94, 171],
  scene_config: null,
  unowned_ships: [
    {
      cargo: {
        quantum_foam: 0,
        retro_organics: 0,
        neuro_symbolics: 0,
      },
      shields: 150,
      ship_id: "3b93bdc5-bd45-4716-97f0-859243e11096",
      ship_name: "Test Unowned Ship I",
      ship_type: "kestrel",
      fighters: 300,
      owner_type: "unowned",
      became_unowned: "2026-01-28T20:13:25.744+00:00",
      former_owner_name: "Trader Jon",
    },
    {
      cargo: {
        quantum_foam: 0,
        retro_organics: 0,
        neuro_symbolics: 0,
      },
      shields: 150,
      ship_id: "0f113a3b-c767-43c9-b0a6-586b9fdf73d7",
      ship_name: "Test Unowned Ship II",
      ship_type: "kestrel",
      fighters: 300,
      owner_type: "unowned",
      became_unowned: "2026-01-28T20:30:28.121+00:00",
      former_owner_name: "Trader Jon",
    },
  ],
  adjacent_sectors: [1928, 2058],
}

export const PORT_MOCK: Port = {
  code: "BBS",
  observed_at: "2026-01-28T12:00:00.000Z",
  stock: {
    quantum_foam: 100000,
    retro_organics: 100000,
    neuro_symbolics: 100000,
  },
  prices: {
    quantum_foam: 100,
    retro_organics: 100,
    neuro_symbolics: 100,
  },
}

export const MEGA_PORT_MOCK: Port = {
  code: "SSS",
  mega: true,
  observed_at: "2026-01-28T12:00:00.000Z",
  stock: {
    quantum_foam: 100000,
    retro_organics: 100000,
    neuro_symbolics: 100000,
  },
  prices: {
    quantum_foam: 100,
    retro_organics: 100,
    neuro_symbolics: 100,
  },
}

export const PLAYER_MOVEMENT_HISTORY_MOCK: CharacterMovedMessage = {
  name: "Corp Ship [f1b613]",
  ship: {
    ship_id: "f1b61393-5975-43dd-83ba-9bf042fcf465",
    ship_name: "Pirate Probe 1",
    ship_type: "autonomous_probe",
  },
  player: {
    id: "f1b61393-5975-43dd-83ba-9bf042fcf465",
    name: "Corp Ship [f1b613]",
  },
  sector: 1611,

  movement: "arrive",
  move_type: "normal",
  timestamp: "2026-02-03T23:20:43.006Z",
}
