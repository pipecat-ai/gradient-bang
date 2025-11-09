import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { buildStatusPayload, loadCharacter, loadShip } from '../_shared/status.ts';
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

const BANK_SECTOR = 0;

class BankTransferError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BankTransferError';
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
    console.error('bank_transfer.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const direction = requireString(payload, 'direction');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  try {
    if (direction === 'deposit') {
      return await handleDeposit(supabase, payload, requestId, actorCharacterId, adminOverride);
    }
    if (direction === 'withdraw') {
      return await handleWithdraw(supabase, payload, requestId, actorCharacterId, adminOverride);
    }
    throw new BankTransferError("direction must be 'deposit' or 'withdraw'", 400);
  } catch (err) {
    if (err instanceof BankTransferError) {
      await emitErrorEvent(supabase, {
        characterId: actorCharacterId ?? 'unknown',
        method: 'bank_transfer',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('bank_transfer.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function handleDeposit(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
): Promise<Response> {
  const shipId = requireString(payload, 'ship_id');
  const targetPlayerName = requireString(payload, 'target_player_name');
  const amount = requirePositiveInt(payload, 'amount');

  const ship = await loadShip(supabase, shipId);
  if (ship.current_sector !== BANK_SECTOR || ship.in_hyperspace) {
    throw new BankTransferError('Deposits require the ship to be docked at the Megaport (sector 0)', 400);
  }

  const ownerId = ship.owner_id;

  if (ownerId && actorCharacterId && ownerId !== actorCharacterId && !adminOverride) {
    throw new BankTransferError('Cannot deposit from another pilot’s ship without admin override', 403);
  }

  const target = await findCharacterByName(supabase, targetPlayerName);
  if (!target) {
    throw new BankTransferError('Target player not found', 404);
  }

  try {
    await enforceRateLimit(supabase, ownerId ?? target.character_id, 'bank_transfer');
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new BankTransferError('Too many bank_transfer requests', 429);
    }
    console.error('bank_transfer.rate_limit', err);
    throw new BankTransferError('rate limit error', 500);
  }

  if ((ship.credits ?? 0) < amount) {
    throw new BankTransferError('Insufficient ship credits for deposit', 400);
  }

  await supabase
    .from('ship_instances')
    .update({ credits: (ship.credits ?? 0) - amount })
    .eq('ship_id', shipId);

  await supabase
    .from('characters')
    .update({ credits_in_megabank: (target.credits_in_megabank ?? 0) + amount })
    .eq('character_id', target.character_id);

  const source = buildEventSource('bank_transfer', requestId);
  await emitBankTransaction(
    supabase,
    target.character_id,
    {
      source,
      direction: 'deposit',
      amount,
      ship_credits_before: ship.credits ?? 0,
      ship_credits_after: (ship.credits ?? 0) - amount,
      credits_in_bank_before: target.credits_in_megabank ?? 0,
      credits_in_bank_after: (target.credits_in_megabank ?? 0) + amount,
    },
  );

  const targetStatus = await buildStatusPayload(supabase, target.character_id);
  await emitCharacterEvent({
    supabase,
    characterId: target.character_id,
    eventType: 'status.update',
    payload: targetStatus,
    requestId,
  });

  if (ownerId && ownerId !== target.character_id) {
    const ownerStatus = await buildStatusPayload(supabase, ownerId);
    await emitCharacterEvent({
      supabase,
      characterId: ownerId,
      eventType: 'status.update',
      payload: ownerStatus,
      requestId,
    });
  }

  return successResponse({ request_id: requestId });
}

async function handleWithdraw(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
): Promise<Response> {
  const characterId = requireString(payload, 'character_id');
  const amount = requirePositiveInt(payload, 'amount');

  if (actorCharacterId && actorCharacterId !== characterId && !adminOverride) {
    throw new BankTransferError('actor_character_id must match character_id unless admin_override is true', 403);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'bank_transfer');
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new BankTransferError('Too many bank_transfer requests', 429);
    }
    console.error('bank_transfer.rate_limit', err);
    throw new BankTransferError('rate limit error', 500);
  }

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  if (ship.current_sector !== BANK_SECTOR || ship.in_hyperspace) {
    throw new BankTransferError('Withdrawals require the pilot to be at the Megaport (sector 0)', 400);
  }

  const bankBalance = character.credits_in_megabank ?? 0;
  if (bankBalance < amount) {
    throw new BankTransferError('Insufficient bank balance', 400);
  }

  await supabase
    .from('characters')
    .update({ credits_in_megabank: bankBalance - amount })
    .eq('character_id', characterId);

  await supabase
    .from('ship_instances')
    .update({ credits: (ship.credits ?? 0) + amount })
    .eq('ship_id', ship.ship_id);

  const source = buildEventSource('bank_transfer', requestId);
  await emitBankTransaction(
    supabase,
    characterId,
    {
      source,
      direction: 'withdraw',
      amount,
      ship_credits_before: ship.credits ?? 0,
      ship_credits_after: (ship.credits ?? 0) + amount,
      credits_in_bank_before: bankBalance,
      credits_in_bank_after: bankBalance - amount,
    },
  );

  const statusPayload = await buildStatusPayload(supabase, characterId);
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'status.update',
    payload: statusPayload,
    requestId,
  });

  return successResponse({ request_id: requestId });
}

async function emitBankTransaction(
  supabase: SupabaseClient,
  characterId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'bank.transaction',
    payload,
  });
}

function requirePositiveInt(payload: Record<string, unknown>, key: string): number {
  const value = optionalNumber(payload, key);
  if (value === null || !Number.isInteger(value) || value <= 0) {
    throw new BankTransferError(`${key} must be a positive integer`, 400);
  }
  return Math.floor(value);
}

async function findCharacterByName(
  supabase: SupabaseClient,
  name: string,
): Promise<{ character_id: string; credits_in_megabank: number | null } | null> {
  const pattern = name.replace(/[%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await supabase
    .from('characters')
    .select('character_id, credits_in_megabank')
    .ilike('name', pattern)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('bank_transfer.lookup', error);
    throw new BankTransferError('Failed to lookup target player', 500);
  }
  return data ?? null;
}
