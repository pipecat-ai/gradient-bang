import {
  CombatEncounterState,
  CombatRoundOutcome,
  CombatantState,
} from './combat_types.ts';

interface ParticipantDelta {
  fighters: number;
  shields: number;
}

interface ParticipantEventContext {
  shieldIntegrity: number;
  shieldDamage?: number;
  fighterLoss?: number;
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildParticipantPayload(
  participant: CombatantState,
  ctx: ParticipantEventContext,
): Record<string, unknown> {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  if (participant.combatant_type !== 'character') {
    return {};
  }
  const shipPayload = {
    ship_type: participant.ship_type ?? metadata.ship_type ?? 'unknown',
    ship_name: metadata.ship_name ?? participant.name,
    shield_integrity: Number.isFinite(ctx.shieldIntegrity)
      ? Number(ctx.shieldIntegrity.toFixed(1))
      : 0,
    shield_damage:
      ctx.shieldDamage && ctx.shieldDamage !== 0
        ? Number(ctx.shieldDamage.toFixed(1))
        : null,
    fighter_loss: ctx.fighterLoss && ctx.fighterLoss > 0 ? ctx.fighterLoss : null,
  };
  return {
    created_at: typeof metadata.first_visit === 'string' ? metadata.first_visit : new Date().toISOString(),
    name: participant.name,
    player_type: 'human',
    ship: shipPayload,
  };
}

function buildGarrisonPayload(
  participant: CombatantState,
  fighterLoss = 0,
): Record<string, unknown> {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  // Use owner_name from metadata (human-readable), fallback to owner_character_id
  const ownerName = typeof metadata.owner_name === 'string'
    ? metadata.owner_name
    : (participant.owner_character_id ?? participant.combatant_id);
  return {
    owner_name: ownerName,  // Human-readable name, not UUID
    fighters: participant.fighters,
    fighter_loss: fighterLoss > 0 ? fighterLoss : null,
    mode: metadata.mode ?? 'offensive',
    toll_amount: metadata.toll_amount ?? 0,
    deployed_at: metadata.deployed_at ?? null,
  };
}

function computeShieldIntegrity(state: CombatantState): number {
  const maxShields = Math.max(0, state.max_shields ?? 0);
  const shields = Math.max(0, state.shields ?? 0);
  if (maxShields <= 0) {
    return 0;
  }
  return (shields / maxShields) * 100;
}

function buildParticipantDeltas(
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
): Record<string, ParticipantDelta> {
  const deltas: Record<string, ParticipantDelta> = {};
  if (outcome.participant_deltas) {
    for (const [pid, delta] of Object.entries(outcome.participant_deltas)) {
      deltas[pid] = {
        fighters: safeNumber(delta.fighters),
        shields: safeNumber(delta.shields),
      };
    }
    return deltas;
  }
  for (const [pid, state] of Object.entries(encounter.participants)) {
    const remaining = outcome.fighters_remaining?.[pid] ?? state.fighters;
    deltas[pid] = {
      fighters: remaining - state.fighters,
      shields: (outcome.shields_remaining?.[pid] ?? state.shields) - state.shields,
    };
  }
  return deltas;
}

function basePayload(encounter: CombatEncounterState): Record<string, unknown> {
  return {
    combat_id: encounter.combat_id,
    sector: { id: encounter.sector_id },
    round: encounter.round,
  };
}

export function buildRoundWaitingPayload(encounter: CombatEncounterState): Record<string, unknown> {
  const payload = {
    ...basePayload(encounter),
    current_time: new Date().toISOString(),
    deadline: encounter.deadline,
  };
  const participants: Record<string, unknown>[] = [];
  let garrisonPayload: Record<string, unknown> | null = null;
  for (const participant of Object.values(encounter.participants)) {
    const shieldIntegrity = computeShieldIntegrity(participant);
    if (participant.combatant_type === 'character') {
      participants.push(buildParticipantPayload(participant, { shieldIntegrity }));
    } else if (!garrisonPayload) {
      garrisonPayload = buildGarrisonPayload(participant);
    }
  }
  if (encounter.round === 1 && typeof encounter.context?.initiator === 'string') {
    const initiatorId = encounter.context.initiator;
    const participant = encounter.participants[initiatorId];
    const metadata = (participant?.metadata ?? {}) as Record<string, unknown>;
    const legacyName =
      typeof metadata.legacy_character_id === 'string'
        ? metadata.legacy_character_id
        : undefined;
    payload['initiator'] = legacyName ?? participant?.name ?? initiatorId;
  }
  payload['participants'] = participants;
  payload['garrison'] = garrisonPayload;
  return payload;
}

export function buildRoundResolvedPayload(
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
): Record<string, unknown> {
  const payload = {
    ...basePayload(encounter),
    hits: outcome.hits,
    offensive_losses: outcome.offensive_losses,
    defensive_losses: outcome.defensive_losses,
    shield_loss: outcome.shield_loss,
    fighters_remaining: outcome.fighters_remaining,
    shields_remaining: outcome.shields_remaining,
    flee_results: outcome.flee_results,
    end: outcome.end_state,
    result: outcome.end_state,
    deadline: encounter.deadline,
    round_result: outcome.end_state,
  };
  const deltas = buildParticipantDeltas(encounter, outcome);
  const participants: Record<string, unknown>[] = [];
  let garrisonPayload: Record<string, unknown> | null = null;

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    const delta = deltas[pid] ?? { fighters: 0, shields: 0 };
    const fightersStart = participant.fighters ?? 0;
    const fightersRemaining = outcome.fighters_remaining?.[pid] ?? fightersStart;
    const fighterLoss = Math.max(0, fightersStart - fightersRemaining);

    const maxShields = Math.max(0, participant.max_shields ?? participant.shields ?? 0);
    const shieldsStart = participant.shields ?? maxShields;
    const shieldsRemaining = outcome.shields_remaining?.[pid] ?? shieldsStart;
    const shieldDamagePercent =
      maxShields > 0 ? ((shieldsStart - shieldsRemaining) / maxShields) * 100 : 0;
    const shieldIntegrity =
      maxShields > 0 ? (shieldsRemaining / maxShields) * 100 : 0;

    if (participant.combatant_type === 'character') {
      participants.push(
        buildParticipantPayload(participant, {
          shieldIntegrity,
          shieldDamage: shieldDamagePercent,
          fighterLoss,
        }),
      );
    } else if (!garrisonPayload) {
      garrisonPayload = buildGarrisonPayload(participant, fighterLoss);
    }
  }

  payload['participants'] = participants;
  payload['garrison'] = garrisonPayload;
  return payload;
}

export function buildCombatEndedPayload(
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  salvage: Array<Record<string, unknown>>,
  logs: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const payload = buildRoundResolvedPayload(encounter, outcome);
  payload['salvage'] = salvage;
  payload['logs'] = logs;
  return payload;
}
