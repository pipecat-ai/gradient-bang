// Branded ID types — compile-time safety, zero runtime cost.
export type CharacterId = string & { readonly __brand: "CharacterId" }
export type ShipId = string & { readonly __brand: "ShipId" }
export type CorpId = string & { readonly __brand: "CorpId" }
export type GarrisonId = string & { readonly __brand: "GarrisonId" }
export type CombatId = string & { readonly __brand: "CombatId" }
export type SectorId = number

export const characterId = (s: string): CharacterId => s as CharacterId
export const shipId = (s: string): ShipId => s as ShipId
export const corpId = (s: string): CorpId => s as CorpId
export const garrisonId = (s: string): GarrisonId => s as GarrisonId
export const combatId = (s: string): CombatId => s as CombatId

export type EntityId = CharacterId | ShipId | GarrisonId | CorpId

// ---- Harness world types (camelCase; mirror SELECT-like snapshots) ----

// Canonical ship_types from production migrations
// (20251109 initial + 20260326 parhelion + balance tweaks).
// Stats live in ship_definitions.ts.
export type ShipType =
  | "kestrel_courier"
  | "sparrow_scout"
  | "parhelion_seeker"
  | "wayfarer_freighter"
  | "pioneer_lifter"
  | "atlas_hauler"
  | "corsair_raider"
  | "pike_frigate"
  | "bulwark_destroyer"
  | "aegis_cruiser"
  | "sovereign_starcruiser"
  | "escape_pod"
  | "autonomous_probe"
  | "autonomous_light_hauler"

export interface Ship {
  id: ShipId
  type: ShipType
  name?: string
  ownerCharacterId?: CharacterId
  ownerCorpId?: CorpId
  fighters: number
  shields: number
  maxShields: number
  turnsPerWarp: number
  cargo: number
  credits: number // lives on the ship in production; ship_instances.credits
  sector: SectorId
}

export interface Character {
  id: CharacterId
  name: string
  currentShipId: ShipId
  currentSector: SectorId
  corpId?: CorpId
}

export interface Corporation {
  id: CorpId
  name: string
  memberCharacterIds: CharacterId[]
}

export type GarrisonMode = "defensive" | "offensive" | "toll"

export interface Garrison {
  id: GarrisonId
  ownerCharacterId: CharacterId
  sector: SectorId
  fighters: number
  mode: GarrisonMode
  tollAmount: number
}

// ---- Combat strategies (strategies spec) ----

export type StrategyTemplate = "offensive" | "defensive" | "evasive" | "custom"

export interface CombatStrategy {
  shipId: ShipId
  template: StrategyTemplate
  customPrompt?: string
  authorCharacterId?: CharacterId
}

// ---- Combat state types (snake_case — match production `_shared/combat_types.ts`) ----

export type CombatantType = "character" | "garrison"

export type CombatantAction = "attack" | "brace" | "flee" | "pay"

export interface CombatantState {
  combatant_id: string
  combatant_type: CombatantType
  name: string
  fighters: number
  shields: number
  turns_per_warp: number
  max_fighters: number
  max_shields: number
  is_escape_pod: boolean
  owner_character_id?: string | null
  ship_type?: string | null
  metadata?: Record<string, unknown>
  /** Set when a `flee` succeeded for this combatant this encounter. The
   * combatant remains in `encounter.participants` for event-replay purposes
   * but has physically left the sector. Harness-only — production infers
   * this from `flee_results` on the round event log. */
  has_fled?: boolean
  /** Destination sector the fleer relocated to. Populated alongside
   * `has_fled`. */
  fled_to_sector?: number | null
}

export interface RoundActionState {
  action: CombatantAction
  commit: number
  timed_out: boolean
  submitted_at: string
  target_id?: string | null
  destination_sector?: number | null
}

export interface CombatRoundOutcome {
  round_number: number
  hits: Record<string, number>
  offensive_losses: Record<string, number>
  defensive_losses: Record<string, number>
  shield_loss: Record<string, number>
  damage_mitigated: Record<string, number>
  fighters_remaining: Record<string, number>
  shields_remaining: Record<string, number>
  flee_results: Record<string, boolean>
  end_state: string | null
  effective_actions: Record<string, RoundActionState>
}

export interface CombatRoundLog {
  round_number: number
  actions: Record<string, RoundActionState>
  hits: Record<string, number>
  offensive_losses: Record<string, number>
  defensive_losses: Record<string, number>
  shield_loss: Record<string, number>
  damage_mitigated?: Record<string, number>
  result: string | null
  timestamp: string
}

// Deviation from production: `deadline` and `last_updated` are numeric ms epochs
// in the harness (design principle 3). ISO-string conversion happens at event
// emission boundaries. When porting back, these fields become `string | null`.
export interface CombatEncounterState {
  combat_id: string
  sector_id: number
  round: number
  deadline: number | null
  participants: Record<string, CombatantState>
  pending_actions: Record<string, RoundActionState>
  /**
   * Harness-only display buffer. After `resolveEncounterRound` clears
   * `pending_actions`, the round's actions (including timeout auto-braces)
   * are mirrored here so the UI's per-participant badge can show the
   * decision the LLM just made — even when the tool call that triggered
   * the final resolution fires synchronously inside a React batch that
   * would otherwise paint only the post-resolution (empty) state.
   *
   * Cleared per-participant on each new `submitAction` so a ship that
   * decides again in round N+1 flips back from "resolved" to "submitted"
   * without flicker.
   */
  ui_last_actions: Record<string, RoundActionState>
  logs: CombatRoundLog[]
  context: Record<string, unknown>
  awaiting_resolution: boolean
  ended: boolean
  end_state: string | null
  base_seed: number
  last_updated: number
}

// ---- Action-submission shapes (what UI / controllers pass in) ----

export type SubmitAction =
  | { action: "attack"; target_id: string; commit: number }
  | { action: "brace" }
  | { action: "flee"; destination_sector?: number | null }
  | { action: "pay"; target_id?: string | null }

export interface ActionResult {
  ok: boolean
  reason?: string
}

// ---- Events ----

export interface CombatEvent {
  id: string
  type: string
  payload: unknown
  recipients: EntityId[]
  actor?: EntityId
  combat_id?: CombatId
  sector_id?: SectorId
  timestamp: number
  /**
   * Harness-only annotation populated by `MockEventRelay` right after the
   * event is emitted. One entry per recipient, recording the production
   * append/inference decision for THAT viewer. Read by the event log UI to
   * show "this event would have woken the voice agent from Alice's POV"
   * markers. Does not exist in production — the field is optional and ports
   * back as a no-op.
   */
  relay?: RelayDecision[]
}

/**
 * Per-recipient routing decision produced by `MockEventRelay`. Mirrors the
 * output of production's `EventRelay.handle_event()` — specifically the
 * `should_append` + `should_run_llm` booleans at the end of the routing
 * pipeline, plus the rule names that produced them so the debug UI can
 * explain "why".
 */
export interface RelayDecision {
  /** The entity (character or corp-ship pseudo) this decision is for. */
  viewer: EntityId
  /** Append rule configured for this event type. */
  appendRule: AppendRule
  /** Inference rule configured for this event type. */
  inferenceRule: InferenceRule
  /** Final decision: does this event land in the viewer's LLM context? */
  append: boolean
  /** Final decision: does appending this event trigger an LLM turn? */
  run_llm: boolean
  /** Human-readable "why this decision" for debug display. */
  reason: string
}

/**
 * Production: `subagents/event_relay.py:48-55`. The harness ports the five
 * variants relevant to combat / garrison events; OWNED_TASK is out of scope
 * (no tasks in the harness).
 */
export type AppendRule = "NEVER" | "PARTICIPANT" | "DIRECT" | "LOCAL" | "OWNED"

/**
 * Production: `subagents/event_relay.py:58-65`. VOICE_AGENT is omitted
 * (harness doesn't track request-id provenance).
 */
export type InferenceRule = "NEVER" | "ALWAYS" | "ON_PARTICIPANT" | "OWNED"

// ---- World ----

export interface World {
  characters: Map<CharacterId, Character>
  ships: Map<ShipId, Ship>
  corporations: Map<CorpId, Corporation>
  garrisons: Map<GarrisonId, Garrison>
  strategies: Map<ShipId, CombatStrategy>
  activeCombats: Map<CombatId, CombatEncounterState>
}

export function makeEmptyWorld(): World {
  return {
    characters: new Map(),
    ships: new Map(),
    corporations: new Map(),
    garrisons: new Map(),
    strategies: new Map(),
    activeCombats: new Map(),
  }
}
