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
  corporation_ship: "Autonomous",
} as const satisfies Record<PlayerType, string>
