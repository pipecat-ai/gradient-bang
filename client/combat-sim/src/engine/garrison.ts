import {
  buildCorporationMap,
  combatantsAreFriendly,
  type CorporationMap,
} from "./friendly"
import type {
  CombatEncounterState,
  CombatantAction,
  CombatantState,
  RoundActionState,
} from "./types"

// Ported from `deployment/supabase/functions/_shared/combat_garrison.ts`.
// Slice 4 adds corp-aware friendly checks. Slice 5 adds full toll-mode handling
// (demand round → attack if unpaid, brace if paid; toll_registry on context).

function calculateCommit(mode: string, fighters: number): number {
  if (fighters <= 0) return 0
  const normalized = mode?.toLowerCase() ?? "offensive"
  if (normalized === "defensive") {
    return Math.max(1, Math.min(fighters, Math.max(25, Math.floor(fighters / 4))))
  }
  if (normalized === "toll") {
    return Math.max(1, Math.min(fighters, Math.max(50, Math.floor(fighters / 3))))
  }
  return Math.max(1, Math.min(fighters, Math.max(50, Math.floor(fighters / 2))))
}

function selectStrongestTarget(
  encounter: CombatEncounterState,
  garrison: CombatantState,
  corps: CorporationMap,
  paidPayers: ReadonlySet<string> = new Set(),
): CombatantState | null {
  const candidates = Object.values(encounter.participants).filter((p) => {
    if (p.combatant_type !== "character") return false
    if (p.combatant_id === garrison.combatant_id) return false
    if (p.fighters <= 0) return false
    if (combatantsAreFriendly(corps, p, garrison)) return false
    if (p.is_escape_pod) return false
    if (paidPayers.has(p.combatant_id)) return false
    return true
  })
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    if (a.fighters !== b.fighters) return b.fighters - a.fighters
    if (a.shields !== b.shields) return b.shields - a.shields
    return a.combatant_id.localeCompare(b.combatant_id)
  })
  return candidates[0]
}

/**
 * Per-payer toll semantics: a toll garrison is at peace with the encounter
 * only when every non-friendly, non-destroyed character combatant has a
 * payment record on this garrison's entry. One player paying does NOT
 * absolve the others of their toll obligation.
 */
export function allHostilesPaid(
  encounter: CombatEncounterState,
  garrison: CombatantState,
  entry: TollRegistryEntry,
  corps: CorporationMap,
): boolean {
  const paidPayers = new Set<string>(
    (entry.payments ?? []).map((p) => p.payer),
  )
  for (const p of Object.values(encounter.participants)) {
    if (p.combatant_id === garrison.combatant_id) continue
    if (p.combatant_type !== "character") continue
    if (p.fighters <= 0) continue
    if (p.is_escape_pod) continue
    if (combatantsAreFriendly(corps, p, garrison)) continue
    if (!paidPayers.has(p.combatant_id)) return false
  }
  return true
}

/**
 * True if any toll garrison in the registry still has an unpaid hostile —
 * i.e. the encounter is not yet settled on tolls. Used by the stalemate
 * unstuck path to keep combat open when tolls are outstanding.
 */
export function anyOutstandingToll(
  encounter: CombatEncounterState,
  registry: Record<string, TollRegistryEntry>,
  corps: CorporationMap,
): boolean {
  for (const [garrisonKey, entry] of Object.entries(registry)) {
    const garrison = encounter.participants[garrisonKey]
    if (!garrison) continue
    if (!allHostilesPaid(encounter, garrison, entry, corps)) return true
  }
  return false
}

export interface TollRegistryEntry {
  owner_id?: string | null
  toll_amount: number
  toll_balance: number
  target_id?: string | null
  paid?: boolean
  paid_round?: number | null
  demand_round: number
  payments?: Array<{ payer: string; amount: number; round: number }>
}

export function ensureTollRegistry(
  encounter: CombatEncounterState,
): Record<string, TollRegistryEntry> {
  if (!encounter.context || typeof encounter.context !== "object") {
    encounter.context = {}
  }
  const ctx = encounter.context as Record<string, unknown>
  const existing = ctx.toll_registry
  if (existing && typeof existing === "object") {
    return existing as Record<string, TollRegistryEntry>
  }
  const created: Record<string, TollRegistryEntry> = {}
  ctx.toll_registry = created
  return created
}

function buildTollAction(
  encounter: CombatEncounterState,
  participant: CombatantState,
  corps: CorporationMap,
  now: () => number,
): RoundActionState {
  const registry = ensureTollRegistry(encounter)
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>

  const existingEntry = registry[participant.combatant_id]
  const entry: TollRegistryEntry = existingEntry ?? {
    owner_id: participant.owner_character_id,
    toll_amount: typeof metadata.toll_amount === "number" ? metadata.toll_amount : 0,
    toll_balance: typeof metadata.toll_balance === "number" ? metadata.toll_balance : 0,
    demand_round: encounter.round,
  }
  registry[participant.combatant_id] = entry

  // Per-payer toll state: a combatant at peace with this garrison is one
  // with a payment on record. Paid payers are excluded from targeting; the
  // garrison stays hostile to everyone else.
  const paidPayers = new Set<string>(
    (entry.payments ?? []).map((p) => p.payer),
  )

  // Sticky target_id: invalidate if the previous target has since paid.
  if (entry.target_id && paidPayers.has(entry.target_id)) {
    entry.target_id = null
  }

  // Pick target: prefer the initiator if hostile AND unpaid, else strongest
  // unpaid hostile.
  if (!entry.target_id) {
    const initiatorId =
      typeof encounter.context?.initiator === "string"
        ? (encounter.context.initiator as string)
        : null
    const initiator = initiatorId ? encounter.participants[initiatorId] : undefined
    if (
      initiator &&
      initiator.combatant_type === "character" &&
      initiator.fighters > 0 &&
      (initiator.owner_character_id ?? initiator.combatant_id) !== participant.owner_character_id &&
      !combatantsAreFriendly(corps, initiator, participant) &&
      !initiator.is_escape_pod &&
      !paidPayers.has(initiator.combatant_id)
    ) {
      entry.target_id = initiator.combatant_id
    } else {
      const fallback = selectStrongestTarget(encounter, participant, corps, paidPayers)
      entry.target_id = fallback ? fallback.combatant_id : null
    }
  }

  const targetState = entry.target_id ? encounter.participants[entry.target_id] : null
  const targetAvailable = Boolean(targetState && targetState.fighters > 0)
  const demandRound = entry.demand_round ?? encounter.round
  const allPaid = allHostilesPaid(encounter, participant, entry, corps)

  let action: CombatantAction = "brace"
  let commit = 0
  let targetId: string | null = null

  if (allPaid) {
    // Every hostile has paid — garrison holds fire. checkTollStanddown
    // will end the encounter this round given no active cross-attacks.
    action = "brace"
  } else if (targetAvailable) {
    if (encounter.round === demandRound) {
      // Demand round: stand off and give unpaid combatants time to decide.
      action = "brace"
    } else {
      // Escalate against the unpaid target only. Paid payers are not in
      // the candidate pool (filtered above).
      action = "attack"
      commit = participant.fighters
      targetId = targetState?.combatant_id ?? null
    }
  }

  return {
    action,
    commit,
    timed_out: false,
    target_id: targetId,
    destination_sector: null,
    submitted_at: new Date(now()).toISOString(),
  }
}

export function buildGarrisonActions(
  encounter: CombatEncounterState,
  now: () => number,
): Record<string, RoundActionState> {
  const actions: Record<string, RoundActionState> = {}
  const corps = buildCorporationMap(encounter)

  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type !== "garrison") continue
    if ((participant.fighters ?? 0) <= 0) continue

    const metadata = (participant.metadata ?? {}) as Record<string, unknown>
    const mode = String(metadata.mode ?? "offensive").toLowerCase()

    if (mode === "toll") {
      actions[participant.combatant_id] = buildTollAction(encounter, participant, corps, now)
      continue
    }

    const commit = calculateCommit(mode, participant.fighters)
    const target = selectStrongestTarget(encounter, participant, corps)
    const submittedAt = new Date(now()).toISOString()
    if (!commit || !target) {
      actions[participant.combatant_id] = {
        action: "brace",
        commit: 0,
        timed_out: false,
        target_id: null,
        destination_sector: null,
        submitted_at: submittedAt,
      }
      continue
    }
    actions[participant.combatant_id] = {
      action: "attack",
      commit,
      timed_out: false,
      target_id: target.combatant_id,
      destination_sector: null,
      submitted_at: submittedAt,
    }
  }
  return actions
}
