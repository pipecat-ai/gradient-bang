import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { FIGHTER_PRICE } from '../_shared/constants.ts';
import {
  buildStatusPayload,
  buildPublicPlayerSnapshotFromStatus,
  loadCharacter,
  loadShip,
  loadShipDefinition,
} from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

class PurchaseFightersError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PurchaseFightersError';
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
    console.error('purchase_fighters.parse', err);
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

  try {
    await enforceRateLimit(supabase, characterId, 'purchase_fighters');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'purchase_fighters',
        requestId,
        detail: 'Too many purchase_fighters requests',
        status: 429,
      });
      return errorResponse('Too many purchase_fighters requests', 429);
    }
    console.error('purchase_fighters.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handlePurchase(
      supabase,
      payload,
      characterId,
      rawCharacterId,
      requestId,
      actorCharacterId,
      adminOverride,
    );
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'purchase_fighters',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof PurchaseFightersError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'purchase_fighters',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('purchase_fighters.unhandled', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'purchase_fighters',
      requestId,
      detail: 'internal server error',
      status: 500,
    });
    return errorResponse('internal server error', 500);
  }
});

async function handlePurchase(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  characterLabelFallback: string,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
): Promise<Response> {
  const unitsRequestedRaw = optionalNumber(payload, 'units');
  if (unitsRequestedRaw === null || !Number.isFinite(unitsRequestedRaw)) {
    throw new PurchaseFightersError('units is required');
  }
  const unitsRequested = Math.floor(unitsRequestedRaw);
  if (!Number.isInteger(unitsRequested) || unitsRequested <= 0) {
    throw new PurchaseFightersError('units must be a positive integer');
  }

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  const characterLabel =
    (typeof character.name === 'string' && character.name.trim() ? character.name : null) ??
    (characterLabelFallback && characterLabelFallback.trim() ? characterLabelFallback : null) ??
    character.character_id;

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  if (ship.in_hyperspace) {
    throw new PurchaseFightersError('Cannot purchase fighters while in hyperspace', 409);
  }
  if ((ship.current_sector ?? -1) !== 0) {
    throw new PurchaseFightersError(
      `Fighter armory is only available in sector 0. You are in sector ${ship.current_sector ?? 'unknown'}`,
      400,
    );
  }

  const definition = await loadShipDefinition(supabase, ship.ship_type);
  const maxFighters = definition.fighters ?? 0;
  const currentFighters = ship.current_fighters ?? maxFighters;
  const availableCapacity = maxFighters - currentFighters;
  if (availableCapacity <= 0) {
    throw new PurchaseFightersError('Fighter capacity is already at maximum');
  }

  const unitsToBuy = Math.min(unitsRequested, availableCapacity);
  const totalCost = unitsToBuy * FIGHTER_PRICE;
  const creditsBefore = ship.credits ?? 0;
  if (creditsBefore < totalCost) {
    throw new PurchaseFightersError(
      `Insufficient credits. Need ${totalCost} but only have ${creditsBefore}`,
    );
  }

  const newCredits = creditsBefore - totalCost;
  const newFighters = currentFighters + unitsToBuy;
  const { error: shipUpdateError } = await supabase
    .from('ship_instances')
    .update({
      credits: newCredits,
      current_fighters: newFighters,
    })
    .eq('ship_id', ship.ship_id);
  if (shipUpdateError) {
    console.error('purchase_fighters.ship_update', shipUpdateError);
    throw new PurchaseFightersError('Failed to update ship state', 500);
  }

  const timestamp = new Date().toISOString();
  const { error: activityError } = await supabase
    .from('characters')
    .update({ last_active: timestamp })
    .eq('character_id', characterId);
  if (activityError) {
    console.error('purchase_fighters.activity', activityError);
  }

  const statusPayload = await buildStatusPayload(supabase, characterId);
  const publicPlayer = buildPublicPlayerSnapshotFromStatus(statusPayload);
  const basePlayer = (statusPayload.player ?? {}) as Record<string, unknown>;
  const playerPayload: Record<string, unknown> = { ...basePlayer };
  if (typeof publicPlayer.id === 'string' && publicPlayer.id.trim()) {
    playerPayload['id'] = publicPlayer.id;
  }
  if (typeof publicPlayer.name === 'string' && publicPlayer.name.trim()) {
    playerPayload['name'] = publicPlayer.name;
  } else if (!playerPayload['name'] && typeof publicPlayer.id === 'string') {
    playerPayload['name'] = publicPlayer.id;
  }
  if (!playerPayload['player_type'] && typeof publicPlayer.player_type === 'string') {
    playerPayload['player_type'] = publicPlayer.player_type;
  }
  if (!playerPayload['corporation'] && Object.prototype.hasOwnProperty.call(publicPlayer, 'corporation')) {
    playerPayload['corporation'] = publicPlayer.corporation ?? null;
  }
  const displayCharacterId =
    (typeof playerPayload['id'] === 'string' && (playerPayload['id'] as string).trim()
      ? (playerPayload['id'] as string)
      : characterLabel);
  const sectorId = ship.current_sector ?? 0;
  const source = buildEventSource('purchase_fighters', requestId);

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'fighter.purchase',
    payload: {
      source,
      character_id: displayCharacterId,
      timestamp,
      sector: statusPayload.sector ?? { id: sectorId },
      units: unitsToBuy,
      price_per_unit: FIGHTER_PRICE,
      total_cost: totalCost,
      fighters_before: currentFighters,
      fighters_after: newFighters,
      max_fighters: maxFighters,
      credits_before: creditsBefore,
      credits_after: newCredits,
      ship: statusPayload.ship,
      player: playerPayload,
    },
    sectorId,
    shipId: ship.ship_id,
    requestId,
    actorCharacterId,
  });

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'status.update',
    payload: statusPayload,
    sectorId,
    shipId: ship.ship_id,
    requestId,
    actorCharacterId,
  });

  return successResponse({ request_id: requestId, units_purchased: unitsToBuy });
}
