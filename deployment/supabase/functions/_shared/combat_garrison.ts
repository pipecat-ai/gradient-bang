import {
  CombatEncounterState,
  CombatantState,
  RoundActionState,
} from './combat_types.ts';
import {
  areFriendlyFromMeta,
  type CorporationMap,
} from './friendly.ts';

export interface TollPayment {
  payer: string;
  amount: number;
  round: number;
}

export interface TollRegistryEntry {
  owner_id?: string | null;
  toll_amount?: number;
  toll_balance?: number;
  target_id?: string | null;
  paid?: boolean;
  paid_round?: number | null;
  demand_round?: number;
  payments?: TollPayment[];
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
  );
  for (const p of Object.values(encounter.participants)) {
    if (p.combatant_id === garrison.combatant_id) continue;
    if (p.combatant_type !== 'character') continue;
    if (p.fighters <= 0) continue;
    if (p.is_escape_pod) continue;
    if (p.owner_character_id === garrison.owner_character_id) continue;
    if (areFriendlyFromMeta(corps, p, garrison)) continue;
    if (!paidPayers.has(p.combatant_id)) return false;
  }
  return true;
}

/**
 * True if any toll garrison in the registry still has an unpaid hostile.
 * Used by the stalemate-unstuck path to keep combat open when tolls remain
 * outstanding.
 */
export function anyOutstandingToll(
  encounter: CombatEncounterState,
  registry: Record<string, TollRegistryEntry>,
  corps: CorporationMap,
): boolean {
  for (const [garrisonKey, entry] of Object.entries(registry)) {
    const garrison = encounter.participants[garrisonKey];
    if (!garrison) continue;
    if (!allHostilesPaid(encounter, garrison, entry, corps)) return true;
  }
  return false;
}

function calculateCommit(mode: string, fighters: number): number {
  if (fighters <= 0) {
    return 0;
  }
  const normalized = mode?.toLowerCase() ?? 'offensive';
  if (normalized === 'defensive') {
    return Math.max(1, Math.min(fighters, Math.max(25, Math.floor(fighters / 4))));
  }
  if (normalized === 'toll') {
    return Math.max(1, Math.min(fighters, Math.max(50, Math.floor(fighters / 3))));
  }
  return Math.max(1, Math.min(fighters, Math.max(50, Math.floor(fighters / 2))));
}

function buildGarrisonId(state: CombatantState): string {
  return state.combatant_id;
}

function selectStrongestTarget(
  encounter: CombatEncounterState,
  garrison: CombatantState,
  corps: CorporationMap,
  paidPayers: ReadonlySet<string> = new Set(),
): CombatantState | null {
  const candidates = Object.values(encounter.participants).filter((participant) => {
    if (participant.combatant_type !== 'character') {
      return false;
    }
    if (participant.combatant_id === garrison.combatant_id) {
      return false;
    }
    if (participant.fighters <= 0) {
      return false;
    }
    if (participant.owner_character_id === garrison.owner_character_id) {
      return false;
    }
    if (areFriendlyFromMeta(corps, participant, garrison)) {
      return false;
    }
    if (participant.is_escape_pod) {
      return false;
    }
    if (paidPayers.has(participant.combatant_id)) {
      return false;
    }
    return true;
  });
  if (!candidates.length) {
    return null;
  }
  candidates.sort((a, b) => {
    if (a.fighters !== b.fighters) {
      return b.fighters - a.fighters;
    }
    if (a.shields !== b.shields) {
      return b.shields - a.shields;
    }
    return a.combatant_id.localeCompare(b.combatant_id);
  });
  return candidates[0];
}

function ensureTollRegistry(encounter: CombatEncounterState): Record<string, TollRegistryEntry> {
  if (!encounter.context || typeof encounter.context !== 'object') {
    encounter.context = {};
  }
  const registry = encounter.context.toll_registry;
  if (registry && typeof registry === 'object') {
    return registry as Record<string, TollRegistryEntry>;
  }
  const created: Record<string, TollRegistryEntry> = {};
  encounter.context.toll_registry = created;
  return created;
}

function buildTollAction(
  encounter: CombatEncounterState,
  participant: CombatantState,
  corps: CorporationMap,
): RoundActionState {
  const registry = ensureTollRegistry(encounter);
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  const garrisonId = buildGarrisonId(participant);
  const entry =
    registry[garrisonId] ??
    {
      owner_id: participant.owner_character_id,
      toll_amount: typeof metadata.toll_amount === 'number' ? metadata.toll_amount : 0,
      toll_balance: typeof metadata.toll_balance === 'number' ? metadata.toll_balance : 0,
      demand_round: encounter.round,
    };
  registry[garrisonId] = entry;

  // Per-payer toll: a combatant is at peace with this garrison only if a
  // payment from them is on record. Paid payers are excluded from targeting;
  // the garrison stays hostile to the rest until they pay too.
  const paidPayers = new Set<string>(
    (entry.payments ?? []).map((p) => p.payer),
  );

  // Sticky target invalidation: drop the previous target if it's no longer
  // a valid hostile — paid, fled, destroyed, friendly, escape pod, or simply
  // not in the encounter anymore. Otherwise the garrison would brace forever
  // chasing a target that has left while other unpaid hostiles remain.
  if (entry.target_id) {
    const prev = encounter.participants[entry.target_id];
    const stillValid =
      prev !== undefined &&
      prev.combatant_type === 'character' &&
      prev.fighters > 0 &&
      !prev.is_escape_pod &&
      !prev.has_fled &&
      prev.owner_character_id !== participant.owner_character_id &&
      !areFriendlyFromMeta(corps, prev, participant) &&
      !paidPayers.has(prev.combatant_id);
    if (!stillValid) {
      entry.target_id = null;
    }
  }

  // Pick a target: prefer the initiator if hostile + unpaid, else strongest unpaid hostile.
  if (!entry.target_id) {
    const initiatorId =
      typeof encounter.context?.initiator === 'string'
        ? encounter.context.initiator
        : null;
    const initiatorParticipant = initiatorId
      ? encounter.participants[initiatorId]
      : undefined;
    if (
      initiatorId &&
      initiatorParticipant &&
      initiatorParticipant.combatant_type === 'character' &&
      initiatorParticipant.fighters > 0 &&
      (initiatorParticipant.owner_character_id ?? initiatorId) !==
        participant.owner_character_id &&
      !areFriendlyFromMeta(corps, initiatorParticipant, participant) &&
      !initiatorParticipant.is_escape_pod &&
      !paidPayers.has(initiatorParticipant.combatant_id)
    ) {
      entry.target_id = initiatorId;
    } else {
      const fallback = selectStrongestTarget(
        encounter,
        participant,
        corps,
        paidPayers,
      );
      entry.target_id = fallback ? fallback.combatant_id : null;
    }
  }

  const targetState = entry.target_id
    ? encounter.participants[entry.target_id]
    : null;
  const targetAvailable = Boolean(targetState && targetState.fighters > 0);
  const demandRound = entry.demand_round ?? encounter.round;
  const allPaid = allHostilesPaid(encounter, participant, entry, corps);

  let action: RoundActionState['action'] = 'brace';
  let commit = 0;
  let targetId: string | null = null;

  if (allPaid) {
    // Every hostile has paid — garrison holds fire. checkTollStanddown will
    // end the encounter this round given no active cross-attacks.
    action = 'brace';
  } else if (targetAvailable) {
    if (encounter.round === demandRound) {
      // Demand round: stand off, give unpaid combatants time to decide.
      action = 'brace';
    } else {
      action = 'attack';
      commit = participant.fighters;
      targetId = targetState?.combatant_id ?? null;
    }
  }

  return {
    action,
    commit,
    timed_out: false,
    target_id: targetId,
    destination_sector: null,
    submitted_at: new Date().toISOString(),
  };
}

export function buildGarrisonActions(
  encounter: CombatEncounterState,
  corps: CorporationMap,
): Record<string, RoundActionState> {
  const actions: Record<string, RoundActionState> = {};

  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type !== 'garrison') {
      continue;
    }
    if ((participant.fighters ?? 0) <= 0) {
      continue;
    }
    const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
    const mode = String(metadata.mode ?? 'offensive').toLowerCase();
    if (mode === 'toll') {
      actions[participant.combatant_id] = buildTollAction(
        encounter,
        participant,
        corps,
      );
      continue;
    }

    const commit = calculateCommit(mode, participant.fighters);
    const target = selectStrongestTarget(encounter, participant, corps);
    if (!commit || !target) {
      actions[participant.combatant_id] = {
        action: 'brace',
        commit: 0,
        timed_out: false,
        target_id: null,
        destination_sector: null,
        submitted_at: new Date().toISOString(),
      };
      continue;
    }
    actions[participant.combatant_id] = {
      action: 'attack',
      commit,
      timed_out: false,
      target_id: target.combatant_id,
      destination_sector: null,
      submitted_at: new Date().toISOString(),
    };
  }

  return actions;
}
