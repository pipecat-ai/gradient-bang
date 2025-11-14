export const RESOURCE_SHORT_NAMES = {
  neuro_symbolics: "NS",
  quantum_foam: "QF",
  retro_organics: "RO",
} as const satisfies Record<Resource, string>;

export const RESOURCE_VERBOSE_NAMES = {
  neuro_symbolics: "Neuro Symbolics",
  quantum_foam: "Quantum Foam",
  retro_organics: "Retro Organics",
} as const satisfies Record<Resource, string>;
