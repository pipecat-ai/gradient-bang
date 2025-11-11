import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { buildStatusPayload, loadCharacter, loadShip, type ShipRow, type CharacterRow } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
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

class TransferCreditsError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TransferCreditsError';
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
    console.error('transfer_credits.parse', err);
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

  try {
    await enforceRateLimit(supabase, fromCharacterId, 'transfer_credits');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: 'transfer_credits',
        requestId,
        detail: 'Too many transfer_credits requests',
        status: 429,
      });
      return errorResponse('Too many transfer_credits requests', 429);
    }
    console.error('transfer_credits.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleTransfer(supabase, payload, fromCharacterId, toPlayerName, requestId, actorCharacterId, adminOverride);
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: 'transfer_credits',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof TransferCreditsError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: 'transfer_credits',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('transfer_credits.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function handleTransfer(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  fromCharacterId: string,
  toPlayerName: string,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
): Promise<Response> {
  const amountRaw = optionalNumber(payload, 'amount');
  if (amountRaw === null || !Number.isInteger(amountRaw) || amountRaw <= 0) {
    throw new TransferCreditsError('Amount must be a positive integer', 400);
  }
  const amount = Math.floor(amountRaw);

  const fromRecord = await fetchCharacterAndShip(supabase, fromCharacterId);
  await ensureActorAuthorization({
    supabase,
    ship: fromRecord.ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: fromCharacterId,
  });
  const toRecord = await resolveCharacterByNameAndSector(
    supabase,
    toPlayerName,
    fromRecord.ship.current_sector,
    fromCharacterId,
  );
  if (!toRecord) {
    throw new TransferCreditsError('Target player not found in this sector', 404);
  }

  if (fromRecord.ship.in_hyperspace) {
    throw new TransferCreditsError('Sender is in hyperspace, cannot transfer credits', 400);
  }
  if (toRecord.ship.in_hyperspace) {
    throw new TransferCreditsError('Receiver is in hyperspace, cannot transfer credits', 400);
  }
  if (fromRecord.ship.current_sector !== toRecord.ship.current_sector) {
    throw new TransferCreditsError('Characters must be in the same sector', 400);
  }
  if (toRecord.character.character_id === fromCharacterId) {
    throw new TransferCreditsError('Cannot transfer credits to yourself', 400);
  }

  const senderCredits = fromRecord.ship.credits ?? 0;
  if (senderCredits < amount) {
    throw new TransferCreditsError(`Insufficient credits. ${fromCharacterId} only has ${senderCredits}`, 400);
  }

  await Promise.all([
    supabase
      .from('ship_instances')
      .update({ credits: senderCredits - amount })
      .eq('ship_id', fromRecord.ship.ship_id),
    supabase
      .from('ship_instances')
      .update({ credits: (toRecord.ship.credits ?? 0) + amount })
      .eq('ship_id', toRecord.ship.ship_id),
  ]);

  const source = buildEventSource('transfer_credits', requestId);
  const fromStatus = await buildStatusPayload(supabase, fromCharacterId);
  const toStatus = await buildStatusPayload(supabase, toRecord.character.character_id);

  await emitCharacterEvent({
    supabase,
    characterId: fromCharacterId,
    eventType: 'credits.transfer',
    payload: buildTransferPayload('sent', amount, fromStatus.player, toStatus.player, fromRecord.ship.current_sector ?? 0, source),
    requestId,
  });

  await emitCharacterEvent({
    supabase,
    characterId: toRecord.character.character_id,
    eventType: 'credits.transfer',
    payload: buildTransferPayload('received', amount, fromStatus.player, toStatus.player, fromRecord.ship.current_sector ?? 0, source),
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
    characterId: toRecord.character.character_id,
    eventType: 'status.update',
    payload: toStatus,
    requestId,
  });

  return successResponse({ request_id: requestId });
}

function buildTransferPayload(
  direction: 'sent' | 'received',
  amount: number,
  fromPlayer: Record<string, unknown>,
  toPlayer: Record<string, unknown>,
  sectorId: number,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return {
    transfer_direction: direction,
    transfer_details: { credits: amount },
    from: fromPlayer,
    to: toPlayer,
    sector: { id: sectorId },
    timestamp: new Date().toISOString(),
    source,
  };
}

async function fetchCharacterAndShip(
  supabase: SupabaseClient,
  characterId: string,
): Promise<{ character: CharacterRow; ship: ShipRow }> {
  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  return { character, ship };
}

async function resolveCharacterByNameAndSector(
  supabase: SupabaseClient,
  playerName: string,
  sectorId: number | null,
  excludeCharacterId: string,
): Promise<{ character: { character_id: string; name: string; current_ship_id: string }; ship: { ship_id: string; ship_type: string; ship_name: string | null; current_sector: number | null; in_hyperspace: boolean; credits: number | null } } | null> {
  if (sectorId === null) {
    return null;
  }
  const pattern = playerName.replace(/[%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await supabase
    .from('characters')
    .select('character_id, name, current_ship_id')
    .ilike('name', pattern)
    .neq('character_id', excludeCharacterId)
    .limit(5);

  if (error) {
    console.error('transfer_credits.lookup', error);
    throw new TransferCreditsError('Failed to lookup target player', 500);
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
      console.error('transfer_credits.lookup_ship', err);
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
        current_ship_id: candidate.current_ship_id,
      },
      ship: {
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        ship_name: ship.ship_name,
        current_sector: ship.current_sector,
        in_hyperspace: ship.in_hyperspace,
        credits: ship.credits,
      },
    };
  }

  return null;
}
