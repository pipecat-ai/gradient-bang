import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import type { QueryClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { acquirePgClient, warmupAdjacencyCache } from "../_shared/pg.ts";
import {
  pgLoadCharacterContext,
  pgLoadCombatForSector,
  RateLimitError,
  pgEnsureActorAuthorization,
  pgUpdateShipState,
  pgEnsureCharacterShipLink,
  pgUpsertKnowledgeEntry,
  pgBuildStatusPayload,
  pgBuildLocalMapRegion,
  pgEmitCharacterEvent,
  pgEmitMovementObservers,
  pgLoadCorpName,
  JoinError,
  type ObserverMetadata,
} from "../_shared/pg_queries.ts";
import { buildEventSource } from "../_shared/events.ts";
import {
  deserializeCombat,
  persistCombatState,
} from "../_shared/combat_state.ts";
import { loadCharacterCombatants } from "../_shared/combat_participants.ts";
import { buildRoundWaitingPayload } from "../_shared/combat_events.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { ActorAuthorizationError } from "../_shared/actors.ts";
import { resolvePlayerType } from "../_shared/status.ts";
import { normalizeMapKnowledge, fetchAllAdjacencies, findRouteToNearest } from "../_shared/map.ts";
import { loadUniverseMeta, getMegaPortSectors } from "../_shared/fedspace.ts";
import { traced } from "../_shared/weave.ts";
import type { WeaveSpan } from "../_shared/weave.ts";

const DEFAULT_START_SECTOR = 0;

// Warm up the adjacency cache on cold start (non-blocking)
warmupAdjacencyCache(fetchAllAdjacencies);

Deno.serve(traced("join", async (req, trace) => {
  const sAuth = trace.span("auth_check");
  if (!validateApiToken(req)) {
    sAuth.end({ error: "unauthorized" });
    return unauthorizedResponse();
  }
  sAuth.end();

  let payload;
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
    console.error("join.parse", err);
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
  const sectorOverride = optionalNumber(payload, "sector");
  const creditsOverride = optionalNumber(payload, "credits");
  const rawActorCharacterId = optionalString(payload, "actor_character_id");
  let actorCharacterId: string | null = null;
  if (rawActorCharacterId) {
    try {
      actorCharacterId = await canonicalizeCharacterId(rawActorCharacterId);
    } catch (err) {
      console.error("join.canonicalize.actor", err);
      return errorResponse("invalid actor_character_id", 400);
    }
  }
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;

  trace.setInput({
    characterId,
    actorCharacterId,
    adminOverride,
    sectorOverride: sectorOverride ?? null,
    creditsOverride: creditsOverride ?? null,
    requestId,
  });

  // Supabase client for combat operations (still REST-based)
  const supabase = createServiceRoleClient();
  const pg = await acquirePgClient();

  try {
    const t0 = performance.now();

    // Load character context (character + rate limit + ship + definition + sector) in one query
    const sLoadCtx = trace.span("load_character_context", { characterId });
    let character, ship, shipDefinition, targetSector;
    try {
      const ctx = await pgLoadCharacterContext(pg, characterId, {
        endpoint: "join",
        sectorOverride,
      });
      character = ctx.character;
      ship = ctx.ship;
      shipDefinition = ctx.shipDefinition;
      targetSector = ctx.targetSector;
      sLoadCtx.end({ name: character.name, ship_id: ship.ship_id, targetSector });
    } catch (err) {
      sLoadCtx.end({ error: err instanceof Error ? err.message : String(err) });
      if (err instanceof RateLimitError) {
        return errorResponse("Too many join requests", 429);
      }
      if (err instanceof Error && err.message.includes("not found")) {
        throw new JoinError("Character is not registered", 404);
      }
      throw err;
    }
    console.log(
      `[join] pgLoadCharacterContext: ${(performance.now() - t0).toFixed(1)}ms`,
    );

    // Actor authorization using PG
    const sActorAuth = trace.span("actor_authorization");
    const t3 = performance.now();
    await pgEnsureActorAuthorization(pg, {
      ship,
      actorCharacterId,
      adminOverride,
      targetCharacterId: characterId,
    });
    sActorAuth.end();
    console.log(
      `[join] pgEnsureActorAuthorization: ${(performance.now() - t3).toFixed(1)}ms`,
    );

    const previousSector = ship.current_sector;

    // Parallelize three independent writes: ship state + character-ship link + map knowledge
    const sUpdateShip = trace.span("update_ship_state");
    const sCharShipLink = trace.span("ensure_character_ship_link");
    const sMapKnowledge = trace.span("upsert_knowledge_entry");
    const t6 = performance.now();
    const knowledge = normalizeMapKnowledge(character.map_knowledge);
    await Promise.all([
      pgUpdateShipState(pg, {
        shipId: ship.ship_id,
        sectorId: targetSector,
        creditsOverride,
      }).then(() => sUpdateShip.end()),
      pgEnsureCharacterShipLink(pg, character.character_id, ship.ship_id)
        .then(() => sCharShipLink.end()),
      pgUpsertKnowledgeEntry(pg, {
        characterId: character.character_id,
        sectorId: targetSector,
        existingKnowledge: knowledge,
        parentSpan: sMapKnowledge,
      }).then(() => sMapKnowledge.end()),
    ]);
    console.log(
      `[join] parallel writes (ship+link+knowledge): ${(performance.now() - t6).toFixed(1)}ms`,
    );

    // Update our local copy
    ship.current_sector = targetSector;

    const source = buildEventSource("join", requestId);

    // Build status and map payloads in parallel
    const sBuildPayloads = trace.span("build_payloads");
    const t9 = performance.now();
    console.log(`[join] Building status + map payloads for ${characterId}`);
    const sBuildStatus = sBuildPayloads.span("build_status_payload");
    const sBuildMap = sBuildPayloads.span("build_local_map_region");
    const [statusPayload, mapPayload] = await Promise.all([
      pgBuildStatusPayload(pg, characterId, {
        character,
        ship,
        shipDefinition,
        parentSpan: sBuildStatus,
      }).then((p) => { sBuildStatus.end(); return p; }),
      pgBuildLocalMapRegion(pg, {
        characterId,
        centerSector: targetSector,
        maxHops: 4,
        maxSectors: 28,
        parentSpan: sBuildMap,
      }).then((p) => { sBuildMap.end(); return p; }),
    ]);
    sBuildPayloads.end();
    console.log(
      `[join] payloads built: ${(performance.now() - t9).toFixed(1)}ms`,
    );

    // Emit status.snapshot FIRST (preserve ordering)
    const sStatusSnapshot = trace.span("emit_status_snapshot");
    statusPayload["source"] = source;
    await pgEmitCharacterEvent({
      pg,
      characterId,
      eventType: "status.snapshot",
      payload: statusPayload,
      shipId: ship.ship_id,
      sectorId: targetSector,
      requestId,
      corpId: character.corporation_id,
    });
    sStatusSnapshot.end();

    // Emit session.started (self-scoped session boundary marker for historical queries)
    const sSessionStarted = trace.span("emit_session_started");
    await pgEmitCharacterEvent({
      pg,
      characterId,
      eventType: "session.started",
      payload: {
        source,
        sector: targetSector,
        ship_name: ship.ship_name ?? shipDefinition.display_name,
        ship_type: ship.ship_type,
      },
      sectorId: targetSector,
      requestId,
      corpId: character.corporation_id,
    });
    sSessionStarted.end();

    // Emit map.local SECOND
    const sMapLocal = trace.span("emit_map_local");
    mapPayload["source"] = source;
    await pgEmitCharacterEvent({
      pg,
      characterId,
      eventType: "map.local",
      payload: mapPayload,
      sectorId: targetSector,
      requestId,
      corpId: character.corporation_id,
    });
    sMapLocal.end();
    console.log(
      `[join] events emitted: ${(performance.now() - t9).toFixed(1)}ms`,
    );

    const observerCorpId =
      ship.owner_type === "corporation"
        ? ship.owner_corporation_id
        : character.corporation_id;
    const observerCorpName = await pgLoadCorpName(pg, observerCorpId);
    const observerMetadata: ObserverMetadata = {
      characterId: character.character_id,
      characterName: character.name,
      shipId: ship.ship_id,
      shipName: ship.ship_name ?? shipDefinition.display_name,
      shipType: ship.ship_type,
      corpId: observerCorpId,
      playerType: resolvePlayerType(character.player_metadata),
      corpName: observerCorpName,
    };

    // Movement observers using PG
    if (previousSector !== null && previousSector !== targetSector) {
      const sMovementObservers = trace.span("emit_movement_observers");
      const t11 = performance.now();
      await pgEmitMovementObservers({
        pg,
        sectorId: previousSector,
        metadata: observerMetadata,
        movement: "depart",
        moveType: "teleport",
        source,
        requestId,
        extraPayload: { from_sector: previousSector },
      });
      // For arrival events, include corp visibility if it's a corp ship
      const corpIds =
        ship.owner_type === "corporation" && ship.owner_corporation_id
          ? [ship.owner_corporation_id]
          : [];

      await pgEmitMovementObservers({
        pg,
        sectorId: targetSector,
        metadata: observerMetadata,
        movement: "arrive",
        moveType: "teleport",
        source,
        requestId,
        extraPayload: { to_sector: targetSector },
        corpIds, // Corp visibility for arrivals
      });
      sMovementObservers.end();
      console.log(
        `[join] movement observers: ${(performance.now() - t11).toFixed(1)}ms`,
      );
    }

    // Auto-join existing combat (if any) in the target sector
    const sAutoJoinCombat = trace.span("auto_join_combat");
    const t12 = performance.now();
    console.log("[join] Checking for existing combat to join");
    let activeEncounter = await autoJoinExistingCombat({
      pg,
      supabase,
      characterId,
      sectorId: targetSector,
      requestId,
    });
    sAutoJoinCombat.end({ joined: !!activeEncounter });
    console.log(
      `[join] autoJoinExistingCombat: ${(performance.now() - t12).toFixed(1)}ms`,
    );

    // Check for garrison auto-engage (offensive/toll garrisons trigger combat on join)
    // This may CREATE a new combat encounter
    const sGarrison = trace.span("check_garrison_auto_engage");
    const t13 = performance.now();
    console.log("[join] Checking for garrison auto-engage");
    const { checkGarrisonAutoEngage } =
      await import("../_shared/garrison_combat.ts");
    await checkGarrisonAutoEngage({
      supabase,
      characterId,
      sectorId: targetSector,
      requestId,
      character,
      ship,
      parentSpan: sGarrison,
    });
    sGarrison.end();
    console.log(
      `[join] checkGarrisonAutoEngage: ${(performance.now() - t13).toFixed(1)}ms`,
    );

    // After all combat setup is complete, check if there's an active combat encounter
    if (!activeEncounter) {
      console.log("[join] Reloading combat state after garrison check");
      const reloadedRow = await pgLoadCombatForSector(pg, targetSector);
      activeEncounter = reloadedRow
        ? deserializeCombat({ ...(reloadedRow.combat as Record<string, unknown>), sector_id: reloadedRow.sector_id })
        : null;
    }

    // LAST: Emit combat.round_waiting if character is in active combat
    if (
      activeEncounter &&
      !activeEncounter.ended &&
      activeEncounter.participants[characterId]
    ) {
      const sCombatEvent = trace.span("emit_combat_round_waiting");
      const t14 = performance.now();
      console.log(
        `[join] Emitting combat.round_waiting for ${characterId} in combat ${activeEncounter.combat_id}`,
      );
      const combatPayload = buildRoundWaitingPayload(activeEncounter);
      const combatSource = buildEventSource("join", requestId);
      combatPayload.source = combatSource;

      // Emit ONLY to the joining character using PG
      await pgEmitCharacterEvent({
        pg,
        characterId,
        eventType: "combat.round_waiting",
        payload: combatPayload,
        sectorId: targetSector,
        requestId,
        actorCharacterId: characterId,
        corpId: character.corporation_id,
      });
      sCombatEvent.end();
      console.log(
        `[join] combat.round_waiting emitted: ${(performance.now() - t14).toFixed(1)}ms`,
      );
    } else {
      console.log(
        "[join] No active combat or character not in combat, skipping combat.round_waiting",
      );
    }

    // Detect first visit by comparing first_visit and last_active (pre-update values).
    // Both default to NOW() at character creation; last_active drifts on subsequent joins.
    const isFirstVisit = (() => {
      const fv = character.first_visit ? new Date(character.first_visit).getTime() : 0;
      const la = character.last_active ? new Date(character.last_active).getTime() : 0;
      return fv > 0 && Math.abs(la - fv) < 180_000; // within 3 min = first visit
    })();

    // Compute onboarding route for players who haven't visited a mega port.
    // Included in the response for the bot to seed into LLM context — NOT
    // written to map_knowledge.
    const sOnboardingRoute = trace.span("compute_onboarding_route");
    let onboardingRoute: number[] | null = null;
    try {
      const meta = await loadUniverseMeta(supabase);
      const megaPorts = getMegaPortSectors(meta);
      if (megaPorts.length > 0) {
        const megaSet = new Set(megaPorts);
        const visitedSectors = Object.keys(knowledge.sectors_visited).map(Number);
        const hasVisitedMega = visitedSectors.some((s) => megaSet.has(s));
        if (!hasVisitedMega) {
          const adjacency = await fetchAllAdjacencies();
          const result = findRouteToNearest(adjacency, targetSector, megaSet);
          if (result && result.path.length > 1) {
            onboardingRoute = result.path;
          }
        }
      }
      sOnboardingRoute.end({ route_length: onboardingRoute?.length ?? 0 });
    } catch (err) {
      console.error("[join] onboarding route computation failed:", err);
      sOnboardingRoute.end({
        error: err instanceof Error ? err.message : String(err),
      });
    }

    console.log(`[join] Total time: ${(performance.now() - t0).toFixed(1)}ms`);
    trace.setOutput({ request_id: requestId, characterId, targetSector, isFirstVisit, "map.local": mapPayload });
    const responseBody: Record<string, unknown> = {
      request_id: requestId,
      is_first_visit: isFirstVisit,
    };
    if (onboardingRoute) {
      responseBody.onboarding_route = onboardingRoute;
    }
    return successResponse(responseBody);
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      return errorResponse(err.message, err.status);
    }
    if (err instanceof JoinError) {
      console.warn("join.validation", err.message);
      return errorResponse(err.message, err.status);
    }
    console.error("join.unhandled", err);
    return errorResponse("internal server error", 500);
  } finally {
    pg.release();
  }
}));

/**
 * Check if character should auto-join existing combat in sector.
 * Returns the active encounter if joined, null otherwise.
 * Does NOT emit events - caller is responsible for emitting combat.round_waiting.
 */
async function autoJoinExistingCombat(params: {
  pg: QueryClient;
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  sectorId: number;
  requestId: string;
}): Promise<any | null> {
  const { pg, supabase, characterId, sectorId } = params;

  console.log(
    `[join.autoJoinCombat] Checking for combat in sector ${sectorId} for ${characterId}`,
  );

  // Check if there's existing active combat in this sector (using PG instead of REST)
  const combatRow = await pgLoadCombatForSector(pg, sectorId);
  const existingEncounter = combatRow
    ? deserializeCombat({ ...(combatRow.combat as Record<string, unknown>), sector_id: combatRow.sector_id })
    : null;
  if (!existingEncounter || existingEncounter.ended) {
    console.log("[join.autoJoinCombat] No active combat found");
    return null;
  }

  console.log(
    `[join.autoJoinCombat] Found active combat ${existingEncounter.combat_id}`,
  );

  // Check if character is already in this combat
  if (existingEncounter.participants[characterId]) {
    console.log("[join.autoJoinCombat] Character already in combat");
    return existingEncounter;
  }

  // Load character combatant data
  const combatants = await loadCharacterCombatants(supabase, sectorId);
  console.log(`[join.autoJoinCombat] Loaded ${combatants.length} combatants`);
  const characterCombatant = combatants.find(
    (c) => c.combatant_id === characterId,
  );

  if (!characterCombatant) {
    console.log("[join.autoJoinCombat] Character not found in combatants list");
    return null;
  }

  console.log("[join.autoJoinCombat] Adding character to combat");

  // Add character to combat participants
  existingEncounter.participants[characterId] = characterCombatant;

  // Persist updated combat state
  await persistCombatState(supabase, existingEncounter);

  console.log(
    "[join.autoJoinCombat] Character added to combat, returning encounter",
  );

  return existingEncounter;
}
