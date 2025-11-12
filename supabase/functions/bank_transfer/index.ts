import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { buildStatusPayload, loadCharacter, loadShip } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import { canonicalizeCharacterId } from '../_shared/ids.ts';
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
  const actorCharacterLabel = optionalString(payload, 'actor_character_id');
  const actorCharacterId = actorCharacterLabel ? await canonicalizeCharacterId(actorCharacterLabel) : null;
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
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId: actorCharacterId ?? 'unknown',
        method: 'bank_transfer',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
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
  const sourceCharacterLabel = optionalString(payload, 'character_id');
  const sourceCharacterId = sourceCharacterLabel ? await canonicalizeCharacterId(sourceCharacterLabel) : null;

  const ship = await loadShip(supabase, shipId);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: sourceCharacterId ?? ship.owner_character_id ?? ship.owner_id ?? ship.ship_id,
  });
  if (ship.current_sector !== BANK_SECTOR || ship.in_hyperspace) {
    throw new BankTransferError('Deposits require the ship to be docked at the Megaport (sector 0)', 400);
  }

  const ownerId = ship.owner_character_id ?? ship.owner_id;

  const target = await findCharacterByName(supabase, targetPlayerName);
  if (!target) {
    throw new BankTransferError('Target player not found', 404);
  }
  const targetCharacterId = target.character_id;

  try {
    await enforceRateLimit(supabase, ownerId ?? targetCharacterId, 'bank_transfer');
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new BankTransferError('Too many bank_transfer requests', 429);
    }
    console.error('bank_transfer.rate_limit', err);
    throw new BankTransferError('rate limit error', 500);
  }

  const shipCreditsBefore = ship.credits ?? 0;
  if (shipCreditsBefore < amount) {
    throw new BankTransferError('Insufficient ship credits for deposit', 400);
  }

  await supabase
    .from('ship_instances')
    .update({ credits: shipCreditsBefore - amount })
    .eq('ship_id', shipId);

  const bankBefore = target.credits_in_megabank ?? 0;
  await supabase
    .from('characters')
    .update({ credits_in_megabank: bankBefore + amount })
    .eq('character_id', targetCharacterId);

  const source = buildEventSource('bank_transfer', requestId);
  const timestamp = new Date().toISOString();

  const targetStatus = await buildStatusPayload(supabase, targetCharacterId);
  const targetDisplayId = resolveDisplayIdFromStatus(targetStatus, target.name ?? targetPlayerName, targetCharacterId);

  const resolvedSourceCharacter = sourceCharacterId ?? ship.owner_character_id ?? targetCharacterId;
  let sourceStatus: Record<string, unknown> | null = null;
  if (resolvedSourceCharacter && resolvedSourceCharacter !== targetCharacterId) {
    sourceStatus = await buildStatusPayload(supabase, resolvedSourceCharacter);
  }
  const sourceDisplayId =
    resolvedSourceCharacter === targetCharacterId
      ? targetDisplayId
      : resolveDisplayIdFromStatus(
          sourceStatus,
          sourceCharacterLabel,
          resolvedSourceCharacter ?? targetDisplayId,
        );

  await emitBankTransaction(
    supabase,
    targetCharacterId,
    buildDepositPayload({
      source,
      amount,
      shipId: resolveLegacyShipId(targetStatus, shipId, targetDisplayId),
      shipCreditsBefore,
      shipCreditsAfter: shipCreditsBefore - amount,
      bankBefore,
      bankAfter: bankBefore + amount,
      timestamp,
      targetCharacterId: targetDisplayId,
      sourceCharacterId: sourceDisplayId,
    }),
    {
      requestId,
      sectorId: BANK_SECTOR,
      shipId,
      actorCharacterId,
    },
  );

  await emitCharacterEvent({
    supabase,
    characterId: targetCharacterId,
    eventType: 'status.update',
    payload: targetStatus,
    requestId,
    sectorId: BANK_SECTOR,
    shipId,
    actorCharacterId,
  });

  if (resolvedSourceCharacter && resolvedSourceCharacter !== targetCharacterId) {
    const ownerStatus = sourceStatus ?? (await buildStatusPayload(supabase, resolvedSourceCharacter));
    await emitCharacterEvent({
      supabase,
      characterId: resolvedSourceCharacter,
      eventType: 'status.update',
      payload: ownerStatus,
      requestId,
      sectorId: BANK_SECTOR,
      shipId,
      actorCharacterId,
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
  const characterLabel = requireString(payload, 'character_id');
  const characterId = await canonicalizeCharacterId(characterLabel);
  const amount = requirePositiveInt(payload, 'amount');

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
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
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

  const statusPayload = await buildStatusPayload(supabase, characterId);
  const timestamp = new Date().toISOString();
  const source = buildEventSource('bank_transfer', requestId);
  await emitBankTransaction(
    supabase,
    characterId,
    buildWithdrawPayload({
      source,
      amount,
      shipCreditsBefore: ship.credits ?? 0,
      shipCreditsAfter: (ship.credits ?? 0) + amount,
      bankBefore: bankBalance,
      bankAfter: bankBalance - amount,
      timestamp,
      characterId: resolveDisplayIdFromStatus(statusPayload, characterLabel, characterId),
    }),
    {
      requestId,
      sectorId: BANK_SECTOR,
      shipId: ship.ship_id,
      actorCharacterId,
    },
  );

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'status.update',
    payload: statusPayload,
    requestId,
    sectorId: BANK_SECTOR,
    shipId: ship.ship_id,
    actorCharacterId,
  });

  return successResponse({ request_id: requestId });
}

async function emitBankTransaction(
  supabase: SupabaseClient,
  characterId: string,
  payload: Record<string, unknown>,
  options: { requestId?: string | null; sectorId?: number | null; shipId?: string | null; actorCharacterId?: string | null } = {},
): Promise<void> {
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'bank.transaction',
    payload,
    requestId: options.requestId,
    sectorId: options.sectorId,
    shipId: options.shipId ?? undefined,
    actorCharacterId: options.actorCharacterId ?? null,
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
): Promise<{ character_id: string; credits_in_megabank: number | null; name: string | null } | null> {
  const pattern = name.replace(/[%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await supabase
    .from('characters')
    .select('character_id, credits_in_megabank, name')
    .ilike('name', pattern)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('bank_transfer.lookup', error);
    throw new BankTransferError('Failed to lookup target player', 500);
  }
  return data ?? null;
}

function resolveDisplayIdFromStatus(
  statusPayload: Record<string, unknown> | null,
  fallbackName: string | null,
  fallbackId: string,
): string {
  if (statusPayload && typeof statusPayload === 'object') {
    const player = (statusPayload['player'] ?? {}) as Record<string, unknown>;
    const name = typeof player['name'] === 'string' ? (player['name'] as string) : null;
    if (name && name.trim()) {
      return name;
    }
    const playerId = typeof player['id'] === 'string' ? (player['id'] as string) : null;
    if (playerId && playerId.trim()) {
      return playerId;
    }
  }
  if (fallbackName && fallbackName.trim()) {
    return fallbackName;
  }
  return fallbackId;
}

function buildDepositPayload(params: {
  source: Record<string, unknown>;
  amount: number;
  shipId: string;
  shipCreditsBefore: number;
  shipCreditsAfter: number;
  bankBefore: number;
  bankAfter: number;
  timestamp: string;
  targetCharacterId: string;
  sourceCharacterId: string | null;
}): Record<string, unknown> {
  return {
    source: params.source,
    target_character_id: params.targetCharacterId,
    source_character_id: params.sourceCharacterId,
    ship_id: params.shipId,
    direction: 'deposit',
    amount: params.amount,
    timestamp: params.timestamp,
    ship_credits_before: params.shipCreditsBefore,
    ship_credits_after: params.shipCreditsAfter,
    credits_in_bank_before: params.bankBefore,
    credits_in_bank_after: params.bankAfter,
  };
}

function buildWithdrawPayload(params: {
  source: Record<string, unknown>;
  amount: number;
  shipCreditsBefore: number;
  shipCreditsAfter: number;
  bankBefore: number;
  bankAfter: number;
  timestamp: string;
  characterId: string;
}): Record<string, unknown> {
  return {
    source: params.source,
    character_id: params.characterId,
    sector: { id: BANK_SECTOR },
    direction: 'withdraw',
    amount: params.amount,
    timestamp: params.timestamp,
    ship_credits_before: params.shipCreditsBefore,
    ship_credits_after: params.shipCreditsAfter,
    credits_in_bank_before: params.bankBefore,
    credits_in_bank_after: params.bankAfter,
  };
}

function resolveLegacyShipId(statusPayload: Record<string, unknown>, fallback: string, characterLabel: string): string {
  if (statusPayload && typeof statusPayload === 'object') {
    const ship = statusPayload['ship'];
    if (ship && typeof ship === 'object') {
      const statusShipId = (ship as Record<string, unknown>)['ship_id'];
      if (typeof statusShipId === 'string' && statusShipId.trim()) {
        if (!looksLikeUuid(characterLabel) && looksLikeUuid(statusShipId)) {
          return `${characterLabel}-ship`;
        }
        return statusShipId;
      }
    }
  }
  if (characterLabel && !looksLikeUuid(characterLabel) && looksLikeUuid(fallback)) {
    return `${characterLabel}-ship`;
  }
  return fallback;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}
