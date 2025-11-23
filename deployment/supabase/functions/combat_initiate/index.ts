import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, emitSectorEnvelope, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { loadCharacter, loadShip } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { loadCharacterCombatants, loadCharacterNames, loadGarrisonCombatants } from '../_shared/combat_participants.ts';
import { nowIso, CombatEncounterState } from '../_shared/combat_types.ts';
import { loadCombatForSector, persistCombatState } from '../_shared/combat_state.ts';
import { buildRoundWaitingPayload } from '../_shared/combat_events.ts';
import { computeNextCombatDeadline } from '../_shared/combat_resolution.ts';

const MIN_PARTICIPANTS = 2;

function deterministicSeed(combatId: string): number {
  const normalized = combatId.replace(/[^0-9a-f]/gi, '').slice(0, 12) || combatId;
  const parsed = Number.parseInt(normalized, 16);
  if (Number.isFinite(parsed)) {
    return parsed >>> 0;
  }
  return Math.floor(Math.random() * 1_000_000);
}

function generateCombatId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

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
    console.error('combat_initiate.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  try {
    await enforceRateLimit(supabase, characterId, 'combat_initiate');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_initiate',
        requestId,
        detail: 'Too many combat initiation requests',
        status: 429,
      });
      return errorResponse('Too many combat initiation requests', 429);
    }
    console.error('combat_initiate.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleCombatInitiate({
      supabase,
      payload,
      characterId,
      requestId,
      actorCharacterId,
      adminOverride,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_initiate',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('combat_initiate.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    const message = err instanceof Error ? err.message : 'combat initiate failed';
    await emitErrorEvent(supabase, {
      characterId,
      method: 'combat_initiate',
      requestId,
      detail: message,
      status,
    });
    return errorResponse(message, status);
  }
});

async function handleCombatInitiate(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  payload: Record<string, unknown>;
  characterId: string;
  requestId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
}): Promise<Response> {
  const { supabase, characterId, requestId, actorCharacterId, adminOverride } = params;
  const character = await loadCharacter(supabase, characterId);
  const shipId = character.current_ship_id;
  if (!shipId) {
    throw new Error('Character has no ship assigned');
  }

  const ship = await loadShip(supabase, shipId);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  if (ship.in_hyperspace) {
    throw new Error('Character is in hyperspace and cannot initiate combat');
  }
  if (ship.current_sector === null || ship.current_sector === undefined) {
    throw new Error('Character ship missing sector');
  }
  const sectorId = ship.current_sector;

  // Check initiator has fighters
  const initiatorFighters = ship.current_fighters ?? 0;
  if (initiatorFighters <= 0) {
    const err = new Error('Cannot initiate combat while you have no fighters.') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const existingEncounter = await loadCombatForSector(supabase, sectorId);
  const participantStates = await loadCharacterCombatants(supabase, sectorId);
  const ownerNames = await loadCharacterNames(
    supabase,
    participantStates.map((state) => state.owner_character_id ?? state.combatant_id),
  );
  const garrisons = await loadGarrisonCombatants(supabase, sectorId, ownerNames);

  // Get initiator's corporation membership
  const { data: initiatorCorpData } = await supabase
    .from('corporation_members')
    .select('corp_id')
    .eq('character_id', characterId)
    .is('left_at', null)
    .maybeSingle();
  const initiatorCorpId = initiatorCorpData?.corp_id ?? null;

  // Validate targetable opponents exist
  let hasTargetableOpponent = false;

  // Check characters
  for (const participant of participantStates) {
    if (participant.combatant_id === characterId) continue;
    if (participant.is_escape_pod) continue;
    if ((participant.fighters ?? 0) <= 0) continue;

    // Check if same corporation
    if (initiatorCorpId && participant.metadata?.corporation_id === initiatorCorpId) continue;

    hasTargetableOpponent = true;
    break;
  }

  // Check garrisons if no character targets
  if (!hasTargetableOpponent && garrisons.length > 0) {
    // Get corporation memberships for all garrison owners
    const garrisonOwnerIds = garrisons.map(g => g.state.owner_character_id).filter((id): id is string => Boolean(id));
    const { data: garrisonCorpData } = await supabase
      .from('corporation_members')
      .select('character_id, corp_id')
      .in('character_id', garrisonOwnerIds)
      .is('left_at', null);

    const ownerCorpMap = new Map<string, string>();
    for (const row of garrisonCorpData ?? []) {
      if (row.character_id && row.corp_id) {
        ownerCorpMap.set(row.character_id, row.corp_id);
      }
    }

    for (const garrison of garrisons) {
      const ownerId = garrison.state.owner_character_id;
      if (!ownerId || ownerId === characterId) continue;
      if ((garrison.state.fighters ?? 0) <= 0) continue;

      // Check if garrison owner is in same corporation
      const ownerCorpId = ownerCorpMap.get(ownerId);
      if (initiatorCorpId && ownerCorpId === initiatorCorpId) continue;

      hasTargetableOpponent = true;
      break;
    }
  }

  if (!hasTargetableOpponent) {
    const err = new Error('No targetable opponents available to engage') as Error & { status?: number };
    err.status = 409;
    throw err;
  }

  let encounter: CombatEncounterState;
  if (existingEncounter && !existingEncounter.ended) {
    encounter = existingEncounter;
    if (!encounter.participants[characterId]) {
      const participant = participantStates.find((state) => state.combatant_id === characterId);
      if (!participant) {
        throw new Error('Initiator not present in sector');
      }
      encounter.participants[participant.combatant_id] = participant;
    }
    if (!encounter.base_seed) {
      encounter.base_seed = deterministicSeed(encounter.combat_id);
    }
  } else {
    const participants: Record<string, CombatantState> = {};
    for (const state of participantStates) {
      participants[state.combatant_id] = state;
    }
    for (const garrison of garrisons) {
      participants[garrison.state.combatant_id] = garrison.state;
    }
    if (Object.keys(participants).length < MIN_PARTICIPANTS) {
      const err = new Error('No opponents available to engage') as Error & { status?: number };
      err.status = 409;
      throw err;
    }

    const combatId = generateCombatId();
    encounter = {
      combat_id: combatId,
      sector_id: sectorId,
      round: 1,
      deadline: computeNextCombatDeadline(),
      participants,
      pending_actions: {},
      logs: [],
      context: {
        initiator: characterId,
        created_at: nowIso(),
        garrison_sources: garrisons.map((g) => g.source),
      },
      awaiting_resolution: false,
      ended: false,
      end_state: null,
      base_seed: deterministicSeed(combatId),
      last_updated: nowIso(),
    };
  }

  await persistCombatState(supabase, encounter);
  await emitRoundWaitingEvents(supabase, encounter, requestId);

  return successResponse({
    success: true,
    combat_id: encounter.combat_id,
    sector_id: encounter.sector_id,
    round: encounter.round,
  });
}

async function emitRoundWaitingEvents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  encounter: CombatEncounterState,
  requestId: string,
): Promise<void> {
  const payload = buildRoundWaitingPayload(encounter);
  const source = buildEventSource('combat.round_waiting', requestId);
  payload.source = source;
  const senderId = typeof encounter.context?.initiator === 'string' ? encounter.context.initiator : null;

  const recipients = Object.values(encounter.participants)
    .filter((participant) => participant.combatant_type === 'character')
    .map((participant) => participant.owner_character_id ?? participant.combatant_id);

  await Promise.all(
    recipients.map((recipient) =>
      emitCharacterEvent({
        supabase,
        characterId: recipient,
        eventType: 'combat.round_waiting',
        payload,
        sectorId: encounter.sector_id,
        requestId,
        senderId,
        actorCharacterId: recipient,
      }),
    ),
  );

  await emitSectorEnvelope({
    supabase,
    sectorId: encounter.sector_id,
    eventType: 'combat.round_waiting',
    payload,
    requestId,
    senderId,
  });
}
