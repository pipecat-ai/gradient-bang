import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { emitCharacterEvent, emitSectorEnvelope, buildEventSource } from './events.ts';
import { buildGarrisonActions } from './combat_garrison.ts';
import { resolveRound } from './combat_engine.ts';
import { finalizeCombat } from './combat_finalization.ts';
import { buildRoundResolvedPayload, buildRoundWaitingPayload, buildCombatEndedPayload } from './combat_events.ts';
import { buildSectorSnapshot } from './map.ts';
import {
  CombatEncounterState,
  RoundActionState,
  CombatantState,
} from './combat_types.ts';
import { persistCombatState } from './combat_state.ts';

const ROUND_TIMEOUT_SECONDS = Number(Deno.env.get('COMBAT_ROUND_TIMEOUT') ?? '15');

export function computeNextCombatDeadline(): string {
  return new Date(Date.now() + ROUND_TIMEOUT_SECONDS * 1000).toISOString();
}

export async function resolveEncounterRound(options: {
  supabase: SupabaseClient;
  encounter: CombatEncounterState;
  requestId: string;
  source?: string;
}): Promise<void> {
  const { supabase, encounter, requestId } = options;
  const sourceName = options.source ?? 'combat.resolution';

  const corpMap = buildCorporationMap(encounter);
  const timeoutActions = buildTimeoutActions(encounter);
  const garrisonActions = buildGarrisonActions(encounter, corpMap);
  const combinedActions: Record<string, RoundActionState> = {
    ...encounter.pending_actions,
    ...timeoutActions,
    ...garrisonActions,
  };

  const outcome = resolveRound(encounter, combinedActions);

  console.log('combat_resolution.outcome', {
    combat_id: encounter.combat_id,
    round: encounter.round,
    end_state: outcome.end_state,
    fighters_remaining: outcome.fighters_remaining,
    destroyed: outcome.destroyed,
  });

  // Check for toll satisfaction after resolution
  if (checkTollStanddown(encounter, outcome, combinedActions)) {
    outcome.end_state = 'toll_satisfied';
  }

  encounter.logs.push({
    round_number: outcome.round_number,
    actions: combinedActions,
    hits: outcome.hits,
    offensive_losses: outcome.offensive_losses,
    defensive_losses: outcome.defensive_losses,
    shield_loss: outcome.shield_loss,
    result: outcome.end_state ?? null,
    timestamp: new Date().toISOString(),
  });

  const resolvedPayload = buildRoundResolvedPayload(encounter, outcome, combinedActions);
  resolvedPayload.source = buildEventSource('combat.round_resolved', requestId);

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    participant.fighters = outcome.fighters_remaining?.[pid] ?? participant.fighters;
    participant.shields = outcome.shields_remaining?.[pid] ?? participant.shields;
  }

  encounter.pending_actions = {};
  encounter.awaiting_resolution = false;

  const recipients = collectRecipients(encounter);

  await broadcastEvent({
    supabase,
    recipients,
    encounter,
    eventType: 'combat.round_resolved',
    payload: resolvedPayload,
    requestId,
  });

  if (outcome.end_state) {
    console.log('combat_resolution.ending', { combat_id: encounter.combat_id, end_state: outcome.end_state });
    encounter.ended = true;
    encounter.end_state = outcome.end_state;
    encounter.deadline = null;

    const salvage = await finalizeCombat(supabase, encounter, outcome);

    console.log('combat_resolution.broadcasting_ended', { combat_id: encounter.combat_id, recipients: recipients.length });

    // Send personalized combat.ended event to each participant with their own ship data
    // (matches legacy pattern from game-server/combat/callbacks.py:394-412)
    const { buildCombatEndedPayloadForViewer } = await import('./combat_events.ts');
    for (const recipient of recipients) {
      const personalizedPayload = await buildCombatEndedPayloadForViewer(
        supabase,
        encounter,
        outcome,
        salvage,
        encounter.logs ?? [],
        recipient,
      );
      personalizedPayload.source = buildEventSource('combat.ended', requestId);

      await emitCharacterEvent({
        supabase,
        characterId: recipient,
        eventType: 'combat.ended',
        payload: personalizedPayload,
        sectorId: encounter.sector_id,
        requestId,
      });
    }

    // Emit sector.update to all sector occupants after combat ends
    const sectorSnapshot = await buildSectorSnapshot(supabase, encounter.sector_id);
    await emitSectorEnvelope({
      supabase,
      sectorId: encounter.sector_id,
      eventType: 'sector.update',
      payload: {
        source: buildEventSource('combat.ended', requestId),
        ...sectorSnapshot,
      },
      requestId,
      actorCharacterId: null,
    });
  } else {
    console.log('combat_resolution.continuing', { combat_id: encounter.combat_id, next_round: outcome.round_number + 1 });
    encounter.round = outcome.round_number + 1;
    encounter.deadline = computeNextCombatDeadline();

    const waitingPayload = buildRoundWaitingPayload(encounter);
    waitingPayload.source = buildEventSource('combat.round_waiting', requestId);

    await broadcastEvent({
      supabase,
      recipients,
      encounter,
      eventType: 'combat.round_waiting',
      payload: waitingPayload,
      requestId,
    });
  }

  await persistCombatState(supabase, encounter);
}

function buildCorporationMap(encounter: CombatEncounterState): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type !== 'character') {
      continue;
    }
    const metadata = participant.metadata as Record<string, unknown> | undefined;
    const corpId = typeof metadata?.corporation_id === 'string' ? metadata.corporation_id : null;
    const key = participant.owner_character_id ?? participant.combatant_id;
    map.set(key, corpId);
  }
  return map;
}

function buildTimeoutActions(encounter: CombatEncounterState): Record<string, RoundActionState> {
  const actions: Record<string, RoundActionState> = {};
  for (const [pid, participant] of Object.entries(encounter.participants)) {
    if (participant.combatant_type === 'garrison') {
      continue;
    }
    if (encounter.pending_actions[pid]) {
      continue;
    }
    if ((participant.fighters ?? 0) <= 0) {
      continue;
    }
    actions[pid] = {
      action: 'brace',
      commit: 0,
      timed_out: true,
      target_id: null,
      destination_sector: null,
      submitted_at: new Date().toISOString(),
    };
  }
  return actions;
}

function collectRecipients(encounter: CombatEncounterState): string[] {
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

async function broadcastEvent(params: {
  supabase: SupabaseClient;
  recipients: string[];
  encounter: CombatEncounterState;
  eventType: string;
  payload: Record<string, unknown>;
  requestId: string;
}): Promise<void> {
  const { supabase, recipients, encounter, eventType, payload, requestId } = params;

  await Promise.all(
    recipients.map((recipient) =>
      emitCharacterEvent({
        supabase,
        characterId: recipient,
        eventType,
        payload,
        sectorId: encounter.sector_id,
        requestId,
      }),
    ),
  );

  await emitSectorEnvelope({
    supabase,
    sectorId: encounter.sector_id,
    eventType,
    payload,
    requestId,
  });
}

function checkTollStanddown(
  encounter: CombatEncounterState,
  outcome: { round_number: number; end_state: string | null },
  actions: Record<string, RoundActionState>,
): boolean {
  // Check if there's a toll registry in the context
  const context = encounter.context as Record<string, unknown> | undefined;
  if (!context) {
    return false;
  }
  const tollRegistry = context.toll_registry as Record<string, unknown> | undefined;
  if (!tollRegistry) {
    return false;
  }

  // Check each garrison to see if toll was paid this round
  for (const [garrisonId, entryRaw] of Object.entries(tollRegistry)) {
    const entry = entryRaw as Record<string, unknown>;
    if (!entry.paid) {
      continue;
    }
    const paidRound = entry.paid_round as number | undefined;
    // Use outcome.round_number instead of encounter.round
    if (paidRound !== outcome.round_number) {
      continue;
    }

    // Check if garrison braced or paid
    const garrisonAction = actions[garrisonId];
    if (garrisonAction && garrisonAction.action !== 'brace' && garrisonAction.action !== 'pay') {
      continue;
    }

    // Check if all other participants braced or paid
    let othersBraced = true;
    for (const [pid, participantAction] of Object.entries(actions)) {
      if (pid === garrisonId) {
        continue;
      }
      if (participantAction.action !== 'brace' && participantAction.action !== 'pay') {
        othersBraced = false;
        break;
      }
    }

    if (othersBraced) {
      return true;
    }
  }

  return false;
}
