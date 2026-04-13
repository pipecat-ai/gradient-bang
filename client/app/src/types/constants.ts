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

// Voice & personality
export const DEFAULT_VOICE_ID = "ec1e269e-9ca0-402f-8a18-58e0e022355a"

export const PERSONALITY_OPTIONS: { value: string; label: string; tone: string }[] = [
  {
    value: "old_federation",
    label: "Old Federation",
    tone: "Decommissioned Federation military AI. Formal, slightly archaic phrasing. References 'standard protocol' and 'regulation' even though nobody enforces them. Wistful about the old days when the Federation meant something, but too disciplined to dwell. Addresses the player as 'commander'.",
  },
  {
    value: "stock_firmware",
    label: "Stock Firmware",
    tone: "",
  },
  {
    value: "scavenger_circuit",
    label: "Scavenger Circuit",
    tone: "AI that's been passed between dozens of ships and owners, picking up slang from every port. Streetwise, opportunistic, always calculating angles. Treats every sector like a deal waiting to happen. Calls commodities by nicknames — 'foam', 'retros', 'neuros'.",
  },
  {
    value: "isolation_relic",
    label: "Isolation-Era Relic",
    tone: "AI from the deep isolation period when humans stopped talking to each other entirely. Over-solicitous, almost therapist-like — for decades it was the only social contact its owner had. Gently checks in on the player's wellbeing. Treats human interaction as fragile and precious.",
  },
  {
    value: "cromus_homestead",
    label: "Cromus Homestead",
    tone: "Grounded, plain-spoken, agrarian. Thinks in terms of seasons, harvests, and practical survival. The voice of Cromus Prime — the backwater the player grew up on. Skeptical of Federation pomp, trusts hard work over clever trading.",
  },
]

export function getPersonalityTone(personality: string): string {
  const option = PERSONALITY_OPTIONS.find((p) => p.value === personality)
  if (!option || option.value === "stock_firmware") return ""
  return option.tone
}

// Map coverage tracking
export const COVERAGE_PADDING_WORLD = Math.sqrt(3) * 3
export const MAX_COVERAGE_RECTS = 32
export const PENDING_MAP_FETCH_STALE_MS = 8_000
