export const SECTOR_MOCK: Sector = {
  id: 1,
  position: [0, 0],
  planets: [],
  port: undefined,
  players: [],
  garrisons: [],
  salvage: [],
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
