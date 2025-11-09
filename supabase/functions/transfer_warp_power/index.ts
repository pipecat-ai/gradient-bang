import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  buildStatusPayload,
  loadCharacter,
  loadShip,
  loadShipDefinition,
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
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

class TransferWarpPowerError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TransferWarpPowerError';
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
    console.error('transfer_warp_power.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const fromCharacterId = requireString(payload, 'from_character_id');
  const toPlayerName = requireString(payload, 'to_player_name');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  if (actorCharacterId && actorCharacterId !== fromCharacterId && !adminOverride) {
    return errorResponse('actor_character_id must match from_character_id unless admin_override is true', 403);
  }

  try {
    await enforceRateLimit(supabase, fromCharacterId, 'transfer_warp_power');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: 'transfer_warp_power',
        requestId,
        detail: 'Too many transfer_warp_power requests',
        status: 429,
      });
      return errorResponse('Too many transfer_warp_power requests', 429);
    }
    console.error('transfer_warp_power.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleTransfer(supabase, payload, fromCharacterId, toPlayerName, requestId);
  } catch (err) {
    if (err instanceof TransferWarpPowerError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: 'transfer_warp_power',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('transfer_warp_power.unhandled', err);
    await emitErrorEvent(supabase, {
      characterId: fromCharacterId,
      method: 'transfer_warp_power',
      requestId,
      detail: 'internal server error',
      status: 500,
    });
    return errorResponse('internal server error', 500);
  }
});

async function handleTransfer(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  fromCharacterId: string,
  toPlayerName: string,
  requestId: string,
): Promise<Response> {
  const source = buildEventSource('transfer_warp_power', requestId);

  const unitsRaw = optionalNumber(payload, 'units');
  if (unitsRaw === null || !Number.isInteger(unitsRaw) || unitsRaw <= 0) {
    throw new TransferWarpPowerError('units must be a positive integer', 400);
  }
  const unitsRequested = Math.floor(unitsRaw);

  const fromCharacter = await loadCharacter(supabase, fromCharacterId);
  const fromShip = await loadShip(supabase, fromCharacter.current_ship_id);
  if (fromShip.in_hyperspace) {
    throw new TransferWarpPowerError('Sender is in hyperspace, cannot transfer warp power', 400);
  }

  const toCharacterRecord = await findCharacterByNameInSector(
    supabase,
    toPlayerName,
    fromShip.current_sector ?? null,
    fromCharacterId,
  );
  if (!toCharacterRecord) {
    throw new TransferWarpPowerError('Target player not found in this sector', 404);
  }

  const { character: toCharacter, ship: toShip } = toCharacterRecord;
  if (toShip.in_hyperspace) {
    throw new TransferWarpPowerError('Receiver is in hyperspace, cannot transfer warp power', 400);
  }

  if ((toShip.current_sector ?? null) !== (fromShip.current_sector ?? null)) {
    throw new TransferWarpPowerError('Characters must be in the same sector', 400);
  }

  const senderWarp = fromShip.current_warp_power ?? 0;
  if (senderWarp < unitsRequested) {
    throw new TransferWarpPowerError(
      `Insufficient warp power. ${fromCharacterId} only has ${senderWarp} units`,
      400,
    );
  }

  if (toCharacter.character_id === fromCharacterId) {
    throw new TransferWarpPowerError('Cannot transfer warp power to yourself', 400);
  }

  const toDefinition = await loadShipDefinition(supabase, toShip.ship_type);
  const receiverCapacity = toDefinition.warp_power_capacity - (toShip.current_warp_power ?? 0);
  const unitsToTransfer = Math.min(unitsRequested, receiverCapacity);
  if (unitsToTransfer <= 0) {
    throw new TransferWarpPowerError(`${toCharacter.character_id}'s warp power is already at maximum`, 400);
  }

  await updateWarpPower(supabase, fromShip.ship_id, senderWarp - unitsToTransfer);
  await updateWarpPower(supabase, toShip.ship_id, (toShip.current_warp_power ?? 0) + unitsToTransfer);

  const timestamp = new Date().toISOString();
  await supabase
    .from('characters')
    .update({ last_active: timestamp })
    .eq('character_id', fromCharacterId);
  await supabase
    .from('characters')
    .update({ last_active: timestamp })
    .eq('character_id', toCharacter.character_id);

  const fromStatus = await buildStatusPayload(supabase, fromCharacterId);
  const toStatus = await buildStatusPayload(supabase, toCharacter.character_id);

  const fromPlayer = fromStatus.player;
  const toPlayer = toStatus.player;
  const fromShipSnapshot = fromStatus.ship;
  const toShipSnapshot = toStatus.ship;

  const transferDetails = { warp_power: unitsToTransfer };
  const sectorPayload = { id: fromShip.current_sector ?? toShip.current_sector ?? 0 };

  await emitCharacterEvent({
    supabase,
    characterId: fromCharacterId,
    eventType: 'warp.transfer',
    payload: {
      transfer_direction: 'sent',
      transfer_details: transferDetails,
      from: {
        ...fromPlayer,
        ship: {
          ship_type: fromShipSnapshot.ship_type,
          ship_name: fromShipSnapshot.ship_name,
        },
      },
      to: {
        ...toPlayer,
        ship: {
          ship_type: toShipSnapshot.ship_type,
          ship_name: toShipSnapshot.ship_name,
        },
      },
      sector: sectorPayload,
      timestamp,
      source,
    },
    requestId,
  });

  await emitCharacterEvent({
    supabase,
    characterId: toCharacter.character_id,
    eventType: 'warp.transfer',
    payload: {
      transfer_direction: 'received',
      transfer_details: transferDetails,
      from: {
        ...fromPlayer,
        ship: {
          ship_type: fromShipSnapshot.ship_type,
          ship_name: fromShipSnapshot.ship_name,
        },
      },
      to: {
        ...toPlayer,
        ship: {
          ship_type: toShipSnapshot.ship_type,
          ship_name: toShipSnapshot.ship_name,
        },
      },
      sector: sectorPayload,
      timestamp,
      source,
    },
    requestId,
  });

  await emitCharacterEvent({
    supabase,
    characterId: fromCharacterId,
    eventType: 'status.update',
    payload: fromStatus,
    requestId,
  });
  await emitCharacterEvent({
    supabase,
    characterId: toCharacter.character_id,
    eventType: 'status.update',
    payload: toStatus,
    requestId,
  });

  return successResponse({ request_id: requestId });
}

async function updateWarpPower(
  supabase: SupabaseClient,
  shipId: string,
  warpPower: number,
): Promise<void> {
  const { error } = await supabase
    .from('ship_instances')
    .update({ current_warp_power: warpPower })
    .eq('ship_id', shipId);
  if (error) {
    console.error('transfer_warp_power.update_ship', error);
    throw new TransferWarpPowerError('Failed to update ship state', 500);
  }
}

async function findCharacterByNameInSector(
  supabase: SupabaseClient,
  name: string,
  sectorId: number | null,
  excludeCharacterId: string,
): Promise<{
  character: {
    character_id: string;
    name: string;
    first_visit: string;
    player_metadata: Record<string, unknown> | null;
    current_ship_id: string;
  };
  ship: {
    ship_id: string;
    ship_type: string;
    ship_name: string | null;
    current_sector: number | null;
    in_hyperspace: boolean;
    current_warp_power: number | null;
  };
} | null> {
  if (sectorId === null) {
    return null;
  }

  const pattern = name.replace(/[%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await supabase
    .from('characters')
    .select('character_id, name, first_visit, player_metadata, current_ship_id')
    .ilike('name', pattern)
    .neq('character_id', excludeCharacterId)
    .limit(5);

  if (error) {
    console.error('transfer_warp_power.lookup', error);
    throw new TransferWarpPowerError('Failed to lookup target player', 500);
  }
  if (!data) {
    return null;
  }

  for (const candidate of data) {
    if (!candidate.current_ship_id) {
      continue;
    }
    let ship;
    try {
      ship = await loadShip(supabase, candidate.current_ship_id);
    } catch (err) {
      console.error('transfer_warp_power.lookup_ship', err);
      continue;
    }
    if ((ship.current_sector ?? null) !== sectorId) {
      continue;
    }
    if (ship.in_hyperspace) {
      continue;
    }
    return {
      character: {
        character_id: candidate.character_id,
        name: candidate.name,
        first_visit: candidate.first_visit,
        player_metadata: candidate.player_metadata,
        current_ship_id: candidate.current_ship_id,
      },
      ship: {
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        ship_name: ship.ship_name,
        current_sector: ship.current_sector,
        in_hyperspace: ship.in_hyperspace,
        current_warp_power: ship.current_warp_power,
      },
    };
  }

  return null;
}
