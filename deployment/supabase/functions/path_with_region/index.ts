import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  findShortestPath,
  PathNotFoundError,
  loadMapKnowledge,
  buildPathRegionPayload,
} from "../_shared/map.ts";
import { loadCharacter, loadShip } from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";

class PathWithRegionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PathWithRegionError";
    this.status = status;
  }
}

const DEFAULT_REGION_HOPS = 1;
const DEFAULT_MAX_SECTORS = 200;
const MAX_ALLOWED_SECTORS = 400;

Deno.serve(async (req: Request): Promise<Response> => {
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
    console.error("path_with_region.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, "character_id");
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  try {
    await enforceRateLimit(supabase, characterId, "path_with_region");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "path_with_region",
        requestId,
        detail: "Too many path_with_region requests",
        status: 429,
      });
      return errorResponse("Too many path_with_region requests", 429);
    }
    console.error("path_with_region.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    return await handlePathWithRegion(
      supabase,
      payload,
      characterId,
      requestId,
      actorCharacterId,
      adminOverride,
      taskId,
    );
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "path_with_region",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (
      err instanceof PathWithRegionError ||
      err instanceof PathNotFoundError
    ) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "path_with_region",
        requestId,
        detail: err.message,
        status: err instanceof PathWithRegionError ? err.status : 400,
      });
      return errorResponse(
        err.message,
        err instanceof PathWithRegionError ? err.status : 400,
      );
    }
    console.error("path_with_region.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "path_with_region",
      requestId,
      detail: "internal server error",
      status: 500,
    });
    return errorResponse("internal server error", 500);
  }
});

async function handlePathWithRegion(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
  taskId: string | null,
): Promise<Response> {
  const source = buildEventSource("path_with_region", requestId);

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
    throw new PathWithRegionError("Ship sector is unavailable", 500);
  }

  let toSector = optionalNumber(payload, "to_sector");
  if (toSector === null || !Number.isInteger(toSector) || toSector < 0) {
    throw new PathWithRegionError("Missing or invalid to_sector", 400);
  }
  toSector = Math.floor(toSector);

  let regionHops = optionalNumber(payload, "region_hops");
  if (regionHops === null) {
    regionHops = DEFAULT_REGION_HOPS;
  }
  if (!Number.isInteger(regionHops) || regionHops < 0) {
    throw new PathWithRegionError(
      "region_hops must be a non-negative integer",
      400,
    );
  }

  let maxSectors = optionalNumber(payload, "max_sectors");
  if (maxSectors === null) {
    maxSectors = DEFAULT_MAX_SECTORS;
  }
  if (
    !Number.isInteger(maxSectors) ||
    maxSectors <= 0 ||
    maxSectors > MAX_ALLOWED_SECTORS
  ) {
    throw new PathWithRegionError(
      `max_sectors must be between 1 and ${MAX_ALLOWED_SECTORS}`,
      400,
    );
  }

  const pathResult = await findShortestPath(supabase, {
    fromSector: ship.current_sector,
    toSector,
  });

  const knowledge = await loadMapKnowledge(supabase, characterId);
  const regionPayload = await buildPathRegionPayload(supabase, {
    characterId,
    knowledge,
    path: pathResult.path,
    regionHops,
    maxSectors,
  });

  const payloadBody = {
    source,
    path: pathResult.path,
    distance: pathResult.distance,
    ...regionPayload,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "path.region",
    payload: payloadBody,
    requestId,
    taskId,
    shipId: ship.ship_id,
    scope: "direct",
  });

  // Path calculations are private - no sector broadcast needed

  return successResponse({ request_id: requestId });
}
