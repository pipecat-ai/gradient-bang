import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { buildStatusPayload, loadCharacter, loadShip } from '../_shared/status.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';

const HYPERSPACE_ERROR = 'Character is in hyperspace, status unavailable until arrival';

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('my_status.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const rawCharacterId = requireString(payload, 'character_id');
  let characterId: string;
  try {
    characterId = await canonicalizeCharacterId(rawCharacterId);
  } catch (err) {
    console.error('my_status.canonicalize_character_id', err);
    return errorResponse('invalid character_id', 400);
  }

  const rawActorId = optionalString(payload, 'actor_character_id');
  let actorCharacterId: string | null = null;
  if (rawActorId) {
    try {
      actorCharacterId = await canonicalizeCharacterId(rawActorId);
    } catch (err) {
      console.error('my_status.canonicalize_actor_id', err);
      return errorResponse('invalid actor_character_id', 400);
    }
  }
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  try {
    await enforceRateLimit(supabase, characterId, 'my_status');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return errorResponse('Too many my_status requests', 429);
    }
    console.error('my_status.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    const character = await loadCharacter(supabase, characterId);
    const ship = await loadShip(supabase, character.current_ship_id);

    await ensureActorAuthorization({
      supabase,
      ship,
      characterId,
      actorCharacterId,
      adminOverride,
    });

    if (ship.in_hyperspace) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'my_status',
        requestId,
        detail: HYPERSPACE_ERROR,
        status: 409,
      });
      return errorResponse(HYPERSPACE_ERROR, 409);
    }

    const source = buildEventSource('my_status', requestId);
    const statusPayload = await buildStatusPayload(supabase, characterId);
    statusPayload['source'] = source;

    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'status.snapshot',
      payload: statusPayload,
      shipId: ship.ship_id,
      sectorId: ship.current_sector ?? null,
      requestId,
    });

    return successResponse({ request_id: requestId });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      return errorResponse(err.message, err.status);
    }
    if (isNotFoundError(err)) {
      return errorResponse('character not found', 404);
    }
    console.error('my_status.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /not found/i.test(err.message ?? '');
}
