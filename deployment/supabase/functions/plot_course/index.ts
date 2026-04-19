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
  fetchSectorRow,
  loadMapKnowledge,
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
import { acquirePgClient } from "../_shared/pg.ts";
import { resolveSectorParam } from "../_shared/pg_queries.ts";
import { traced } from "../_shared/weave.ts";
import type { WeaveSpan } from "../_shared/weave.ts";

class PlotCourseError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PlotCourseError";
    this.status = status;
  }
}

Deno.serve(traced("plot_course", async (req, trace) => {
  const sAuth = trace.span("auth_check");
  if (!validateApiToken(req)) {
    sAuth.end({ error: "unauthorized" });
    return unauthorizedResponse();
  }
  sAuth.end();

  const supabase = createServiceRoleClient();
  const pgClient = await acquirePgClient();
  let payload: Record<string, unknown>;
  const sParse = trace.span("parse_request");
  try {
    payload = await parseJsonRequest(req);
    sParse.end();
  } catch (err) {
    sParse.end({ error: err instanceof Error ? err.message : String(err) });
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("plot_course.parse", err);
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

  trace.setInput({
    characterId,
    actorCharacterId,
    adminOverride,
    taskId,
    from_sector: payload.from_sector ?? null,
    to_sector: payload.to_sector ?? null,
    requestId,
  });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "plot_course");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: "rate_limited" });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "plot_course",
        requestId,
        detail: "Too many plot_course requests",
        status: 429,
      });
      return errorResponse("Too many plot_course requests", 429);
    }
    console.error("plot_course.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const sHandlePlotCourse = trace.span("handle_plot_course", { characterId });
    const result = await handlePlotCourse(
      supabase,
      pgClient,
      payload,
      characterId,
      requestId,
      adminOverride,
      actorCharacterId,
      taskId,
      sHandlePlotCourse,
    );
    sHandlePlotCourse.end();
    trace.setOutput({ request_id: requestId, characterId });
    return result;
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "plot_course",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof PlotCourseError || err instanceof PathNotFoundError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "plot_course",
        requestId,
        detail: err.message,
        status: err instanceof PlotCourseError ? err.status : 400,
      });
      return errorResponse(
        err.message,
        err instanceof PlotCourseError ? err.status : 400,
      );
    }
    console.error("plot_course.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "plot_course",
      requestId,
      detail: "internal server error",
      status: 500,
    });
    return errorResponse("internal server error", 500);
  } finally {
    pgClient.release();
  }
}));

async function handlePlotCourse(
  supabase: ReturnType<typeof createServiceRoleClient>,
  pgClient: Awaited<ReturnType<typeof acquirePgClient>>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
  adminOverride: boolean,
  actorCharacterId: string | null,
  taskId: string | null,
  ws: WeaveSpan,
): Promise<Response> {
  const source = buildEventSource("plot_course", requestId);

  const sLoadChar = ws.span("load_character", { characterId });
  const character = await loadCharacter(supabase, characterId);
  sLoadChar.end({ name: character.name });

  const sLoadShip = ws.span("load_ship", { shipId: character.current_ship_id });
  const ship = await loadShip(supabase, character.current_ship_id);
  sLoadShip.end({ sector: ship.current_sector });

  const sAuth = ws.span("actor_authorization");
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  sAuth.end();

  if (ship.current_sector === null || ship.current_sector === undefined) {
    throw new PlotCourseError("Ship sector is unavailable", 500);
  }

  let fromSector =
    (await resolveSectorParam(pgClient, payload, "from_sector")) ??
    ship.current_sector;
  if (fromSector === null || !Number.isInteger(fromSector) || fromSector < 0) {
    throw new PlotCourseError("Invalid from_sector", 400);
  }

  let toSector = await resolveSectorParam(pgClient, payload, "to_sector");
  if (toSector === null || !Number.isInteger(toSector) || toSector < 0) {
    throw new PlotCourseError("Missing or invalid to_sector", 400);
  }
  toSector = Math.floor(toSector);

  if (!adminOverride && fromSector !== ship.current_sector) {
    const sMapKnowledge = ws.span("load_map_knowledge", { fromSector });
    const knowledge = await loadMapKnowledge(
      supabase,
      characterId,
      actorCharacterId,
    );
    const isDiscovered = Boolean(knowledge.sectors_visited[String(fromSector)]);
    sMapKnowledge.end({ discovered: isDiscovered });
    if (!isDiscovered) {
      throw new PlotCourseError(
        "from_sector must be a sector you or your corporation have discovered",
        403,
      );
    }
  }

  const sValidateDest = ws.span("validate_destination", { toSector });
  const destinationRow = await fetchSectorRow(supabase, toSector);
  if (!destinationRow) {
    sValidateDest.end({ error: "not found" });
    throw new PlotCourseError(`Invalid to_sector: ${toSector}`, 400);
  }
  sValidateDest.end();

  const sPathfinding = ws.span("find_shortest_path", { fromSector, toSector });
  const { path, distance } = await findShortestPath(supabase, {
    fromSector,
    toSector,
  }, sPathfinding);
  sPathfinding.end({ distance, pathLength: path.length });

  const sEmitEvent = ws.span("emit_course_plot");
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "course.plot",
    payload: {
      source,
      from_sector: fromSector,
      to_sector: toSector,
      path,
      distance,
    },
    sectorId: ship.current_sector ?? undefined,
    requestId,
    taskId,
    shipId: ship.ship_id,
  });
  sEmitEvent.end();

  return successResponse({
    request_id: requestId,
    from_sector: fromSector,
    to_sector: toSector,
    path,
    distance,
  });
}
