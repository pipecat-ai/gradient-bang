import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

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
import { computeSectorVisibilityRecipients } from '../_shared/visibility.ts';
import { recordEventWithRecipients } from '../_shared/events.ts';

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
    console.error('combat_collect_fighters.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const sector = optionalNumber(payload, 'sector');
  const quantity = optionalNumber(payload, 'quantity');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;
  const taskId = optionalString(payload, 'task_id');

  if (sector === null || sector === undefined) {
    return errorResponse('sector is required', 400);
  }
  if (quantity === null || quantity === undefined) {
    return errorResponse('quantity is required', 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'combat_collect_fighters');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_collect_fighters',
        requestId,
        detail: 'Too many requests',
        status: 429,
      });
      return errorResponse('Too many requests', 429);
    }
    console.error('combat_collect_fighters.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleCombatCollectFighters({
      supabase,
      requestId,
      characterId,
      sector,
      quantity,
      actorCharacterId,
      adminOverride,
      taskId,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_collect_fighters',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('combat_collect_fighters.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    const detail = err instanceof Error ? err.message : 'collect fighters failed';
    await emitErrorEvent(supabase, {
      characterId,
      method: 'combat_collect_fighters',
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  }
});

async function handleCombatCollectFighters(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  sector: number;
  quantity: number;
  actorCharacterId: string | null;
  adminOverride: boolean;
  taskId: string | null;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    sector,
    quantity,
    actorCharacterId,
    adminOverride,
    taskId,
  } = params;

  // Validate quantity
  if (quantity <= 0) {
    const err = new Error('Quantity must be positive') as Error & { status?: number };
    err.status = 400;
    throw err;
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

  // Verify character is in the correct sector (not strictly required for collection, but matches legacy)
  // Legacy doesn't check this, but it's a good sanity check
  // Actually, legacy DOES check via in_hyperspace, so we'll allow collection from any sector

  // Get all garrisons in this sector
  const { data: existingGarrisons, error: garrisonFetchError } = await supabase
    .from('garrisons')
    .select('owner_id, fighters, mode, toll_amount, toll_balance, deployed_at')
    .eq('sector_id', sector);

  if (garrisonFetchError) {
    console.error('combat_collect_fighters.garrison_fetch', garrisonFetchError);
    const err = new Error('Failed to check existing garrisons') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Check if character owns a garrison directly
  let ownGarrison = existingGarrisons?.find((g) => g.owner_id === characterId);

  // If not, check if character's corporation owns a garrison
  let collectorCorpId: string | null = null;
  if (!ownGarrison) {
    // Get character's corporation
    const { data: membershipData, error: membershipError } = await supabase
      .from('corporation_members')
      .select('corp_id')
      .eq('character_id', characterId)
      .is('left_at', null)
      .maybeSingle();

    if (membershipError) {
      console.error('combat_collect_fighters.membership_check', membershipError);
      // Continue without corp check - not a fatal error
    } else if (membershipData) {
      collectorCorpId = membershipData.corp_id;

      // Find garrisons owned by corp members
      const { data: corpMemberships, error: corpMemberError } = await supabase
        .from('corporation_members')
        .select('character_id')
        .eq('corp_id', collectorCorpId)
        .is('left_at', null);

      if (corpMemberError) {
        console.error('combat_collect_fighters.corp_members', corpMemberError);
      } else if (corpMemberships) {
        const corpMemberIds = new Set(corpMemberships.map(m => m.character_id));
        ownGarrison = existingGarrisons?.find((g) => corpMemberIds.has(g.owner_id));
      }
    }
  }

  if (!ownGarrison) {
    const err = new Error('No friendly garrison found in this sector') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  // Verify garrison has enough fighters
  if (quantity > ownGarrison.fighters) {
    console.log(`combat_collect_fighters.insufficient_fighters garrison=${ownGarrison.owner_id} has=${ownGarrison.fighters} requested=${quantity}`);
    const err = new Error(`Cannot collect more fighters than stationed: garrison has ${ownGarrison.fighters}, requested ${quantity}`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  // Calculate remaining fighters
  const remainingFighters = ownGarrison.fighters - quantity;
  const tollPayout = ownGarrison.mode === 'toll' ? (ownGarrison.toll_balance ?? 0) : 0;

  // Update ship fighters
  const currentFighters = ship.current_fighters ?? 0;
  const newShipFighters = currentFighters + quantity;
  const { error: shipUpdateError } = await supabase
    .from('ship_instances')
    .update({ current_fighters: newShipFighters, updated_at: new Date().toISOString() })
    .eq('ship_id', ship.ship_id);

  if (shipUpdateError) {
    console.error('combat_collect_fighters.ship_update', shipUpdateError);
    const err = new Error('Failed to update ship fighters') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Update ship credits if there's a toll payout
  let updatedCredits = ship.credits;
  if (tollPayout > 0) {
    updatedCredits = ship.credits + tollPayout;
    const { error: creditsUpdateError } = await supabase
      .from('ship_instances')
      .update({ credits: updatedCredits, updated_at: new Date().toISOString() })
      .eq('ship_id', ship.ship_id);

    if (creditsUpdateError) {
      console.error('combat_collect_fighters.credits_update', creditsUpdateError);
      const err = new Error('Failed to update ship credits') as Error & { status?: number };
      err.status = 500;
      throw err;
    }

    // Emit status.update for toll payout
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'status.update',
      payload: {
        source: buildEventSource('combat.collect_fighters', requestId),
        sector: { id: sector },
        credits: updatedCredits,
        ship: {
          ship_id: ship.ship_id,
          ship_type: ship.ship_type,
          credits: updatedCredits,
          current_fighters: newShipFighters,
        },
      },
      sectorId: sector,
      requestId,
      taskId,
      actorCharacterId: characterId,
      corpId: character.corporation_id,
    });
  }

  // Update or remove garrison
  let updatedGarrison: typeof ownGarrison | null = null;
  if (remainingFighters > 0) {
    const { data: updatedData, error: garrisonUpdateError } = await supabase
      .from('garrisons')
      .update({
        fighters: remainingFighters,
        toll_balance: 0, // Reset toll balance when collected
        updated_at: new Date().toISOString(),
      })
      .eq('sector_id', sector)
      .eq('owner_id', ownGarrison.owner_id)
      .select()
      .single();

    if (garrisonUpdateError || !updatedData) {
      console.error('combat_collect_fighters.garrison_update', garrisonUpdateError);
      const err = new Error('Failed to update garrison') as Error & { status?: number };
      err.status = 500;
      throw err;
    }
    updatedGarrison = updatedData;
  } else {
    // Remove garrison entirely
    const { error: garrisonDeleteError } = await supabase
      .from('garrisons')
      .delete()
      .eq('sector_id', sector)
      .eq('owner_id', ownGarrison.owner_id);

    if (garrisonDeleteError) {
      console.error('combat_collect_fighters.garrison_delete', garrisonDeleteError);
      const err = new Error('Failed to remove garrison') as Error & { status?: number };
      err.status = 500;
      throw err;
    }
  }

  // Build garrison payload for event
  // Fetch garrison owner's name for the event
  let garrisonOwnerName: string | null = null;
  if (updatedGarrison) {
    const ownerChar = await loadCharacter(supabase, updatedGarrison.owner_id);
    garrisonOwnerName = ownerChar.name;
  }

  const garrisonPayload = updatedGarrison ? {
    owner_name: garrisonOwnerName!,  // Human-readable name, not UUID
    fighters: updatedGarrison.fighters,
    fighter_loss: null,
    mode: updatedGarrison.mode,
    toll_amount: updatedGarrison.toll_amount,
    deployed_at: updatedGarrison.deployed_at,
    is_friendly: updatedGarrison.owner_id === characterId,  // Friendly if collector owns it
  } : null;

  // Emit garrison.collected event to character
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'garrison.collected',
    payload: {
      source: buildEventSource('combat.collect_fighters', requestId),
      sector: { id: sector },
      credits_collected: tollPayout,
      garrison: garrisonPayload,
      fighters_on_ship: newShipFighters,
    },
    sectorId: sector,
    requestId,
    taskId,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  // Emit sector.update to all sector occupants
  const recipients = await computeSectorVisibilityRecipients(supabase, sector, []);
  if (recipients.length > 0) {
    // Build sector update payload
    // For now, we'll emit a simple notification that sector contents changed
    // The full sector_contents payload would require loading all sector data
    await recordEventWithRecipients({
      supabase,
      eventType: 'sector.update',
      payload: {
        source: buildEventSource('combat.collect_fighters', requestId),
        sector: { id: sector },
        // TODO: Add full sector contents if needed
      },
      recipients,
      sectorId: sector,
      actorCharacterId: characterId,
      requestId,
      taskId,
    });
  }

  return successResponse({ success: true });
}
