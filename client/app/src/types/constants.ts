// Leaderboard ranking keys
export const LEADERBOARD_CATEGORY_KEYS: Record<LeaderboardCategory, string> = {
  wealth: "total_wealth",
  trading: "total_trade_volume",
  exploration: "sectors_visited",
  territory: "territory_control_percentage",
}
export const LEADERBOARD_CATEGORY_LABELS: Record<LeaderboardCategory, string> = {
  wealth: "Wealth",
  trading: "Trading",
  exploration: "Exploration",
  territory: "Territory",
}

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

// UI panels
export const UI_PANELS = [
  "sector",
  "player",
  "trade",
  "task_history",
  "contracts",
  "logs",
  "task_stream",
] as const

// Map bounds & zoom
export const DEFAULT_MAX_BOUNDS = 10
export const MAX_BOUNDS_PADDING = 0
export const MIN_BOUNDS = 4
export const MAX_BOUNDS = 50
export const MAX_FETCH_BOUNDS = 100
export const FETCH_BOUNDS_MULTIPLIER = 2

// Map coverage tracking
export const COVERAGE_PADDING_WORLD = Math.sqrt(3)
export const MAX_COVERAGE_RECTS = 32
export const PENDING_MAP_FETCH_STALE_MS = 8_000
