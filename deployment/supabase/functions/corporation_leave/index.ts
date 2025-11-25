import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, successResponse, errorResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { buildEventSource, emitCharacterEvent, emitErrorEvent } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { loadCharacter } from '../_shared/status.ts';
import {
  emitCorporationEvent,
  fetchCorporationMembers,
  fetchCorporationShipSummaries,
  isActiveCorporationMember,
  loadCorporationById,
  markCorporationMembershipLeft,
} from '../_shared/corporations.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';

class CorporationLeaveError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CorporationLeaveError';
    this.status = status;
  }
}

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('corporation_leave.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const supabase = createServiceRoleClient();
  const requestId = resolveRequestId(payload);
  const rawCharacterId = requireString(payload, 'character_id');
  const legacyCharacterLabel = optionalString(payload, '__legacy_character_label');
  const characterLabel = legacyCharacterLabel ?? rawCharacterId;
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const actorCharacterLabel = optionalString(payload, 'actor_character_id');
  const actorCharacterId = actorCharacterLabel ? await canonicalizeCharacterId(actorCharacterLabel) : null;
  ensureActorMatches(actorCharacterId, characterId);

  try {
    await enforceRateLimit(supabase, characterId, 'corporation_leave');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'corporation_leave',
        requestId,
        detail: 'Too many corporation_leave requests',
        status: 429,
      });
      return errorResponse('Too many corporation requests', 429);
    }
    console.error('corporation_leave.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    await handleLeave({ supabase, characterId, characterLabel, requestId });
    return successResponse({ request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationLeaveError) {
      return errorResponse(err.message, err.status);
    }
    console.error('corporation_leave.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function handleLeave(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  characterLabel: string;
  requestId: string;
}): Promise<void> {
  const { supabase, characterId, characterLabel, requestId } = params;
  const character = await loadCharacter(supabase, characterId);
  const corpId = character.corporation_id;
  if (!corpId) {
    throw new CorporationLeaveError('Not in a corporation', 400);
  }

  const isMember = await isActiveCorporationMember(supabase, corpId, characterId);
  if (!isMember) {
    throw new CorporationLeaveError('Not authorized for this corporation', 403);
  }

  const corporation = await loadCorporationById(supabase, corpId);
  const timestamp = new Date().toISOString();
  await markCorporationMembershipLeft(supabase, corpId, characterId, timestamp);

  const { error: characterUpdateError } = await supabase
    .from('characters')
    .update({
      corporation_id: null,
      corporation_joined_at: null,
      last_active: timestamp,
    })
    .eq('character_id', characterId);
  if (characterUpdateError) {
    console.error('corporation_leave.character_update', characterUpdateError);
    throw new CorporationLeaveError('Failed to update character state', 500);
  }

  const remainingMembers = await fetchCorporationMembers(supabase, corpId);
  if (!remainingMembers.length) {
    await handleDisband({ supabase, corpId, corporationName: corporation.name, characterId, requestId });
    return;
  }

  const source = buildEventSource('corporation_leave', requestId);
  const departedName = typeof character.name === 'string' && character.name.trim().length > 0
    ? character.name.trim()
    : characterId;
  const payload = {
    source,
    corp_id: corpId,
    corp_name: corporation.name,
    departed_member_id: departedName,  // Use display name for legacy compatibility
    departed_member_name: departedName,
    member_count: remainingMembers.length,
    timestamp,
  };

  await emitCorporationEvent(supabase, corpId, {
    eventType: 'corporation.member_left',
    payload,
    requestId,
    memberIds: remainingMembers.map((member) => member.character_id),
  });
}

async function handleDisband(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  corpId: string;
  corporationName: string;
  characterId: string;
  requestId: string;
}): Promise<void> {
  const { supabase, corpId, corporationName, characterId, requestId } = params;
  const shipSummaries = await fetchCorporationShipSummaries(supabase, corpId);
  const shipIds = shipSummaries.map((ship) => ship.ship_id);
  const timestamp = new Date().toISOString();

  if (shipIds.length) {
    const { error: shipUpdateError } = await supabase
      .from('ship_instances')
      .update({
        owner_type: 'unowned',
        owner_id: null,
        owner_character_id: null,
        owner_corporation_id: null,
        became_unowned: timestamp,
        former_owner_name: corporationName,
      })
      .in('ship_id', shipIds);
    if (shipUpdateError) {
      console.error('corporation_leave.ship_update', shipUpdateError);
      throw new CorporationLeaveError('Failed to release corporation ships', 500);
    }

    const { error: autopilotDeleteError } = await supabase
      .from('characters')
      .delete()
      .in('character_id', shipIds);
    if (autopilotDeleteError) {
      console.error('corporation_leave.ship_character_delete', autopilotDeleteError);
      throw new CorporationLeaveError('Failed to clean up corporation ship pilots', 500);
    }
  }

  // Emit events BEFORE deleting the corporation (otherwise FK constraint violation)
  const source = buildEventSource('corporation_leave', requestId);
  const disbandPayload = {
    source,
    corp_id: corpId,
    corp_name: corporationName,
    reason: 'last_member_left',
    timestamp,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'corporation.disbanded',
    payload: disbandPayload,
    requestId,
    corpId: corpId,
  });

  if (shipSummaries.length) {
    const shipsPayload = {
      source,
      corp_id: corpId,
      corp_name: corporationName,
      ships: shipSummaries.map((ship) => ({
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        sector: ship.sector,
      })),
      timestamp,
    };

    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'corporation.ships_abandoned',
      payload: shipsPayload,
      requestId,
      corpId: corpId,  // Changed from meta to corpId parameter
    });
  }

  // NULL out corp_id in events before deleting corporation (preserve event history)
  const { error: eventUpdateError } = await supabase
    .from('events')
    .update({ corp_id: null })
    .eq('corp_id', corpId);
  if (eventUpdateError) {
    console.error('corporation_leave.event_update', eventUpdateError);
    // Continue anyway - this is not critical
  }

  const { error: deleteError } = await supabase
    .from('corporations')
    .delete()
    .eq('corp_id', corpId);
  if (deleteError) {
    console.error('corporation_leave.corp_delete', deleteError);
    throw new CorporationLeaveError('Failed to disband corporation', 500);
  }
}

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationLeaveError('actor_character_id must match character_id for corporation.leave', 400);
  }
}
