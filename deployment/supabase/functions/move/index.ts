import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';
import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { createPgClient, connectWithCleanup } from '../_shared/pg.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';
import { ActorAuthorizationError } from '../_shared/actors.ts';
import { checkGarrisonAutoEngage } from '../_shared/garrison_combat.ts';
import { deserializeCombat } from '../_shared/combat_state.ts';
import type { CharacterRow, ShipRow, ShipDefinitionRow } from '../_shared/status.ts';
import type { SectorSnapshot, MapKnowledge } from '../_shared/map.ts';
import { parseWarpEdges } from '../_shared/map.ts';

// Import pg-based query functions
import {
  pgEnforceRateLimit,
  pgLoadCharacter,
  pgLoadShip,
  pgLoadShipDefinition,
  pgEnsureActorCanControlShip,
  pgLoadCombatForSector,
  pgGetAdjacentSectors,
  pgBuildSectorSnapshot,
  pgStartHyperspace,
  pgFinishHyperspace,
  pgUpdateCharacterLastActive,
  pgBuildStatusPayload,
  pgLoadMapKnowledge,
  pgMarkSectorVisited,
  pgBuildLocalMapRegion,
  pgEmitCharacterEvent,
  pgEmitMovementObservers,
  pgCheckGarrisonAutoEngage,
  RateLimitError,
  MoveError,
  type ObserverMetadata,
} from '../_shared/pg_queries.ts';

const BASE_MOVE_DELAY = Number(Deno.env.get('MOVE_DELAY_SECONDS_PER_TURN') ?? (2 / 3));
const MOVE_DELAY_SCALE = Number(Deno.env.get('MOVE_DELAY_SCALE') ?? '1');
const MAX_LOCAL_MAP_HOPS = 4;
const MAX_LOCAL_MAP_NODES = 28;

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  const pgClient = createPgClient();
  const tStart = performance.now();
  const trace: Record<string, number> = {};
  const mark = (label: string) => {
    trace[label] = Math.round(performance.now() - tStart);
  };

  try {
    try {
      await pgClient.connect();
      mark('pg_connect');
    } catch (pgConnectError) {
      console.error('move.pg_connect_error', pgConnectError);
      return errorResponse(`Failed to connect to database: ${pgConnectError instanceof Error ? pgConnectError.message : 'unknown error'}`, 500);
    }

    let payload;
    try {
      payload = await parseJsonRequest(req);
    } catch (err) {
      const response = respondWithError(err);
      if (response) {
        return response;
      }
      console.error('move.parse', err);
      return errorResponse('invalid JSON payload', 400);
    }

    if (payload.healthcheck === true) {
      return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
    }

    const requestId = resolveRequestId(payload);
    const rawCharacterId = requireString(payload, 'character_id');
    const characterId = await canonicalizeCharacterId(rawCharacterId);
    const actorCharacterLabel = optionalString(payload, 'actor_character_id');
    const actorCharacterId = actorCharacterLabel ? await canonicalizeCharacterId(actorCharacterLabel) : null;
    const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

    let toSector = optionalNumber(payload, 'to_sector');
    if (toSector === null && 'to' in payload) {
      toSector = optionalNumber(payload, 'to');
    }
    if (toSector === null || Number.isNaN(toSector)) {
      return errorResponse('to_sector is required', 400);
    }
    if (toSector < 0) {
      return errorResponse('to_sector must be non-negative', 400);
    }
    const destination = toSector;

    try {
      await pgEnforceRateLimit(pgClient, characterId, 'move');
      mark('rate_limit');
    } catch (err) {
      if (err instanceof RateLimitError) {
        await emitErrorEvent(supabase, {
          characterId,
          method: 'move',
          requestId,
          detail: 'Too many move requests',
          status: 429,
        });
        return errorResponse('Too many move requests', 429);
      }
      console.error('move.rate_limit', err);
      return errorResponse('rate limit error', 500);
    }

    const moveContext = {
      supabase,
      pgClient,
      characterId,
      destination,
      requestId,
      actorCharacterId,
      adminOverride,
      trace,
      mark,
    } as const;

    const result = await handleMove(moveContext);
    const tEnd = performance.now();
    trace['total'] = Math.round(tEnd - tStart);
    console.log('move.trace', {
      request_id: requestId,
      character_id: characterId,
      destination,
      trace,
    });
    return result;
  } finally {
    // pgClient may already be closed by completeMovement - safe to call end() anyway
    try {
      await pgClient.end();
    } catch {
      // Already closed, ignore
    }
  }
});

async function handleMove({ supabase, pgClient, characterId, destination, requestId, actorCharacterId, adminOverride, trace, mark }: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  pgClient: Client;
  characterId: string;
  destination: number;
  requestId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
  trace: Record<string, number>;
  mark: (label: string) => void;
}): Promise<Response> {
  const source = buildEventSource('move', requestId);
  let observerMetadata: ObserverMetadata;

  let character: CharacterRow;
  let ship: ShipRow;
  let shipDefinition: ShipDefinitionRow;
  try {
    // Load character first (needed to get current_ship_id)
    character = await pgLoadCharacter(pgClient, characterId);
    mark('load_character');

    // Load ship (need ship_type for definition)
    ship = await pgLoadShip(pgClient, character.current_ship_id);
    mark('load_ship');
    shipDefinition = await pgLoadShipDefinition(pgClient, ship.ship_type);
    mark('load_ship_definition');
  } catch (err) {
    console.error('move.load_state', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'move',
      requestId,
      detail: 'character not found',
      status: 404,
    });
    return errorResponse('character not found', 404);
  }

  // Actor authorization check
  try {
    await ensureActorAuthorizationPg({
      pgClient,
      ship,
      actorCharacterId,
      adminOverride,
      targetCharacterId: characterId,
    });
    mark('auth');
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      console.warn('move.authorization', err.message);
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  if (ship.in_hyperspace) {
    await emitErrorEvent(supabase, {
      characterId,
      method: 'move',
      requestId,
      detail: 'Character is already in hyperspace',
      status: 409,
    });
    return errorResponse('character already in hyperspace', 409);
  }

  if (ship.current_sector === null) {
    return errorResponse('Character ship missing sector', 500);
  }

  // Parallelize combat check and adjacent sectors lookup
  const [combatRow, adjacent] = await Promise.all([
    pgLoadCombatForSector(pgClient, ship.current_sector),
    pgGetAdjacentSectors(pgClient, ship.current_sector),
  ]);
  mark('load_combat_and_adjacent');

  if (combatRow) {
    const combat = deserializeCombat({
      ...(combatRow.combat as Record<string, unknown>),
      sector_id: combatRow.sector_id,
    });
    if (combat && !combat.ended) {
      // Check if this character is a participant in the combat
      if (characterId in combat.participants) {
        await emitErrorEvent(supabase, {
          characterId,
          method: 'move',
          requestId,
          detail: 'Cannot move while in combat',
          status: 409,
        });
        return errorResponse('cannot move while in combat', 409);
      }
    }
  }

  observerMetadata = {
    characterId: character.character_id,
    characterName: character.name,
    shipId: ship.ship_id,
    shipName: shipDefinition.display_name,  // Always human-readable per codex convention
    shipType: ship.ship_type,
  };
  if (!adjacent.includes(destination)) {
    await emitErrorEvent(supabase, {
      characterId,
      method: 'move',
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
      method: 'move',
      requestId,
      detail: `Insufficient warp power. Need ${warpCost}`,
      status: 400,
    });
    return errorResponse(
      `Insufficient warp power. Need ${warpCost} units but only have ${ship.current_warp_power}`,
      400,
    );
  }

  const hyperspaceSeconds = Math.max(warpCost * BASE_MOVE_DELAY * Math.max(MOVE_DELAY_SCALE, 0), 0);
  const hyperspaceEta = new Date(Date.now() + hyperspaceSeconds * 1000).toISOString();
  let enteredHyperspace = false;

  let destinationSnapshot: SectorSnapshot;
  try {
    destinationSnapshot = await pgBuildSectorSnapshot(pgClient, destination, characterId);
    mark('build_destination_snapshot');
  } catch (err) {
    console.error('move.destination_snapshot', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'move',
      requestId,
      detail: 'failed to build destination snapshot',
      status: 500,
    });
    return errorResponse('failed to build destination snapshot', 500);
  }

  try {
    await pgStartHyperspace(pgClient, {
      shipId: ship.ship_id,
      currentSector: ship.current_sector,
      destination,
      eta: hyperspaceEta,
      newWarpTotal: ship.current_warp_power - warpCost,
    });
    mark('start_hyperspace');
    enteredHyperspace = true;

    await pgUpdateCharacterLastActive(pgClient, characterId);
    mark('update_last_active');

    await pgEmitCharacterEvent({
      pg: pgClient,
      characterId,
      eventType: 'movement.start',
      payload: {
        source,
        sector: destinationSnapshot,
        hyperspace_time: hyperspaceSeconds,
      },
      shipId: ship.ship_id,
      sectorId: ship.current_sector,
      requestId,
      corpId: character.corporation_id,
    });
    mark('emit_movement_start');

    await pgEmitMovementObservers({
      pg: pgClient,
      sectorId: ship.current_sector,
      metadata: observerMetadata,
      movement: 'depart',
      source,
      requestId,
    });

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
      source,
      hyperspaceSeconds,
      destinationSnapshot,
      observerMetadata,
      trace,
      mark,
    });

    enteredHyperspace = false;

    return successResponse({ request_id: requestId });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'move',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('move.unhandled', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'move',
      requestId,
      detail: err instanceof MoveError ? err.message : 'internal server error',
      status: err instanceof MoveError ? err.status : 500,
    });
    if (err instanceof MoveError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponse('internal server error', 500);
  } finally {
    if (enteredHyperspace) {
      // Original pgClient may have been closed during completeMovement,
      // so we need a fresh connection for cleanup
      const cleanupPg = createPgClient();
      try {
        await cleanupPg.connect();
        await pgFinishHyperspace(cleanupPg, { shipId: ship.ship_id, destination: ship.current_sector ?? 0 });
      } catch (cleanupErr) {
        console.error('move.cleanup_hyperspace', cleanupErr);
      } finally {
        await cleanupPg.end();
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
  pgClient: Client;
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
    if (actorCharacterId && targetCharacterId && actorCharacterId !== targetCharacterId) {
      throw new ActorAuthorizationError('actor_character_id must match character_id unless admin_override is true', 403);
    }
    return;
  }

  const resolvedTargetId = targetCharacterId ?? ship.owner_character_id ?? ship.owner_id ?? ship.ship_id;

  if (ship.owner_type === 'corporation') {
    if (requireActorForCorporationShip && !actorCharacterId) {
      throw new ActorAuthorizationError(
        'actor_character_id is required when controlling a corporation ship',
        400,
      );
    }
    if (!ship.owner_corporation_id) {
      throw new ActorAuthorizationError('Corporation ship is missing ownership data', 403);
    }
    if (!actorCharacterId) {
      return;
    }
    const allowed = await pgEnsureActorCanControlShip(pgClient, actorCharacterId, ship.owner_corporation_id);
    if (!allowed) {
      throw new ActorAuthorizationError('Actor is not authorized to control this corporation ship', 403);
    }
    return;
  }

  if (actorCharacterId && actorCharacterId !== resolvedTargetId) {
    throw new ActorAuthorizationError('actor_character_id must match character_id unless admin_override is true', 403);
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
  source,
  hyperspaceSeconds,
  destinationSnapshot,
  observerMetadata,
  trace,
  mark,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  pgClient: Client;
  character: CharacterRow;
  ship: ShipRow;
  shipDefinition: ShipDefinitionRow;
  characterId: string;
  shipId: string;
  destination: number;
  requestId: string;
  source: ReturnType<typeof buildEventSource>;
  hyperspaceSeconds: number;
  destinationSnapshot: SectorSnapshot;
  observerMetadata: ObserverMetadata;
  trace: Record<string, number>;
  mark: (label: string) => void;
}): Promise<void> {
  // Release the connection BEFORE the delay to free it for other requests.
  // This is critical for connection pool efficiency under concurrent load.
  await pgClient.end();
  mark('pg_release_for_delay');

  if (hyperspaceSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, hyperspaceSeconds * 1000));
  }
  mark('delay_done');

  // Reconnect AFTER the delay to complete the move
  const pg = createPgClient();
  try {
    await connectWithCleanup(pg);
    mark('pg_reconnect');

    await pgFinishHyperspace(pg, { shipId, destination });
    mark('finish_hyperspace');

    await pgUpdateCharacterLastActive(pg, characterId);
    mark('update_character_last_active');

    // Re-load ship to get updated warp_power after move, but reuse character and definition
    const updatedShip = await pgLoadShip(pg, shipId);
    // Update ship's current_sector to destination for status payload
    updatedShip.current_sector = destination;

    const statusPayload = await pgBuildStatusPayload(pg, characterId, {
      character,
      ship: updatedShip,
      shipDefinition,
      sectorSnapshot: destinationSnapshot,
    });
    mark('build_status_complete');

    // Mark sector visited (updates personal or corp knowledge depending on player type)
    const { firstPersonalVisit, knownToCorp } = await pgMarkSectorVisited(pg, {
      characterId,
      sectorId: destination,
      sectorSnapshot: destinationSnapshot,
    });
    mark('mark_sector_visited');

    // Load merged knowledge for local map (personal + corp)
    const mergedKnowledge = await pgLoadMapKnowledge(pg, characterId);
    mark('load_map_knowledge');

    const movementCompletePayload = {
      source,
      player: statusPayload.player,
      ship: statusPayload.ship,
      sector: statusPayload.sector,
      first_visit: firstPersonalVisit,
      known_to_corp: knownToCorp,
    } as Record<string, unknown>;

    await pgEmitCharacterEvent({
      pg,
      characterId,
      eventType: 'movement.complete',
      payload: movementCompletePayload,
      shipId,
      sectorId: destination,
      requestId,
      corpId: character.corporation_id,
    });
    mark('emit_movement_complete');

    const mapRegion = await pgBuildLocalMapRegion(pg, {
      characterId,
      centerSector: destination,
      mapKnowledge: mergedKnowledge,
      maxHops: MAX_LOCAL_MAP_HOPS,
      maxSectors: MAX_LOCAL_MAP_NODES,
    });
    mark('build_local_map');
    (mapRegion as Record<string, unknown>)['source'] = source;

    await pgEmitCharacterEvent({
      pg,
      characterId,
      eventType: 'map.local',
      payload: mapRegion as Record<string, unknown>,
      sectorId: destination,
      requestId,
      corpId: character.corporation_id,
    });
    mark('emit_map_local');

    await pgEmitMovementObservers({
      pg,
      sectorId: destination,
      metadata: observerMetadata,
      movement: 'arrive',
      source,
      requestId,
    });

    // Check for garrison auto-combat after arrival
    // Use fast pg check first, only fall back to REST if combat initiation needed
    try {
      const needsCombat = await pgCheckGarrisonAutoEngage({
        pg,
        characterId,
        sectorId: destination,
        requestId,
      });
      if (needsCombat) {
        // Combat initiation needed - use REST version for full combat setup
        await checkGarrisonAutoEngage({
          supabase,
          characterId,
          sectorId: destination,
          requestId,
        });
      }
    } catch (garrisonError) {
      // Log but don't fail the move if garrison combat fails
      console.error('move.garrison_auto_engage', garrisonError);
    }
  } catch (error) {
    console.error('move.async_completion', error);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'move.complete',
      requestId,
      detail: error instanceof Error ? error.message : 'movement completion failed',
      status: 500,
    });
    throw error; // Re-throw so caller knows completion failed
  } finally {
    await pg.end();
  }
}
