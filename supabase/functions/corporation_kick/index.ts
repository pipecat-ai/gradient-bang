import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, successResponse, errorResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { buildEventSource, emitErrorEvent } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import {
  emitCorporationEvent,
  fetchCorporationMembers,
  isActiveCorporationMember,
  loadCorporationById,
  markCorporationMembershipLeft,
} from '../_shared/corporations.ts';

class CorporationKickError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CorporationKickError';
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
    console.error('corporation_kick.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const supabase = createServiceRoleClient();
  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const targetId = requireString(payload, 'target_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  ensureActorMatches(actorCharacterId, characterId);

  if (characterId === targetId) {
    return errorResponse('Use leave to exit your corporation', 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'corporation_kick');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'corporation_kick',
        requestId,
        detail: 'Too many corporation_kick requests',
        status: 429,
      });
      return errorResponse('Too many corporation requests', 429);
    }
    console.error('corporation_kick.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    await handleKick({ supabase, characterId, targetId, requestId });
    return successResponse({ request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationKickError) {
      return errorResponse(err.message, err.status);
    }
    console.error('corporation_kick.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function handleKick(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  targetId: string;
  requestId: string;
}): Promise<void> {
  const { supabase, characterId, targetId, requestId } = params;
  const kicker = await loadCharacterSummary(supabase, characterId, 'Character not found');
  const target = await loadCharacterSummary(supabase, targetId, 'Target character not found');

  const corpId = kicker.corporation_id;
  if (!corpId) {
    throw new CorporationKickError('Not in a corporation', 400);
  }
  if (target.corporation_id !== corpId) {
    throw new CorporationKickError('Target is not in your corporation', 400);
  }

  const authorized = await isActiveCorporationMember(supabase, corpId, characterId);
  if (!authorized) {
    throw new CorporationKickError('Not authorized for this corporation', 403);
  }

  const timestamp = new Date().toISOString();
  await markCorporationMembershipLeft(supabase, corpId, targetId, timestamp);

  const { error: targetUpdateError } = await supabase
    .from('characters')
    .update({
      corporation_id: null,
      corporation_joined_at: null,
      last_active: timestamp,
    })
    .eq('character_id', targetId);
  if (targetUpdateError) {
    console.error('corporation_kick.character_update', targetUpdateError);
    throw new CorporationKickError('Failed to update target state', 500);
  }

  const corporation = await loadCorporationById(supabase, corpId);
  const remainingMembers = await fetchCorporationMembers(supabase, corpId);
  if (!remainingMembers.length) {
    throw new CorporationKickError('Unexpected empty corporation state', 500);
  }

  const source = buildEventSource('corporation_kick', requestId);
  const kickerName = typeof kicker.name === 'string' && kicker.name.trim().length > 0
    ? kicker.name
    : characterId;
  const targetName = typeof target.name === 'string' && target.name.trim().length > 0
    ? target.name
    : targetId;
  const payload = {
    source,
    corp_id: corpId,
    corp_name: corporation.name,
    kicked_member_id: targetId,
    kicked_member_name: targetName,
    kicker_id: characterId,
    kicker_name: kickerName,
    member_count: remainingMembers.length,
    timestamp,
  };

  const recipients = Array.from(
    new Set([...remainingMembers.map((member) => member.character_id), targetId]),
  );

  await emitCorporationEvent(supabase, corpId, {
    eventType: 'corporation.member_kicked',
    payload,
    requestId,
    memberIds: recipients,
  });
}

async function loadCharacterSummary(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
  notFoundMessage: string,
): Promise<{ character_id: string; name: string | null; corporation_id: string | null }> {
  const { data, error } = await supabase
    .from('characters')
    .select('character_id, name, corporation_id')
    .eq('character_id', characterId)
    .maybeSingle();
  if (error) {
    console.error('corporation_kick.character_load', error);
    throw new CorporationKickError('Failed to load character data', 500);
  }
  if (!data) {
    throw new CorporationKickError(notFoundMessage, 404);
  }
  return data as { character_id: string; name: string | null; corporation_id: string | null };
}

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationKickError('actor_character_id must match character_id for corporation.kick', 400);
  }
}
