import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { buildStatusPayload } from '../_shared/status.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

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
  const characterId = requireString(payload, 'character_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  if (actorCharacterId && actorCharacterId !== characterId && !adminOverride) {
    return errorResponse('actor_character_id must match character_id unless admin_override is true', 403);
  }

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
    const character = await loadCharacterCore(supabase, characterId);
    const ship = await loadShipCore(supabase, character.current_ship_id);

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
    if (isNotFoundError(err)) {
      return errorResponse('character not found', 404);
    }
    console.error('my_status.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function loadCharacterCore(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
): Promise<{ character_id: string; current_ship_id: string }>
{
  const { data, error } = await supabase
    .from('characters')
    .select('character_id, current_ship_id')
    .eq('character_id', characterId)
    .maybeSingle();
  if (error) {
    console.error('my_status.character', error);
    throw error;
  }
  if (!data) {
    throw new Error('character not found');
  }
  if (!data.current_ship_id) {
    throw new Error('character missing ship');
  }
  return data as { character_id: string; current_ship_id: string };
}

async function loadShipCore(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipId: string,
): Promise<{ ship_id: string; current_sector: number | null; in_hyperspace: boolean }>
{
  const { data, error } = await supabase
    .from('ship_instances')
    .select('ship_id, current_sector, in_hyperspace')
    .eq('ship_id', shipId)
    .maybeSingle();
  if (error) {
    console.error('my_status.ship', error);
    throw error;
  }
  if (!data) {
    throw new Error('ship not found');
  }
  return data as { ship_id: string; current_sector: number | null; in_hyperspace: boolean };
}

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /not found/i.test(err.message ?? '');
}
