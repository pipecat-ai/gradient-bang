import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { findShortestPath, PathNotFoundError, fetchSectorRow } from '../_shared/map.ts';
import { loadCharacter, loadShip } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

class PlotCourseError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PlotCourseError';
    this.status = status;
  }
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
    console.error('plot_course.parse', err);
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
    await enforceRateLimit(supabase, characterId, 'plot_course');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'plot_course',
        requestId,
        detail: 'Too many plot_course requests',
        status: 429,
      });
      return errorResponse('Too many plot_course requests', 429);
    }
    console.error('plot_course.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handlePlotCourse(supabase, payload, characterId, requestId, adminOverride, actorCharacterId);
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'plot_course',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof PlotCourseError || err instanceof PathNotFoundError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'plot_course',
        requestId,
        detail: err.message,
        status: err instanceof PlotCourseError ? err.status : 400,
      });
      return errorResponse(err.message, err instanceof PlotCourseError ? err.status : 400);
    }
    console.error('plot_course.unhandled', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'plot_course',
      requestId,
      detail: 'internal server error',
      status: 500,
    });
    return errorResponse('internal server error', 500);
  }
});

async function handlePlotCourse(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
  adminOverride: boolean,
  actorCharacterId: string | null,
): Promise<Response> {
  const source = buildEventSource('plot_course', requestId);

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  if (ship.current_sector === null || ship.current_sector === undefined) {
    throw new PlotCourseError('Ship sector is unavailable', 500);
  }

  let fromSector = optionalNumber(payload, 'from_sector');
  if (fromSector === null) {
    fromSector = ship.current_sector;
  }
  if (fromSector === null || !Number.isInteger(fromSector) || fromSector < 0) {
    throw new PlotCourseError('Invalid from_sector', 400);
  }

  let toSector = optionalNumber(payload, 'to_sector');
  if (toSector === null || !Number.isInteger(toSector) || toSector < 0) {
    throw new PlotCourseError('Missing or invalid to_sector', 400);
  }
  toSector = Math.floor(toSector);

  if (!adminOverride && fromSector !== ship.current_sector) {
    throw new PlotCourseError('from_sector must match your current sector', 403);
  }

  const destinationRow = await fetchSectorRow(supabase, toSector);
  if (!destinationRow) {
    throw new PlotCourseError(`Invalid to_sector: ${toSector}`, 400);
  }

  const { path, distance } = await findShortestPath(supabase, {
    fromSector,
    toSector,
  });

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'course.plot',
    payload: {
      source,
      from_sector: fromSector,
      to_sector: toSector,
      path,
      distance,
    },
    sectorId: ship.current_sector ?? undefined,
    requestId,
  });

  return successResponse({
    request_id: requestId,
    from_sector: fromSector,
    to_sector: toSector,
    path,
    distance,
  });
}
