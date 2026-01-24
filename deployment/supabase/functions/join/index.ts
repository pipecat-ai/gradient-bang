import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { createPgClient, connectWithCleanup } from "../_shared/pg.ts";
import {
  pgLoadCharacterForJoin,
  pgLoadShip,
  pgLoadShipDefinition,
  pgEnforceRateLimit,
  RateLimitError,
  pgEnsureActorAuthorization,
  pgResolveTargetSector,
  pgUpdateShipState,
  pgEnsureCharacterShipLink,
  pgUpsertKnowledgeEntry,
  pgBuildStatusPayload,
  pgBuildLocalMapRegion,
  pgEmitCharacterEvent,
  pgEmitMovementObservers,
  JoinError,
  type ObserverMetadata,
} from "../_shared/pg_queries.ts";
import { buildEventSource } from "../_shared/events.ts";
import {
  loadCombatForSector,
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
import { normalizeMapKnowledge } from "../_shared/map.ts";

const DEFAULT_START_SECTOR = 0;

Deno.serve(async (req: Request): Promise<Response> => {
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

  // Create PG client for main operations
  const pg = createPgClient();
  // Supabase client for combat operations (still REST-based)
  const supabase = createServiceRoleClient();

  try {
    await connectWithCleanup(pg);
    const t0 = performance.now();

    // Load character using PG
    const character = await pgLoadCharacterForJoin(pg, characterId);
    if (!character) {
      throw new JoinError("Character is not registered", 404);
    }
    console.log(
      `[join] pgLoadCharacter: ${(performance.now() - t0).toFixed(1)}ms`,
    );

    // Rate limiting
    const t1 = performance.now();
    try {
      await pgEnforceRateLimit(pg, characterId, "join");
    } catch (err) {
      if (err instanceof RateLimitError) {
        return errorResponse("Too many join requests", 429);
      }
      console.error("join.rate_limit", err);
      throw new JoinError("rate limit error", 500);
    }
    console.log(
      `[join] pgEnforceRateLimit: ${(performance.now() - t1).toFixed(1)}ms`,
    );

    if (!character.current_ship_id) {
      throw new JoinError("character has no ship", 500);
    }

    // Load ship using PG
    const t2 = performance.now();
    const ship = await pgLoadShip(pg, character.current_ship_id);
    console.log(`[join] pgLoadShip: ${(performance.now() - t2).toFixed(1)}ms`);

    // Actor authorization using PG
    const t3 = performance.now();
    await pgEnsureActorAuthorization(pg, {
      ship,
      actorCharacterId,
      adminOverride,
      targetCharacterId: characterId,
    });
    console.log(
      `[join] pgEnsureActorAuthorization: ${(performance.now() - t3).toFixed(1)}ms`,
    );

    // Load ship definition using PG
    const t4 = performance.now();
    const shipDefinition = await pgLoadShipDefinition(pg, ship.ship_type);
    console.log(
      `[join] pgLoadShipDefinition: ${(performance.now() - t4).toFixed(1)}ms`,
    );

    const previousSector = ship.current_sector;

    // Resolve target sector using PG
    const t5 = performance.now();
    const targetSector = await pgResolveTargetSector(pg, {
      sectorOverride,
      fallbackSector: ship.current_sector ?? DEFAULT_START_SECTOR,
    });
    console.log(
      `[join] pgResolveTargetSector: ${(performance.now() - t5).toFixed(1)}ms`,
    );

    // Update ship state using PG
    const t6 = performance.now();
    await pgUpdateShipState(pg, {
      shipId: ship.ship_id,
      sectorId: targetSector,
      creditsOverride,
    });
    console.log(
      `[join] pgUpdateShipState: ${(performance.now() - t6).toFixed(1)}ms`,
    );

    // Update our local copy
    ship.current_sector = targetSector;

    // Ensure character-ship link using PG
    const t7 = performance.now();
    await pgEnsureCharacterShipLink(pg, character.character_id, ship.ship_id);
    console.log(
      `[join] pgEnsureCharacterShipLink: ${(performance.now() - t7).toFixed(1)}ms`,
    );

    // Update map knowledge using PG
    const t8 = performance.now();
    const knowledge = normalizeMapKnowledge(character.map_knowledge);
    await pgUpsertKnowledgeEntry(pg, {
      characterId: character.character_id,
      sectorId: targetSector,
      existingKnowledge: knowledge,
    });
    console.log(
      `[join] pgUpsertKnowledgeEntry: ${(performance.now() - t8).toFixed(1)}ms`,
    );

    const source = buildEventSource("join", requestId);

    // Emit status.snapshot FIRST using PG
    const t9 = performance.now();
    console.log(`[join] Emitting status.snapshot for ${characterId}`);
    const statusPayload = await pgBuildStatusPayload(pg, characterId, {
      character,
      ship,
      shipDefinition,
    });
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
    console.log(
      `[join] status.snapshot emitted: ${(performance.now() - t9).toFixed(1)}ms`,
    );

    // Emit map.local SECOND using PG
    const t10 = performance.now();
    console.log(`[join] Emitting map.local for ${characterId}`);
    const mapPayload = await pgBuildLocalMapRegion(pg, {
      characterId,
      centerSector: targetSector,
      maxHops: 4,
      maxSectors: 28,
    });
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
    console.log(
      `[join] map.local emitted: ${(performance.now() - t10).toFixed(1)}ms`,
    );

    const observerMetadata: ObserverMetadata = {
      characterId: character.character_id,
      characterName: character.name,
      shipId: ship.ship_id,
      shipName: ship.ship_name ?? shipDefinition.display_name,
      shipType: ship.ship_type,
    };

    // Movement observers using PG
    if (previousSector !== null && previousSector !== targetSector) {
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
      console.log(
        `[join] movement observers: ${(performance.now() - t11).toFixed(1)}ms`,
      );
    }

    // Auto-join existing combat (if any) in the target sector
    // Combat operations still use REST (Supabase client)
    const t12 = performance.now();
    console.log("[join] Checking for existing combat to join");
    let activeEncounter = await autoJoinExistingCombat({
      supabase,
      characterId,
      sectorId: targetSector,
      requestId,
    });
    console.log(
      `[join] autoJoinExistingCombat: ${(performance.now() - t12).toFixed(1)}ms`,
    );

    // Check for garrison auto-engage (offensive/toll garrisons trigger combat on join)
    // This may CREATE a new combat encounter
    const t13 = performance.now();
    console.log("[join] Checking for garrison auto-engage");
    const { checkGarrisonAutoEngage } =
      await import("../_shared/garrison_combat.ts");
    await checkGarrisonAutoEngage({
      supabase,
      characterId,
      sectorId: targetSector,
      requestId,
    });
    console.log(
      `[join] checkGarrisonAutoEngage: ${(performance.now() - t13).toFixed(1)}ms`,
    );

    // After all combat setup is complete, check if there's an active combat encounter
    if (!activeEncounter) {
      console.log("[join] Reloading combat state after garrison check");
      activeEncounter = await loadCombatForSector(supabase, targetSector);
    }

    // LAST: Emit combat.round_waiting if character is in active combat
    if (
      activeEncounter &&
      !activeEncounter.ended &&
      activeEncounter.participants[characterId]
    ) {
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
      console.log(
        `[join] combat.round_waiting emitted: ${(performance.now() - t14).toFixed(1)}ms`,
      );
    } else {
      console.log(
        "[join] No active combat or character not in combat, skipping combat.round_waiting",
      );
    }

    console.log(`[join] Total time: ${(performance.now() - t0).toFixed(1)}ms`);
    return successResponse({ request_id: requestId });
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
    try {
      await pg.end();
    } catch {
      // Ignore close errors
    }
  }
});

/**
 * Check if character should auto-join existing combat in sector.
 * Returns the active encounter if joined, null otherwise.
 * Does NOT emit events - caller is responsible for emitting combat.round_waiting.
 */
async function autoJoinExistingCombat(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  sectorId: number;
  requestId: string;
}): Promise<any | null> {
  const { supabase, characterId, sectorId } = params;

  console.log(
    `[join.autoJoinCombat] Checking for combat in sector ${sectorId} for ${characterId}`,
  );

  // Check if there's existing active combat in this sector
  const existingEncounter = await loadCombatForSector(supabase, sectorId);
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
