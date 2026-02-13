export const RESOURCE_SHORT_NAMES = {
  quantum_foam: "QF",
  retro_organics: "RO",
  neuro_symbolics: "NS",
} as const satisfies Record<Resource, string>

export const RESOURCE_VERBOSE_NAMES = {
  quantum_foam: "Quantum Foam",
  retro_organics: "Retro Organics",
  neuro_symbolics: "Neuro Symbolics",
} as const satisfies Record<Resource, string>

export const PLAYER_TYPE_NAMES = {
  human: "Human",
  npc: "NPC",
  corporation_ship: "Corporation Ship",
} as const satisfies Record<PlayerType, string>

// Map bounds & zoom
export const DEFAULT_MAX_BOUNDS = 12
export const MAX_BOUNDS_PADDING = 0
export const MIN_BOUNDS = 4
export const MAX_BOUNDS = 50
export const MAX_FETCH_BOUNDS = 100
export const FETCH_BOUNDS_MULTIPLIER = 2
