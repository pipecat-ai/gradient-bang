import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

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
import { loadCharacter } from '../_shared/status.ts';
import {
  emitCorporationEvent,
  fetchCorporationMembers,
  loadCorporationById,
  upsertCorporationMembership,
} from '../_shared/corporations.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';

class CorporationJoinError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CorporationJoinError';
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
    console.error('corporation_join.parse', err);
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
  const corpId = requireString(payload, 'corp_id');
  const inviteCode = requireString(payload, 'invite_code');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const taskId = optionalString(payload, 'task_id');
  ensureActorMatches(actorCharacterId, characterId);

  try {
    await enforceRateLimit(supabase, characterId, 'corporation_join');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'corporation_join',
        requestId,
        detail: 'Too many corporation_join requests',
        status: 429,
      });
      return errorResponse('Too many corporation requests', 429);
    }
    console.error('corporation_join.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    const result = await handleJoin({
      supabase,
      characterId,
      characterLabel,
      corpId,
      inviteCode,
      requestId,
      taskId,
    });
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationJoinError) {
      return errorResponse(err.message, err.status);
    }
    console.error('corporation_join.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function handleJoin(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  characterLabel: string;
  corpId: string;
  inviteCode: string;
  requestId: string;
  taskId: string | null;
}): Promise<Record<string, unknown>> {
  const { supabase, characterId, characterLabel, corpId, inviteCode, requestId, taskId } = params;
  const character = await loadCharacter(supabase, characterId);
  if (character.corporation_id) {
    throw new CorporationJoinError('Already in a corporation', 400);
  }

  let corporation;
  try {
    corporation = await loadCorporationById(supabase, corpId);
  } catch (err) {
    if (err instanceof Error) {
      // Handle both "Corporation not found" and "Failed to load corporation data" (invalid UUID)
      if (err.message.includes('Corporation not found') || err.message.includes('Failed to load corporation data')) {
        throw new CorporationJoinError('Corporation not found', 404);
      }
    }
    throw err;
  }
  const expectedCode = (corporation.invite_code ?? '').trim().toLowerCase();
  if (!expectedCode || expectedCode !== inviteCode.trim().toLowerCase()) {
    throw new CorporationJoinError('Invalid invite code', 400);
  }

  const timestamp = new Date().toISOString();
  const memberName = typeof character.name === 'string' && character.name.trim().length > 0
    ? character.name.trim()
    : characterId;
  await upsertCorporationMembership(supabase, corpId, characterId, timestamp);

  const { error: characterUpdateError } = await supabase
    .from('characters')
    .update({
      corporation_id: corpId,
      corporation_joined_at: timestamp,
      last_active: timestamp,
    })
    .eq('character_id', characterId);
  if (characterUpdateError) {
    console.error('corporation_join.character_update', characterUpdateError);
    throw new CorporationJoinError('Failed to update character state', 500);
  }

  const members = await fetchCorporationMembers(supabase, corpId);
  const source = buildEventSource('corporation_join', requestId);
  const eventPayload = {
    source,
    corp_id: corpId,
    name: corporation.name,
    member_id: memberName,  // Use display name for legacy compatibility
    member_name: memberName,
    member_count: members.length,
    timestamp,
  };

  await emitCorporationEvent(supabase, corpId, {
    eventType: 'corporation.member_joined',
    payload: eventPayload,
    requestId,
    memberIds: members.map((member) => member.character_id),
    taskId,
  });

  return {
    corp_id: corpId,
    name: corporation.name,
    member_count: members.length,
  };
}

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationJoinError('actor_character_id must match character_id for corporation.join', 400);
  }
}
