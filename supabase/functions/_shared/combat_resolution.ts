import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { emitCharacterEvent, emitSectorEnvelope, buildEventSource } from './events.ts';
import { buildGarrisonActions } from './combat_garrison.ts';
import { resolveRound } from './combat_engine.ts';
import { finalizeCombat } from './combat_finalization.ts';
import { buildRoundResolvedPayload, buildRoundWaitingPayload, buildCombatEndedPayload } from './combat_events.ts';
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

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    participant.fighters = outcome.fighters_remaining?.[pid] ?? participant.fighters;
    participant.shields = outcome.shields_remaining?.[pid] ?? participant.shields;
  }

  encounter.pending_actions = {};
  encounter.awaiting_resolution = false;

  const recipients = collectRecipients(encounter);
  const resolvedPayload = buildRoundResolvedPayload(encounter, outcome);
  resolvedPayload.source = buildEventSource('combat.round_resolved', requestId);

  await broadcastEvent({
    supabase,
    recipients,
    encounter,
    eventType: 'combat.round_resolved',
    payload: resolvedPayload,
    requestId,
  });

  if (outcome.end_state) {
    encounter.ended = true;
    encounter.end_state = outcome.end_state;
    encounter.deadline = null;

    const salvage = await finalizeCombat(supabase, encounter, outcome);
    const endedPayload = buildCombatEndedPayload(encounter, outcome, salvage, encounter.logs ?? []);
    endedPayload.source = buildEventSource('combat.ended', requestId);

    await broadcastEvent({
      supabase,
      recipients,
      encounter,
      eventType: 'combat.ended',
      payload: endedPayload,
      requestId,
    });
  } else {
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
