import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { loadCharacter, loadShip } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';

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
    console.error('combat_leave_fighters.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const sector = optionalNumber(payload, 'sector');
  const quantity = optionalNumber(payload, 'quantity');
  const mode = (optionalString(payload, 'mode') ?? 'offensive').toLowerCase();
  const tollAmount = optionalNumber(payload, 'toll_amount') ?? 0;
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  if (sector === null || sector === undefined) {
    return errorResponse('sector is required', 400);
  }
  if (quantity === null || quantity === undefined) {
    return errorResponse('quantity is required', 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'combat_leave_fighters');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_leave_fighters',
        requestId,
        detail: 'Too many requests',
        status: 429,
      });
      return errorResponse('Too many requests', 429);
    }
    console.error('combat_leave_fighters.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleCombatLeaveFighters({
      supabase,
      requestId,
      characterId,
      sector,
      quantity,
      mode,
      tollAmount,
      actorCharacterId,
      adminOverride,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_leave_fighters',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('combat_leave_fighters.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    await emitErrorEvent(supabase, {
      characterId,
      method: 'combat_leave_fighters',
      requestId,
      detail: err instanceof Error ? err.message : 'leave fighters failed',
      status,
    });
    return errorResponse('leave fighters error', status);
  }
});

async function handleCombatLeaveFighters(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  sector: number;
  quantity: number;
  mode: string;
  tollAmount: number;
  actorCharacterId: string | null;
  adminOverride: boolean;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    sector,
    quantity,
    mode,
    tollAmount,
    actorCharacterId,
    adminOverride,
  } = params;

  // Validate quantity
  if (quantity <= 0) {
    const err = new Error('Quantity must be positive') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  // Validate mode
  if (!['offensive', 'defensive', 'toll'].includes(mode)) {
    const err = new Error('Invalid garrison mode') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  // Normalize toll amount
  let effectiveTollAmount = tollAmount;
  if (mode !== 'toll') {
    effectiveTollAmount = 0;
  }

  // Load character and ship
  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  // Verify character is in the correct sector
  if (ship.current_sector !== sector) {
    console.log(`combat_leave_fighters.sector_mismatch char=${characterId} ship_sector=${ship.current_sector} requested=${sector}`);
    const err = new Error(`Character in sector ${ship.current_sector}, not requested sector ${sector}`) as Error & { status?: number };
    err.status = 409;
    throw err;
  }

  // Check ship has enough fighters
  const currentFighters = ship.current_fighters ?? 0;
  if (quantity > currentFighters) {
    console.log(`combat_leave_fighters.insufficient_fighters ship=${ship.ship_id} has=${currentFighters} requested=${quantity}`);
    const err = new Error(`Insufficient fighters: ship has ${currentFighters}, requested ${quantity}`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  // Check for other players' garrisons in this sector
  const { data: existingGarrisons, error: garrisonFetchError } = await supabase
    .from('garrisons')
    .select('owner_id, fighters, mode, toll_amount, toll_balance, deployed_at')
    .eq('sector_id', sector);

  if (garrisonFetchError) {
    console.error('combat_leave_fighters.garrison_fetch', garrisonFetchError);
    const err = new Error('Failed to check existing garrisons') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Find existing garrison from character
  const ownGarrison = existingGarrisons?.find((g) => g.owner_id === characterId);
  const otherGarrison = existingGarrisons?.find((g) => g.owner_id !== characterId);

  if (otherGarrison) {
    const err = new Error(
      'Sector already contains another player\'s garrison; clear it before deploying your fighters.',
    ) as Error & { status?: number };
    err.status = 409;
    throw err;
  }

  // Calculate new total fighters
  const existingFighters = ownGarrison?.fighters ?? 0;
  const newTotal = existingFighters + quantity;
  const existingTollBalance = ownGarrison?.toll_balance ?? 0;

  // Update ship fighters
  const newShipFighters = currentFighters - quantity;
  const { error: shipUpdateError } = await supabase
    .from('ship_instances')
    .update({ current_fighters: newShipFighters, updated_at: new Date().toISOString() })
    .eq('ship_id', ship.ship_id);

  if (shipUpdateError) {
    console.error('combat_leave_fighters.ship_update', shipUpdateError);
    const err = new Error('Failed to update ship fighters') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Upsert garrison
  const { data: updatedGarrison, error: garrisonUpsertError } = await supabase
    .from('garrisons')
    .upsert(
      {
        sector_id: sector,
        owner_id: characterId,
        fighters: newTotal,
        mode,
        toll_amount: effectiveTollAmount,
        toll_balance: existingTollBalance,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'sector_id,owner_id' },
    )
    .select()
    .single();

  if (garrisonUpsertError || !updatedGarrison) {
    console.error('combat_leave_fighters.garrison_upsert', garrisonUpsertError);
    const err = new Error('Failed to deploy garrison') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Build garrison payload for events
  const garrisonPayload = {
    owner_name: characterId,
    fighters: updatedGarrison.fighters,
    fighter_loss: null,
    mode: updatedGarrison.mode,
    toll_amount: updatedGarrison.toll_amount,
    deployed_at: updatedGarrison.deployed_at,
  };

  // Emit garrison.deployed event to character
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'garrison.deployed',
    payload: {
      source: buildEventSource('combat.leave_fighters', requestId),
      sector: { id: sector },
      garrison: garrisonPayload,
      fighters_remaining: newShipFighters,
    },
    sectorId: sector,
    requestId,
    actorCharacterId: characterId,
  });

  // TODO: Emit sector.update to all sector occupants (omitted for initial deployment)
  // TODO: If mode is 'offensive', auto-initiate combat with sector occupants

  return successResponse({ success: true });
}
