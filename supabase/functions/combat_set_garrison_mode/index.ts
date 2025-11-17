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
    console.error('combat_set_garrison_mode.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const sector = optionalNumber(payload, 'sector');
  const mode = (optionalString(payload, 'mode') ?? 'offensive').toLowerCase();
  const tollAmount = optionalNumber(payload, 'toll_amount') ?? 0;
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  if (sector === null || sector === undefined) {
    return errorResponse('sector is required', 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'combat_set_garrison_mode');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_set_garrison_mode',
        requestId,
        detail: 'Too many requests',
        status: 429,
      });
      return errorResponse('Too many requests', 429);
    }
    console.error('combat_set_garrison_mode.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleCombatSetGarrisonMode({
      supabase,
      requestId,
      characterId,
      sector,
      mode,
      tollAmount,
      actorCharacterId,
      adminOverride,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'combat_set_garrison_mode',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('combat_set_garrison_mode.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    const detail = err instanceof Error ? err.message : 'set garrison mode failed';
    await emitErrorEvent(supabase, {
      characterId,
      method: 'combat_set_garrison_mode',
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  }
});

async function handleCombatSetGarrisonMode(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  sector: number;
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
    mode,
    tollAmount,
    actorCharacterId,
    adminOverride,
  } = params;

  // Validate mode
  if (!['offensive', 'defensive', 'toll'].includes(mode)) {
    const err = new Error('Invalid garrison mode') as Error & { status?: number };
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

  // Find garrison owned by character in this sector
  const { data: existingGarrisons, error: garrisonFetchError } = await supabase
    .from('garrisons')
    .select('owner_id, fighters, mode, toll_amount, toll_balance, deployed_at')
    .eq('sector_id', sector)
    .eq('owner_id', characterId)
    .maybeSingle();

  if (garrisonFetchError) {
    console.error('combat_set_garrison_mode.garrison_fetch', garrisonFetchError);
    const err = new Error('Failed to check existing garrison') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  if (!existingGarrisons) {
    const err = new Error('No garrison found for character in this sector') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  // Normalize toll amount (only applies to toll mode)
  const effectiveTollAmount = mode === 'toll' ? tollAmount : 0;

  // Update garrison mode
  const { data: updatedGarrison, error: garrisonUpdateError } = await supabase
    .from('garrisons')
    .update({
      mode,
      toll_amount: effectiveTollAmount,
      updated_at: new Date().toISOString(),
    })
    .eq('sector_id', sector)
    .eq('owner_id', characterId)
    .select()
    .single();

  if (garrisonUpdateError || !updatedGarrison) {
    console.error('combat_set_garrison_mode.garrison_update', garrisonUpdateError);
    const err = new Error('Failed to update garrison mode') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Build garrison payload for event
  const garrisonPayload = {
    owner_name: character.name,  // Human-readable name, not UUID
    fighters: updatedGarrison.fighters,
    fighter_loss: null,
    mode: updatedGarrison.mode,
    toll_amount: updatedGarrison.toll_amount,
    deployed_at: updatedGarrison.deployed_at,
    is_friendly: true,  // Garrison is always friendly to its owner
  };

  // Emit garrison.mode_changed event to character
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'garrison.mode_changed',
    payload: {
      source: buildEventSource('combat.set_garrison_mode', requestId),
      sector: { id: sector },
      garrison: garrisonPayload,
    },
    sectorId: sector,
    requestId,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  // Emit sector.update to all sector occupants
  const recipients = await computeSectorVisibilityRecipients(supabase, sector, []);
  if (recipients.length > 0) {
    await recordEventWithRecipients({
      supabase,
      eventType: 'sector.update',
      payload: {
        source: buildEventSource('combat.set_garrison_mode', requestId),
        sector: { id: sector },
      },
      recipients,
      sectorId: sector,
      actorCharacterId: characterId,
      requestId,
    });
  }

  return successResponse({ success: true });
}
