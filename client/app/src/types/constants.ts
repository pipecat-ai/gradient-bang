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
