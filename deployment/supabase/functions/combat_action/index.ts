import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { loadCombatById, persistCombatState } from '../_shared/combat_state.ts';
import { loadCharacter, loadShip } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import { CombatantAction, CombatEncounterState, CombatantState, RoundActionState } from '../_shared/combat_types.ts';
import { getAdjacentSectors } from '../_shared/map.ts';
import { computeNextCombatDeadline, resolveEncounterRound } from '../_shared/combat_resolution.ts';

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('combat_action.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const combatId = requireString(payload, 'combat_id');
  const actionRaw = requireString(payload, 'action').toLowerCase();
  const actionCommit = optionalNumber(payload, 'commit') ?? 0;
  const roundHint = optionalNumber(payload, 'round');
  const targetId = optionalString(payload, 'target_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  try {
    await enforceRateLimit(supabase, characterId, 'combat_action');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_action',
        requestId,
        detail: 'Too many combat actions',
        status: 429,
      });
      return errorResponse('Too many combat actions', 429);
    }
    console.error('combat_action.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleCombatAction({
      supabase,
      requestId,
      characterId,
      combatId,
      actionRaw,
      commit: actionCommit,
      roundHint,
      targetId,
      payload,
      actorCharacterId,
      adminOverride,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_action',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('combat_action.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : 'combat action failed';
    await emitErrorEvent(supabase, {
      characterId,
      method: 'combat_action',
      requestId,
      detail: message,
      status,
    });
    return errorResponse(message, status);
  }
});

async function handleCombatAction(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  combatId: string;
  actionRaw: string;
  commit: number;
  roundHint: number | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  actorCharacterId: string | null;
  adminOverride: boolean;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    combatId,
    actionRaw,
    commit,
    roundHint,
    targetId,
    payload,
    actorCharacterId,
    adminOverride,
  } = params;

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  const encounter = await loadCombatById(supabase, combatId);
  if (!encounter || encounter.ended) {
    const err = new Error('Combat encounter not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  // Validate round hint if provided
  if (roundHint !== null && encounter.round !== roundHint) {
    const err = new Error('Round mismatch for action submission') as Error & { status?: number };
    err.status = 409;
    throw err;
  }

  const participant = encounter.participants[characterId];
  if (!participant || participant.combatant_type !== 'character') {
    const err = new Error('Character not part of this combat') as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  const action = normalizeAction(actionRaw);
  if (participant.is_escape_pod && action === 'flee') {
    const err = new Error('Escape pods cannot flee') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const validated = await buildActionState({
    supabase,
    encounter,
    participant,
    action,
    commit,
    targetId,
    payload,
  });
  encounter.pending_actions[characterId] = validated;
  encounter.awaiting_resolution = true;

  const ready = isRoundReady(encounter);
  const now = Date.now();
  let deadlineReached = false;
  if (encounter.deadline) {
    const deadlineMs = Date.parse(encounter.deadline);
    deadlineReached = Number.isFinite(deadlineMs) && now >= deadlineMs;
  }

  console.log('combat_action.round_check', {
    combat_id: encounter.combat_id,
    round: encounter.round,
    ready,
    deadlineReached,
    participants: Object.keys(encounter.participants).length,
    pending_actions: Object.keys(encounter.pending_actions).length,
    participant_details: Object.entries(encounter.participants).map(([pid, p]) => ({
      pid,
      type: p.combatant_type,
      fighters: p.fighters,
      is_escape_pod: p.is_escape_pod,
      has_action: pid in encounter.pending_actions,
    })),
  });

  if (ready || deadlineReached) {
    console.log('combat_action.resolving_round', { combat_id: encounter.combat_id, round: encounter.round });
    await resolveEncounterRound({
      supabase,
      encounter,
      requestId,
      source: 'combat.action',
    });
  } else {
    encounter.deadline = encounter.deadline ?? computeNextCombatDeadline();
    await persistCombatState(supabase, encounter);
  }

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'combat.action_accepted',
    payload: {
      combat_id: encounter.combat_id,
      round: encounter.round,
      action: actionRaw,
      commit,
      target_id: targetId,
      source: buildEventSource('combat.action', requestId),
    },
    sectorId: encounter.sector_id,
    requestId,
  });

  return successResponse({ success: true, combat_id: encounter.combat_id });
}

function normalizeAction(value: string): CombatantAction {
  const normalized = value.toLowerCase();
  if (normalized === 'attack' || normalized === 'brace' || normalized === 'flee' || normalized === 'pay') {
    return normalized;
  }
  const err = new Error(`Unknown combat action: ${value}`) as Error & { status?: number };
  err.status = 400;
  throw err;
}

async function buildActionState(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  encounter: CombatEncounterState;
  participant: CombatantState;
  action: CombatantAction;
  commit: number;
  targetId: string | null;
  payload: Record<string, unknown>;
}): Promise<RoundActionState> {
  const { encounter, participant, action } = params;
  let commit = Math.max(0, params.commit);
  let targetId = params.targetId;
  let destinationSector: number | null = null;

  if (action === 'attack') {
    if (participant.fighters <= 0) {
      const err = new Error('No fighters available for attack') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    if (!targetId) {
      const err = new Error('Missing target_id for attack') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    if (targetId === participant.combatant_id || !encounter.participants[targetId]) {
      const err = new Error('Target combatant not found in encounter') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    commit = Math.max(1, Math.min(commit || participant.fighters, participant.fighters));
  } else if (action === 'flee') {
    // Accept both 'to_sector' (client library) and 'destination_sector' (legacy)
    const destination = optionalNumber(params.payload, 'to_sector') ?? optionalNumber(params.payload, 'destination_sector');
    if (destination === null || Number.isNaN(destination)) {
      const err = new Error('to_sector is required for flee') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    destinationSector = destination;
    const adjacent = await getAdjacentSectors(params.supabase, params.encounter.sector_id);
    if (!adjacent.includes(destinationSector)) {
      const err = new Error(`Sector ${destinationSector} is not adjacent`) as Error & { status?: number };
      err.status = 400;
      throw err;
    }
  } else if (action === 'pay') {
    // Process toll payment
    const success = await processTollPayment(
      params.supabase,
      params.encounter,
      participant.combatant_id,
      targetId,
    );
    if (!success) {
      const err = new Error('Toll payment failed - no toll garrison found or insufficient credits') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    commit = 0;
  } else {
    commit = 0;
    targetId = null;
  }

  return {
    action,
    commit,
    timed_out: false,
    target_id: targetId,
    destination_sector: destinationSector,
    submitted_at: new Date().toISOString(),
  };
}

function isRoundReady(encounter: CombatEncounterState): boolean {
  for (const [pid, participant] of Object.entries(encounter.participants)) {
    if (participant.combatant_type === 'garrison') {
      continue;
    }
    // Skip escape pods - they cannot participate in combat
    if (participant.is_escape_pod) {
      continue;
    }
    const remaining = encounter.pending_actions[pid];
    const fighters = participant.fighters ?? 0;
    if (!remaining && fighters > 0) {
      return false;
    }
  }
  return true;
}

async function processTollPayment(
  supabase: ReturnType<typeof createServiceRoleClient>,
  encounter: CombatEncounterState,
  payerId: string,
  targetId: string | null,
): Promise<boolean> {
  try {
    // Check if there's a toll registry in the context
    const context = encounter.context as Record<string, unknown> | undefined;
    if (!context) {
      return false;
    }
    const tollRegistry = context.toll_registry as Record<string, unknown> | undefined;
    if (!tollRegistry) {
      return false;
    }

    // Find the garrison to pay
    let garrisonId: string | null = null;
    if (targetId && targetId in tollRegistry) {
      garrisonId = targetId;
    } else {
      // If no target specified, find the first garrison
      for (const gid of Object.keys(tollRegistry)) {
        garrisonId = gid;
        break;
      }
    }

    if (!garrisonId) {
      return false;
    }

    const entry = tollRegistry[garrisonId] as Record<string, unknown>;
    if (!entry) {
      return false;
    }

    const amount = typeof entry.toll_amount === 'number' ? entry.toll_amount : 0;

    // Deduct credits from payer if amount > 0
    if (amount > 0) {
      // Get payer's ship
      const participant = encounter.participants[payerId];
      if (!participant || participant.combatant_type !== 'character') {
        return false;
      }

      // Load character to get their ship_id
      const { data: characterData, error: characterError } = await supabase
        .from('characters')
        .select('current_ship_id')
        .eq('character_id', payerId)
        .single();

      if (characterError || !characterData) {
        return false;
      }

      const shipId = characterData.current_ship_id;

      // Get the ship from database to check/deduct credits
      const { data: shipData, error: shipError } = await supabase
        .from('ship_instances')
        .select('credits, ship_id')
        .eq('ship_id', shipId)
        .single();

      if (shipError || !shipData) {
        return false;
      }

      const currentCredits = shipData.credits ?? 0;

      if (currentCredits < amount) {
        return false; // Insufficient credits
      }

      // Deduct credits
      const { error: updateError } = await supabase
        .from('ship_instances')
        .update({ credits: currentCredits - amount })
        .eq('ship_id', shipId);

      if (updateError) {
        return false;
      }
    }

    // Mark as paid
    entry.paid = true;
    entry.paid_round = encounter.round;
    const currentBalance = typeof entry.toll_balance === 'number' ? entry.toll_balance : 0;
    entry.toll_balance = currentBalance + amount;

    // Record the payment
    const payments = entry.payments as Array<unknown> | undefined;
    if (Array.isArray(payments)) {
      payments.push({
        payer: payerId,
        amount: amount,
        round: encounter.round,
      });
    } else {
      entry.payments = [{
        payer: payerId,
        amount: amount,
        round: encounter.round,
      }];
    }

    // Keep garrison source metadata in sync
    const sources = context.garrison_sources as Array<Record<string, unknown>> | undefined;
    const ownerId = typeof entry.owner_id === 'string' ? entry.owner_id : null;
    if (Array.isArray(sources) && ownerId) {
      for (const source of sources) {
        if (source.owner_id === ownerId) {
          source.toll_balance = entry.toll_balance;
        }
      }
    }

    // Update the garrison row in the database with the toll balance
    if (ownerId) {
      const { error: garrisonUpdateError } = await supabase
        .from('garrisons')
        .update({
          toll_balance: entry.toll_balance,
          updated_at: new Date().toISOString(),
        })
        .eq('sector_id', encounter.sector_id)
        .eq('owner_id', ownerId);

      if (garrisonUpdateError) {
        // Don't fail the payment if garrison update fails - the toll_registry is authoritative
        console.error('processTollPayment.garrison_update', garrisonUpdateError);
      }
    }

    return true;
  } catch (err) {
    console.error('processTollPayment.exception', err);
    return false;
  }
}
