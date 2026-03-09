import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import type { QueryClient, PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import { acquirePgClient, getCachedAdjacencies, warmupAdjacencyCache } from "../_shared/pg.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { ActorAuthorizationError } from "../_shared/actors.ts";
import { checkGarrisonAutoEngage } from "../_shared/garrison_combat.ts";
import { traced, type WeaveSpan } from "../_shared/weave.ts";
import { deserializeCombat } from "../_shared/combat_state.ts";
import {
  resolvePlayerType,
  type CharacterRow,
  type ShipRow,
  type ShipDefinitionRow,
} from "../_shared/status.ts";
import type { SectorSnapshot, MapKnowledge } from "../_shared/map.ts";
import { fetchAllAdjacencies } from "../_shared/map.ts";

// Import pg-based query functions
import {
  pgLoadCharacterContext,
  pgEnsureActorCanControlShip,
  pgLoadShip,
  pgBuildSectorSnapshot,
  pgStartHyperspace,
  pgFinishHyperspace,
  pgUpdateCharacterLastActive,
  pgBuildStatusPayload,
  pgMarkSectorVisited,
  pgBuildLocalMapRegion,
  pgEmitCharacterEvent,
  pgComputeCorpMemberRecipients,
  pgEmitMovementObservers,
  pgCheckGarrisonAutoEngage,
  pgLoadCorpName,
  RateLimitError,
  MoveError,
  type ObserverMetadata,
} from "../_shared/pg_queries.ts";

// Warm up the adjacency cache on cold start (non-blocking)
warmupAdjacencyCache(fetchAllAdjacencies);

const BASE_MOVE_DELAY = Number(
  Deno.env.get("MOVE_DELAY_SECONDS_PER_TURN") ?? 2 / 3,
);
const MOVE_DELAY_SCALE = Number(Deno.env.get("MOVE_DELAY_SCALE") ?? "1");
const MAX_LOCAL_MAP_HOPS = 4;
const MAX_LOCAL_MAP_NODES = 28;

Deno.serve(traced("move", async (req, wt) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  const pgClient = await acquirePgClient();
  const tStart = performance.now();
  const trace: Record<string, number> = {};
  const mark = (label: string) => {
    trace[label] = Math.round(performance.now() - tStart);
  };

  try {
    let payload;
    try {
      payload = await parseJsonRequest(req);
    } catch (err) {
      const response = respondWithError(err);
      if (response) {
        return response;
      }
      console.error("move.parse", err);
      return errorResponse("invalid JSON payload", 400);
    }

    if (payload.healthcheck === true) {
      return successResponse({
        status: "ok",
        token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
      });
    }

    const requestId = resolveRequestId(payload);
    const rawCharacterId = requireString(payload, "character_id");
    const characterId = await canonicalizeCharacterId(rawCharacterId);
    const actorCharacterLabel = optionalString(payload, "actor_character_id");
    const actorCharacterId = actorCharacterLabel
      ? await canonicalizeCharacterId(actorCharacterLabel)
      : null;
    const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
    const taskId = optionalString(payload, "task_id");

    let toSector = optionalNumber(payload, "to_sector");
    if (toSector === null && "to" in payload) {
      toSector = optionalNumber(payload, "to");
    }
    if (toSector === null || Number.isNaN(toSector)) {
      return errorResponse("to_sector is required", 400);
    }
    if (toSector < 0) {
      return errorResponse("to_sector must be non-negative", 400);
    }
    const destination = toSector;

    const moveContext = {
      supabase,
      pgClient,
      characterId,
      destination,
      requestId,
      actorCharacterId,
      adminOverride,
      taskId,
      trace,
      mark,
    } as const;

    const sHandleMove = wt.span("handle_move", { character_id: characterId, destination });
    const result = await handleMove({ ...moveContext, ws: sHandleMove });
    sHandleMove.end();
    return result;
  } finally {
    // pgClient may already be released by completeMovement - safe to call release() again
    pgClient.release();
  }
}));

async function handleMove({
  supabase,
  pgClient,
  characterId,
  destination,
  requestId,
  actorCharacterId,
  adminOverride,
  taskId,
  trace,
  mark,
  ws,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  pgClient: QueryClient;
  characterId: string;
  destination: number;
  requestId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
  taskId: string | null;
  trace: Record<string, number>;
  mark: (label: string) => void;
  ws: WeaveSpan;
}): Promise<Response> {
  const source = buildEventSource("move", requestId);
  let observerMetadata: ObserverMetadata;

  // Load character context (character + ship + definition + rate limit + combat) in one query
  let character: CharacterRow;
  let ship: ShipRow;
  let shipDefinition: ShipDefinitionRow;
  let combatRaw: unknown;
  const sLoadCtx = ws.span("load_character_context");
  try {
    const ctx = await pgLoadCharacterContext(pgClient, characterId, {
      endpoint: "move",
    });
    character = ctx.character;
    ship = ctx.ship;
    shipDefinition = ctx.shipDefinition;
    combatRaw = ctx.combatRaw;
    mark("load_character_context");
    sLoadCtx.end({ name: character.name, ship_id: ship.ship_id });
  } catch (err) {
    sLoadCtx.end({ error: String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "move",
        requestId,
        detail: "Too many move requests",
        status: 429,
      });
      return errorResponse("Too many move requests", 429);
    }
    console.error("move.load_state", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "move",
      requestId,
      detail: "character not found",
      status: 404,
    });
    return errorResponse("character not found", 404);
  }

  // Actor authorization check
  const sAuth = ws.span("auth");
  try {
    await ensureActorAuthorizationPg({
      pgClient,
      ship,
      actorCharacterId,
      adminOverride,
      targetCharacterId: characterId,
    });
    mark("auth");
    sAuth.end();
  } catch (err) {
    sAuth.end({ error: String(err) });
    if (err instanceof ActorAuthorizationError) {
      console.warn("move.authorization", err.message);
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  if (ship.in_hyperspace) {
    // Check if hyperspace ETA has passed - if so, recover by completing the stuck move
    const now = Date.now();
    const eta = ship.hyperspace_eta ? new Date(ship.hyperspace_eta).getTime() : null;
    const stuckThresholdMs = 20_000; // 20 seconds past ETA = stuck

    if (eta && now > eta + stuckThresholdMs && ship.hyperspace_destination !== null) {
      console.warn("move.hyperspace_recovery", {
        character_id: characterId,
        ship_id: ship.ship_id,
        stuck_destination: ship.hyperspace_destination,
        eta: ship.hyperspace_eta,
        seconds_overdue: Math.round((now - eta) / 1000),
      });
      // Complete the stuck hyperspace jump before proceeding
      const sRecovery = ws.span("hyperspace_recovery", {
        stuck_destination: ship.hyperspace_destination,
        seconds_overdue: Math.round((now - eta) / 1000),
      });
      try {
        await pgFinishHyperspace(pgClient, {
          shipId: ship.ship_id,
          destination: ship.hyperspace_destination,
        });
        // Update local ship state to reflect completed jump
        ship.in_hyperspace = false;
        ship.current_sector = ship.hyperspace_destination;
        ship.hyperspace_destination = null;
        ship.hyperspace_eta = null;
        sRecovery.end();
      } catch (recoveryErr) {
        sRecovery.end({ error: String(recoveryErr) });
        console.error("move.hyperspace_recovery_failed", recoveryErr);
        await emitErrorEvent(supabase, {
          characterId,
          method: "move",
          requestId,
          detail: "Failed to recover from stuck hyperspace",
          status: 500,
        });
        return errorResponse("failed to recover from stuck hyperspace", 500);
      }
    } else {
      await emitErrorEvent(supabase, {
        characterId,
        method: "move",
        requestId,
        detail: "Character is already in hyperspace",
        status: 409,
      });
      return errorResponse("character already in hyperspace", 409);
    }
  }

  if (ship.current_sector === null) {
    return errorResponse("Character ship missing sector", 500);
  }

  // Combat check (already loaded via context CTE)
  if (combatRaw) {
    const combat = deserializeCombat({
      ...(combatRaw as Record<string, unknown>),
      sector_id: ship.current_sector,
    });
    if (combat && !combat.ended) {
      if (characterId in combat.participants) {
        await emitErrorEvent(supabase, {
          characterId,
          method: "move",
          requestId,
          detail: "Cannot move while in combat",
          status: 409,
        });
        return errorResponse("cannot move while in combat", 409);
      }
    }
  }

  // Get adjacencies from cache (no DB query)
  const adjacencyMap = await getCachedAdjacencies(fetchAllAdjacencies);
  const adjacent = adjacencyMap.get(ship.current_sector) ?? [];

  const observerCorpId =
    ship.owner_type === "corporation"
      ? ship.owner_corporation_id
      : character.corporation_id;
  const observerCorpName = await pgLoadCorpName(pgClient, observerCorpId);
  observerMetadata = {
    characterId: character.character_id,
    characterName: character.name,
    shipId: ship.ship_id,
    shipName: ship.ship_name?.trim() || shipDefinition.display_name,
    shipType: ship.ship_type,
    corpId: observerCorpId,
    playerType: resolvePlayerType(character.player_metadata),
    corpName: observerCorpName,
  };
  if (!adjacent.includes(destination)) {
    await emitErrorEvent(supabase, {
      characterId,
      method: "move",
      requestId,
      detail: `Sector ${destination} is not adjacent to current sector ${ship.current_sector}`,
      status: 400,
    });
    return errorResponse(
      `Sector ${destination} is not adjacent to current sector ${ship.current_sector}`,
      400,
    );
  }

  const warpCost = shipDefinition.turns_per_warp;
  if (ship.current_warp_power < warpCost) {
    await emitErrorEvent(supabase, {
      characterId,
      method: "move",
      requestId,
      detail: `Insufficient warp power. Need ${warpCost}`,
      status: 400,
    });
    return errorResponse(
      `Insufficient warp power. Need ${warpCost} units but only have ${ship.current_warp_power}`,
      400,
    );
  }

  const hyperspaceSeconds = Math.max(
    warpCost * BASE_MOVE_DELAY * Math.max(MOVE_DELAY_SCALE, 0),
    0,
  );
  const hyperspaceEta = new Date(
    Date.now() + hyperspaceSeconds * 1000,
  ).toISOString();
  let enteredHyperspace = false;

  try {
    // All five operations are independent except emit_movement_start which
    // needs the destination snapshot. Chain that dependency and run everything
    // else in parallel.
    const sParallel = ws.span("hyperspace_parallel");
    const sStartHyper = sParallel.span("start_hyperspace");
    const sUpdateActive = sParallel.span("update_last_active");
    const sDestSnap = sParallel.span("build_destination_snapshot");
    const sEmitDepart = sParallel.span("emit_depart_observers");

    const [, , destinationSnapshot] = await Promise.all([
      pgStartHyperspace(pgClient, {
        shipId: ship.ship_id,
        currentSector: ship.current_sector,
        destination,
        eta: hyperspaceEta,
        newWarpTotal: ship.current_warp_power - warpCost,
      }).then(() => { mark("start_hyperspace"); sStartHyper.end(); }),

      pgUpdateCharacterLastActive(pgClient, characterId)
        .then(() => { mark("update_last_active"); sUpdateActive.end(); }),

      // Build snapshot then emit movement.start (chained dependency).
      // Returns the snapshot for use by completeMovement.
      pgBuildSectorSnapshot(pgClient, destination, characterId)
        .then((snapshot) => {
          mark("build_destination_snapshot");
          sDestSnap.end();
          const sEmitStart = sParallel.span("emit_movement_start");
          return pgEmitCharacterEvent({
            pg: pgClient,
            characterId,
            eventType: "movement.start",
            payload: {
              source,
              sector: snapshot,
              hyperspace_time: hyperspaceSeconds,
              player: {
                id: character.character_id,
                name: character.name,
              },
            },
            shipId: ship.ship_id,
            sectorId: ship.current_sector,
            requestId,
            taskId,
            corpId: observerCorpId,
          }).then(() => { mark("emit_movement_start"); sEmitStart.end(); return snapshot; });
        }),

      pgEmitMovementObservers({
        pg: pgClient,
        sectorId: ship.current_sector,
        metadata: observerMetadata,
        movement: "depart",
        source,
        requestId,
      }).then(() => sEmitDepart.end()),
    ]);
    sParallel.end();
    enteredHyperspace = true;

    const sComplete = ws.span("complete_movement");
    await completeMovement({
      supabase,
      pgClient,
      character,
      ship,
      shipDefinition,
      characterId,
      shipId: ship.ship_id,
      destination,
      requestId,
      taskId,
      source,
      hyperspaceSeconds,
      destinationSnapshot,
      observerMetadata,
      trace,
      mark,
      ws: sComplete,
    });
    sComplete.end();

    enteredHyperspace = false;

    return successResponse({ request_id: requestId });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "move",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("move.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "move",
      requestId,
      detail: err instanceof MoveError ? err.message : "internal server error",
      status: err instanceof MoveError ? err.status : 500,
    });
    if (err instanceof MoveError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponse("internal server error", 500);
  } finally {
    if (enteredHyperspace) {
      // Original pgClient may have been released during completeMovement,
      // so we need a fresh connection from the pool for cleanup
      let cleanupPg;
      try {
        cleanupPg = await acquirePgClient();
        await pgFinishHyperspace(cleanupPg, {
          shipId: ship.ship_id,
          destination: ship.current_sector ?? 0,
        });
      } catch (cleanupErr) {
        console.error("move.cleanup_hyperspace", cleanupErr);
      } finally {
        cleanupPg?.release();
      }
    }
  }
}

// pg-based actor authorization helper
async function ensureActorAuthorizationPg({
  pgClient,
  ship,
  actorCharacterId,
  adminOverride,
  targetCharacterId,
  requireActorForCorporationShip = true,
}: {
  pgClient: QueryClient;
  ship: ShipRow | null;
  actorCharacterId: string | null;
  adminOverride: boolean;
  targetCharacterId?: string | null;
  requireActorForCorporationShip?: boolean;
}): Promise<void> {
  if (adminOverride) {
    return;
  }

  if (!ship) {
    if (
      actorCharacterId &&
      targetCharacterId &&
      actorCharacterId !== targetCharacterId
    ) {
      throw new ActorAuthorizationError(
        "actor_character_id must match character_id unless admin_override is true",
        403,
      );
    }
    return;
  }

  const resolvedTargetId =
    targetCharacterId ??
    ship.owner_character_id ??
    ship.owner_id ??
    ship.ship_id;

  if (ship.owner_type === "corporation") {
    if (requireActorForCorporationShip && !actorCharacterId) {
      throw new ActorAuthorizationError(
        "actor_character_id is required when controlling a corporation ship",
        400,
      );
    }
    if (!ship.owner_corporation_id) {
      throw new ActorAuthorizationError(
        "Corporation ship is missing ownership data",
        403,
      );
    }
    if (!actorCharacterId) {
      return;
    }
    const allowed = await pgEnsureActorCanControlShip(
      pgClient,
      actorCharacterId,
      ship.owner_corporation_id,
    );
    if (!allowed) {
      throw new ActorAuthorizationError(
        "Actor is not authorized to control this corporation ship",
        403,
      );
    }
    return;
  }

  if (actorCharacterId && actorCharacterId !== resolvedTargetId) {
    throw new ActorAuthorizationError(
      "actor_character_id must match character_id unless admin_override is true",
      403,
    );
  }
}

async function completeMovement({
  supabase,
  pgClient,
  character,
  ship,
  shipDefinition,
  characterId,
  shipId,
  destination,
  requestId,
  taskId,
  source,
  hyperspaceSeconds,
  destinationSnapshot,
  observerMetadata,
  trace,
  mark,
  ws,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  pgClient: PoolClient;
  character: CharacterRow;
  ship: ShipRow;
  shipDefinition: ShipDefinitionRow;
  characterId: string;
  shipId: string;
  destination: number;
  requestId: string;
  taskId: string | null;
  source: ReturnType<typeof buildEventSource>;
  hyperspaceSeconds: number;
  destinationSnapshot: SectorSnapshot;
  observerMetadata: ObserverMetadata;
  trace: Record<string, number>;
  mark: (label: string) => void;
  ws: WeaveSpan;
}): Promise<void> {
  const corpId =
    ship.owner_type === "corporation"
      ? ship.owner_corporation_id
      : character.corporation_id;
  // Release the connection back to the pool BEFORE the delay.
  // This is critical for connection pool efficiency under concurrent load.
  pgClient.release();
  mark("pg_release_for_delay");

  const sDelay = ws.span("hyperspace_delay", { seconds: hyperspaceSeconds });
  if (hyperspaceSeconds > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, hyperspaceSeconds * 1000),
    );
  }
  mark("delay_done");
  sDelay.end();

  // Reacquire from pool AFTER the delay to complete the move
  const pg = await acquirePgClient();
  try {
    mark("pg_reacquire");

    // Parallelize independent writes: finish hyperspace + update last active
    const sFinishHyper = ws.span("finish_hyperspace");
    const sUpdateActive = ws.span("update_last_active");
    await Promise.all([
      pgFinishHyperspace(pg, { shipId, destination }).then(() => {
        mark("finish_hyperspace");
        sFinishHyper.end();
      }),
      pgUpdateCharacterLastActive(pg, characterId).then(() => {
        mark("update_character_last_active");
        sUpdateActive.end();
      }),
    ]);

    // Re-load ship to get updated warp_power after move, but reuse character and definition
    const sLoadUpdatedShip = ws.span("load_updated_ship");
    const updatedShip = await pgLoadShip(pg, shipId);
    // Update ship's current_sector to destination for status payload
    updatedShip.current_sector = destination;
    sLoadUpdatedShip.end();

    const sBuildStatus = ws.span("build_status_payload");
    const statusPayload = await pgBuildStatusPayload(pg, characterId, {
      character,
      ship: updatedShip,
      shipDefinition,
      sectorSnapshot: destinationSnapshot,
    });
    mark("build_status_complete");
    sBuildStatus.end();

    // Mark sector visited (updates personal or corp knowledge depending on player type)
    // Pass pre-loaded player_metadata and corporation_id to avoid re-querying
    // Returns mergedKnowledge (personal + corp) to avoid a separate pgLoadMapKnowledge call
    const sMarkVisited = ws.span("mark_sector_visited");
    const { firstPersonalVisit, knownToCorp, mergedKnowledge } = await pgMarkSectorVisited(pg, {
      characterId,
      sectorId: destination,
      sectorSnapshot: destinationSnapshot,
      playerMetadata: character.player_metadata,
      corporationId: character.corporation_id,
    });
    mark("mark_sector_visited");
    sMarkVisited.end();

    const sectorPayload = statusPayload.sector as Record<string, unknown>;
    const portPayload = sectorPayload?.port as Record<string, unknown> | null;

    const movementCompletePayload = {
      source,
      player: statusPayload.player,
      ship: statusPayload.ship,
      sector: sectorPayload,
      first_visit: firstPersonalVisit,
      known_to_corp: knownToCorp,
      has_megaport: portPayload?.mega === true,
    } as Record<string, unknown>;

    const sEmitComplete = ws.span("emit_movement_complete");
    await pgEmitCharacterEvent({
      pg,
      characterId,
      eventType: "movement.complete",
      payload: movementCompletePayload,
      shipId,
      sectorId: destination,
      requestId,
      taskId,
      corpId,
    });
    mark("emit_movement_complete");
    sEmitComplete.end();

    const sBuildMap = ws.span("build_local_map");
    const mapRegion = await pgBuildLocalMapRegion(pg, {
      characterId,
      centerSector: destination,
      mapKnowledge: mergedKnowledge,
      maxHops: MAX_LOCAL_MAP_HOPS,
      maxSectors: MAX_LOCAL_MAP_NODES,
    });
    mark("build_local_map");
    sBuildMap.end();
    (mapRegion as Record<string, unknown>)["source"] = source;

    if (firstPersonalVisit && !knownToCorp) {
      const sCorpMapUpdate = ws.span("corp_map_update");

      const sBuildUpdateRegion = sCorpMapUpdate.span("build_map_update_region");
      const mapUpdateRegion = await pgBuildLocalMapRegion(pg, {
        characterId,
        centerSector: destination,
        mapKnowledge: mergedKnowledge,
        maxHops: 1,
        maxSectors: MAX_LOCAL_MAP_NODES,
      });
      mark("build_map_update_region");
      sBuildUpdateRegion.end();

      const sCorpRecipients = sCorpMapUpdate.span("compute_corp_recipients");
      const mapUpdateRecipients = corpId
        ? await pgComputeCorpMemberRecipients(pg, [corpId], [characterId])
        : [];
      sCorpRecipients.end();

      const mapUpdatePayload: Record<string, unknown> = {
        center_sector: mapUpdateRegion.center_sector,
        sectors: mapUpdateRegion.sectors,
        total_sectors: mapUpdateRegion.total_sectors,
        total_visited: mapUpdateRegion.total_visited,
        total_unvisited: mapUpdateRegion.total_unvisited,
        source,
      };
      const sEmitMapUpdate = sCorpMapUpdate.span("emit_map_update");
      await pgEmitCharacterEvent({
        pg,
        characterId,
        eventType: "map.update",
        payload: mapUpdatePayload,
        sectorId: destination,
        requestId,
        taskId,
        corpId: character.corporation_id,
        additionalRecipients: mapUpdateRecipients,
      });
      mark("emit_map_update");
      sEmitMapUpdate.end();

      sCorpMapUpdate.end();
    }

    const sEmitMapLocal = ws.span("emit_map_local");
    await pgEmitCharacterEvent({
      pg,
      characterId,
      eventType: "map.local",
      payload: mapRegion as Record<string, unknown>,
      sectorId: destination,
      requestId,
      taskId,
      corpId: character.corporation_id,
    });
    mark("emit_map_local");
    sEmitMapLocal.end();

    // For arrival events, include corp visibility if it's a corp ship
    const corpIds =
      ship.owner_type === "corporation" && ship.owner_corporation_id
        ? [ship.owner_corporation_id]
        : [];

    const sEmitArrive = ws.span("emit_arrive_observers");
    await pgEmitMovementObservers({
      pg,
      sectorId: destination,
      metadata: observerMetadata,
      movement: "arrive",
      source,
      requestId,
      corpIds, // Corp visibility for arrivals
    });
    sEmitArrive.end();

    // Check for garrison auto-combat after arrival
    // Use fast pg check first, only fall back to REST if combat initiation needed
    const sGarrison = ws.span("garrison_auto_engage");
    try {
      const needsCombat = await pgCheckGarrisonAutoEngage({
        pg,
        characterId,
        sectorId: destination,
        requestId,
        shipId,
        inHyperspace: false, // Just completed hyperspace
      });
      if (needsCombat) {
        // Combat initiation needed - use REST version for full combat setup
        // Pass pre-loaded character/ship to avoid re-fetching
        await checkGarrisonAutoEngage({
          supabase,
          characterId,
          sectorId: destination,
          requestId,
          character,
          ship: updatedShip,
        });
      }
      sGarrison.end();
    } catch (garrisonError) {
      sGarrison.end({ error: String(garrisonError) });
      // Log but don't fail the move if garrison combat fails
      console.error("move.garrison_auto_engage", garrisonError);
    }
  } catch (error) {
    console.error("move.async_completion", error);
    await emitErrorEvent(supabase, {
      characterId,
      method: "move.complete",
      requestId,
      detail:
        error instanceof Error ? error.message : "movement completion failed",
      status: 500,
    });
    throw error; // Re-throw so caller knows completion failed
  } finally {
    pg.release();
  }
}
