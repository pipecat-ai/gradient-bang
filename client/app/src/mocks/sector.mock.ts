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
  salvage: [],
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
