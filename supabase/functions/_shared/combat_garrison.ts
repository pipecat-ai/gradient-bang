import {
  CombatEncounterState,
  CombatantState,
  RoundActionState,
} from './combat_types.ts';

type CorporationMap = Map<string, string | null | undefined>;

interface TollRegistryEntry {
  owner_id?: string | null;
  toll_amount?: number;
  toll_balance?: number;
  target_id?: string | null;
  paid?: boolean;
  paid_round?: number | null;
  demand_round?: number;
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

function shareCorporation(
  corps: CorporationMap,
  first?: string | null,
  second?: string | null,
): boolean {
  if (!first || !second) {
    return false;
  }
  return (corps.get(first) ?? null) && corps.get(first) === corps.get(second);
}

function buildGarrisonId(state: CombatantState): string {
  return state.combatant_id;
}

function selectStrongestTarget(
  encounter: CombatEncounterState,
  garrison: CombatantState,
  corps: CorporationMap,
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
    if (
      shareCorporation(
        corps,
        participant.owner_character_id ?? participant.combatant_id,
        garrison.owner_character_id ?? garrison.combatant_id,
      )
    ) {
      return false;
    }
    if (participant.is_escape_pod) {
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

export function buildGarrisonActions(
  encounter: CombatEncounterState,
  corps: CorporationMap,
): Record<string, RoundActionState> {
  const actions: Record<string, RoundActionState> = {};
  const registry = ensureTollRegistry(encounter);

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
      const entry = registry[buildGarrisonId(participant)] ?? {
        owner_id: participant.owner_character_id,
        toll_amount: metadata.toll_amount ?? 0,
        toll_balance: metadata.toll_balance ?? 0,
        demand_round: encounter.round,
      };
      registry[buildGarrisonId(participant)] = entry;
      if (!entry.target_id) {
        const initiatorId = typeof encounter.context?.initiator === 'string'
          ? encounter.context.initiator
          : null;
        if (
          initiatorId &&
          encounter.participants[initiatorId] &&
          encounter.participants[initiatorId].combatant_type === 'character' &&
          encounter.participants[initiatorId].fighters > 0 &&
          !shareCorporation(
            corps,
            encounter.participants[initiatorId].owner_character_id ?? initiatorId,
            participant.owner_character_id ?? buildGarrisonId(participant),
          ) &&
          !encounter.participants[initiatorId].is_escape_pod
        ) {
          entry.target_id = initiatorId;
        } else {
          const fallback = selectStrongestTarget(encounter, participant, corps);
          entry.target_id = fallback ? fallback.combatant_id : null;
        }
      }

      const targetState = entry.target_id ? encounter.participants[entry.target_id] : null;
      const targetAvailable = Boolean(targetState && targetState.fighters > 0);
      const demandRound = entry.demand_round ?? encounter.round;
      const alreadyPaid = Boolean(entry.paid);
      let action: RoundActionState['action'] = 'brace';
      let commit = 0;
      let targetId: string | null = null;

      if (alreadyPaid && (!entry.paid_round || entry.paid_round <= encounter.round)) {
        action = 'brace';
      } else if (!alreadyPaid && targetAvailable) {
        if (encounter.round === demandRound) {
          action = 'brace';
        } else {
          action = 'attack';
          commit = participant.fighters;
          targetId = targetState?.combatant_id ?? null;
        }
      }

      actions[participant.combatant_id] = {
        action,
        commit,
        timed_out: false,
        target_id: targetId,
        destination_sector: null,
        submitted_at: new Date().toISOString(),
      };
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
