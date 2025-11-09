import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

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
  const targetId = optionalString(payload, 'target_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  if (actorCharacterId && actorCharacterId !== characterId && !adminOverride) {
    return errorResponse('actor_character_id must match character_id unless admin_override is true', 403);
  }

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
      targetId,
      payload,
    });
  } catch (err) {
    console.error('combat_action.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    await emitErrorEvent(supabase, {
      characterId,
      method: 'combat_action',
      requestId,
      detail: err instanceof Error ? err.message : 'combat action failed',
      status,
    });
    return errorResponse('combat action error', status);
  }
});

async function handleCombatAction(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  combatId: string;
  actionRaw: string;
  commit: number;
  targetId: string | null;
  payload: Record<string, unknown>;
}): Promise<Response> {
  const { supabase, requestId, characterId, combatId, actionRaw, commit, targetId, payload } = params;
  const encounter = await loadCombatById(supabase, combatId);
  if (!encounter || encounter.ended) {
    const err = new Error('Combat encounter not found') as Error & { status?: number };
    err.status = 404;
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

  if (ready || deadlineReached) {
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
    const destination = optionalNumber(params.payload, 'destination_sector');
    if (destination === null || Number.isNaN(destination)) {
      const err = new Error('destination_sector is required for flee') as Error & { status?: number };
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
    const remaining = encounter.pending_actions[pid];
    const fighters = participant.fighters ?? 0;
    if (!remaining && fighters > 0) {
      return false;
    }
  }
  return true;
}

