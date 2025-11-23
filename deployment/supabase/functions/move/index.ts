import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource, emitSectorEnvelope } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  buildLocalMapRegion,
  buildSectorSnapshot,
  getAdjacentSectors,
  markSectorVisited,
  loadMapKnowledge,
} from '../_shared/map.ts';
import {
  buildStatusPayload,
  loadCharacter,
  loadShip,
  loadShipDefinition,
  type ShipRow,
} from '../_shared/status.ts';
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
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import { type ObserverMetadata } from '../_shared/observers.ts';
import { emitMovementObservers } from '../_shared/movement.ts';
import { checkGarrisonAutoEngage } from '../_shared/garrison_combat.ts';
import { loadCombatForSector } from '../_shared/combat_state.ts';

const BASE_MOVE_DELAY = Number(Deno.env.get('MOVE_DELAY_SECONDS_PER_TURN') ?? (2 / 3));
const MOVE_DELAY_SCALE = Number(Deno.env.get('MOVE_DELAY_SCALE') ?? '1');
const MAX_LOCAL_MAP_HOPS = 4;
const MAX_LOCAL_MAP_NODES = 28;

class MoveError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'MoveError';
    this.status = status;
  }
}

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
    await enforceRateLimit(supabase, characterId, 'move');
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
    characterId,
    destination,
    requestId,
    actorCharacterId,
    adminOverride,
  } as const;

  return await handleMove(moveContext);
});

async function handleMove({ supabase, characterId, destination, requestId, actorCharacterId, adminOverride }: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  destination: number;
  requestId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
}): Promise<Response> {
  const source = buildEventSource('move', requestId);
  let observerMetadata: ObserverMetadata;

  let character;
  let ship;
  let shipDefinition;
  try {
    character = await loadCharacter(supabase, characterId);
    ship = await loadShip(supabase, character.current_ship_id);
    shipDefinition = await loadShipDefinition(supabase, ship.ship_type);
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

  try {
    await ensureActorAuthorization({
      supabase,
      ship,
      actorCharacterId,
      adminOverride,
      targetCharacterId: characterId,
    });
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

  // Check if character is in combat
  const combat = await loadCombatForSector(supabase, ship.current_sector);
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

  observerMetadata = {
    characterId: character.character_id,
    characterName: character.name,
    shipId: ship.ship_id,
    shipName: shipDefinition.display_name,  // Always human-readable per codex convention
    shipType: ship.ship_type,
  };

  const adjacent = await getAdjacentSectors(supabase, ship.current_sector);
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

  let destinationSnapshot;
  try {
    destinationSnapshot = await buildSectorSnapshot(supabase, destination, characterId);
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
    await startHyperspace({
      supabase,
      shipId: ship.ship_id,
      currentSector: ship.current_sector,
      destination,
      eta: hyperspaceEta,
      newWarpTotal: ship.current_warp_power - warpCost,
    });
    enteredHyperspace = true;

    await supabase
      .from('characters')
      .update({ last_active: new Date().toISOString() })
      .eq('character_id', characterId);

    await emitCharacterEvent({
      supabase,
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

    await emitMovementObservers({
      supabase,
      sectorId: ship.current_sector,
      metadata: observerMetadata,
      movement: 'depart',
      source,
      requestId,
    });

    await completeMovement({
      supabase,
      character,
      characterId,
      shipId: ship.ship_id,
      destination,
      requestId,
      source,
      hyperspaceSeconds,
      destinationSnapshot,
      observerMetadata,
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
      await finishHyperspace({ supabase, shipId: ship.ship_id, destination: ship.current_sector ?? 0 });
    }
  }
}

// helper moved to _shared/actors.ts

async function completeMovement({
  supabase,
  character,
  characterId,
  shipId,
  destination,
  requestId,
  source,
  hyperspaceSeconds,
  destinationSnapshot,
  observerMetadata,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  character: Awaited<ReturnType<typeof loadCharacter>>;
  characterId: string;
  shipId: string;
  destination: number;
  requestId: string;
  source: ReturnType<typeof buildEventSource>;
  hyperspaceSeconds: number;
  destinationSnapshot: Record<string, unknown>;
  observerMetadata: ObserverMetadata;
}): Promise<void> {
  try {
    if (hyperspaceSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, hyperspaceSeconds * 1000));
    }

    await finishHyperspace({ supabase, shipId, destination });

    await supabase
      .from('characters')
      .update({ last_active: new Date().toISOString() })
      .eq('character_id', characterId);

    const statusPayload = await buildStatusPayload(supabase, characterId);
    const knowledge = await loadMapKnowledge(supabase, characterId);
    const { firstVisit, knowledge: updatedKnowledge } = await markSectorVisited(supabase, {
      characterId,
      sectorId: destination,
      sectorSnapshot: destinationSnapshot,
      knowledge,
    });

    const movementCompletePayload = {
      source,
      player: statusPayload.player,
      ship: statusPayload.ship,
      sector: statusPayload.sector,
      first_visit: firstVisit,
    } as Record<string, unknown>;

    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'movement.complete',
      payload: movementCompletePayload,
      shipId,
      sectorId: destination,
      requestId,
      corpId: character.corporation_id,
    });

    const mapRegion = await buildLocalMapRegion(supabase, {
      characterId,
      centerSector: destination,
      mapKnowledge: updatedKnowledge,
      maxHops: MAX_LOCAL_MAP_HOPS,
      maxSectors: MAX_LOCAL_MAP_NODES,
    });
    mapRegion['source'] = source;

    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'map.local',
      payload: mapRegion,
      sectorId: destination,
      requestId,
      corpId: character.corporation_id,
    });

    await emitMovementObservers({
      supabase,
      sectorId: destination,
      metadata: observerMetadata,
      movement: 'arrive',
      source,
      requestId,
    });

    // Check for garrison auto-combat after arrival
    try {
      await checkGarrisonAutoEngage({
        supabase,
        characterId,
        sectorId: destination,
        requestId,
      });
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
  }
}

async function startHyperspace({
  supabase,
  shipId,
  currentSector,
  destination,
  eta,
  newWarpTotal,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  shipId: string;
  currentSector: number;
  destination: number;
  eta: string;
  newWarpTotal: number;
}): Promise<void> {
  const { error, data } = await supabase
    .from('ship_instances')
    .update({
      in_hyperspace: true,
      hyperspace_destination: destination,
      hyperspace_eta: eta,
      current_warp_power: newWarpTotal,
    })
    .eq('ship_id', shipId)
    .eq('in_hyperspace', false)
    .eq('current_sector', currentSector)
    .select('ship_id');
  if (error || !data || data.length === 0) {
    console.error('move.start_hyperspace', error);
    throw new MoveError('failed to enter hyperspace', 409);
  }
}

async function finishHyperspace({
  supabase,
  shipId,
  destination,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  shipId: string;
  destination: number;
}): Promise<void> {
  const { error } = await supabase
    .from('ship_instances')
    .update({
      current_sector: destination,
      in_hyperspace: false,
      hyperspace_destination: null,
      hyperspace_eta: null,
    })
    .eq('ship_id', shipId);
  if (error) {
    console.error('move.finish_hyperspace', error);
    throw new MoveError('failed to complete movement', 500);
  }
}
