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
  emitSectorEnvelope,
} from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import { buildLocalMapRegion, normalizeMapKnowledge } from "../_shared/map.ts";
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

const DEFAULT_MAX_HOPS = 3;
const DEFAULT_MAX_SECTORS = 100;

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
    console.error("local_map_region.parse", err);
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
    await enforceRateLimit(supabase, characterId, "local_map_region");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "local_map_region",
        requestId,
        detail: "Too many local_map_region requests",
        status: 429,
      });
      return errorResponse("Too many local_map_region requests", 429);
    }
    console.error("local_map_region.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    return await handleLocalMapRegion(
      supabase,
      payload,
      characterId,
      requestId,
      actorCharacterId,
      adminOverride,
      taskId
    );
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "local_map_region",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof LocalMapRegionError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "local_map_region",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("local_map_region.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "local_map_region",
      requestId,
      detail: "internal server error",
      status: 500,
    });
    return errorResponse("internal server error", 500);
  }
});

class LocalMapRegionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "LocalMapRegionError";
    this.status = status;
  }
}

async function handleLocalMapRegion(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
  taskId: string | null
): Promise<Response> {
  const source = buildEventSource("local_map_region", requestId);
  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  const knowledge = normalizeMapKnowledge(character.map_knowledge);

  let centerSector = optionalNumber(payload, "center_sector");
  if (centerSector === null) {
    centerSector = ship.current_sector ?? knowledge.current_sector ?? 0;
  }
  if (centerSector === null) {
    throw new LocalMapRegionError("Center sector could not be determined", 400);
  }

  if (!knowledge.sectors_visited[String(centerSector)]) {
    throw new LocalMapRegionError(
      `Center sector ${centerSector} must be a visited sector`,
      400
    );
  }

  let maxHops = optionalNumber(payload, "max_hops");
  if (maxHops === null) {
    maxHops = DEFAULT_MAX_HOPS;
  }
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > 100) {
    throw new LocalMapRegionError(
      "max_hops must be an integer between 0 and 100",
      400
    );
  }

  let maxSectors = optionalNumber(payload, "max_sectors");
  if (maxSectors === null) {
    maxSectors = DEFAULT_MAX_SECTORS;
  }
  if (!Number.isInteger(maxSectors) || maxSectors <= 0) {
    throw new LocalMapRegionError(
      "max_sectors must be a positive integer",
      400
    );
  }

  const mapRegion = await buildLocalMapRegion(supabase, {
    characterId,
    centerSector,
    mapKnowledge: knowledge,
    maxHops,
    maxSectors,
  });
  mapRegion["source"] = source;

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "map.region",
    payload: mapRegion,
    sectorId: centerSector,
    requestId,
    taskId,
    corpId: character.corporation_id,
  });

  await emitSectorEnvelope({
    supabase,
    sectorId: centerSector,
    eventType: "map.region",
    payload: mapRegion,
    requestId,
  });

  return successResponse({ request_id: requestId });
}
