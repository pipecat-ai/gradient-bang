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
    id: participant.combatant_id,
    created_at: typeof metadata.first_visit === 'string' ? metadata.first_visit : new Date().toISOString(),
    name: participant.name,
    player_type: (metadata.player_type as string) ?? 'human',
    ship_id: typeof metadata.ship_id === 'string' ? metadata.ship_id : null,
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
  actions?: Record<string, unknown>,
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

  // Include actions for legacy compatibility (matches previous serialize_round)
  if (actions) {
    const actionsMap: Record<string, unknown> = {};
    for (const [pid, action] of Object.entries(actions)) {
      const actionState = action as Record<string, unknown>;
      // Use participant name (display name) as key for legacy compatibility
      const participant = encounter.participants[pid];
      const participantKey = participant?.name ?? pid;
      actionsMap[participantKey] = {
        action: actionState.action ?? 'brace',
        commit: actionState.commit ?? 0,
        timed_out: actionState.timed_out ?? false,
        submitted_at: actionState.submitted_at ?? new Date().toISOString(),
        target: actionState.target_id ?? null,
        destination_sector: actionState.destination_sector ?? null,
      };
    }
    payload['actions'] = actionsMap;
  }

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

/**
 * Build a personalized combat.ended payload for a specific viewer.
 * Includes the viewer's ship data after combat resolution (e.g., escape pod conversion).
 */
export async function buildCombatEndedPayloadForViewer(
  supabase: any,
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  salvage: Array<Record<string, unknown>>,
  logs: Array<Record<string, unknown>>,
  viewerId: string,
): Promise<Record<string, unknown>> {
  const payload = buildCombatEndedPayload(encounter, outcome, salvage, logs);

  // Add viewer's ship data (matches legacy serialize_combat_ended_event pattern)
  try {
    // Import helper functions (we'll use dynamic import to avoid circular deps)
    const { loadCharacter } = await import('./status.ts');
    const { loadShip } = await import('./status.ts');
    const { loadShipDefinition } = await import('./status.ts');

    const character = await loadCharacter(supabase, viewerId);
    const ship = await loadShip(supabase, character.current_ship_id);
    const definition = await loadShipDefinition(supabase, ship.ship_type);

    // Build ship snapshot (simplified version for event payload)
    const cargo = {
      quantum_foam: ship.cargo_qf ?? 0,
      retro_organics: ship.cargo_ro ?? 0,
      neuro_symbolics: ship.cargo_ns ?? 0,
    };
    const cargoUsed = cargo.quantum_foam + cargo.retro_organics + cargo.neuro_symbolics;
    const cargoCapacity = definition.cargo_holds;

    payload['ship'] = {
      ship_id: ship.ship_id,
      ship_type: ship.ship_type,
      ship_name: ship.ship_name ?? definition.display_name,
      credits: ship.credits ?? 0,
      cargo,
      cargo_capacity: cargoCapacity,
      empty_holds: Math.max(cargoCapacity - cargoUsed, 0),
      warp_power: ship.current_warp_power ?? definition.warp_power_capacity,
      shields: ship.current_shields ?? 0,
      fighters: ship.current_fighters ?? 0,
      max_shields: definition.max_shields,
      max_fighters: definition.max_fighters,
    };
  } catch (err) {
    console.error('Failed to load ship data for viewer', viewerId, err);
    // Don't fail the event emission if ship data can't be loaded
  }

  return payload;
}

/**
 * Extract corporation IDs from combat participants.
 * Returns all unique corp IDs involved in the combat (from any participant).
 */
export function getCorpIdsFromParticipants(
  participants: Record<string, CombatantState>,
): string[] {
  const corpIds = new Set<string>();
  for (const participant of Object.values(participants)) {
    const metadata = participant.metadata as Record<string, unknown> | undefined;
    const corpId = metadata?.corporation_id as string | undefined;
    if (corpId) {
      corpIds.add(corpId);
    }
    // Also check garrison owner's corporation_id
    const ownerCorpId = metadata?.owner_corporation_id as string | undefined;
    if (ownerCorpId) {
      corpIds.add(ownerCorpId);
    }
  }
  return Array.from(corpIds);
}

/**
 * Collect character IDs from combat participants.
 * Returns only character combatants (not garrisons).
 */
export function collectParticipantIds(encounter: CombatEncounterState): string[] {
  const ids: Set<string> = new Set();
  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type !== 'character') {
      continue;
    }
    const key = participant.owner_character_id ?? participant.combatant_id;
    ids.add(key);
  }
  return Array.from(ids);
}
