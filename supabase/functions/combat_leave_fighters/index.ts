import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import {
  emitCharacterEvent,
  emitErrorEvent,
  emitSectorEnvelope,
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
import { loadCharacterCombatants, loadCharacterNames, loadGarrisonCombatants } from '../_shared/combat_participants.ts';
import { nowIso, type CombatEncounterState } from '../_shared/combat_types.ts';
import { loadCombatForSector, persistCombatState } from '../_shared/combat_state.ts';
import { buildRoundWaitingPayload } from '../_shared/combat_events.ts';
import { computeNextCombatDeadline } from '../_shared/combat_resolution.ts';

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
    owner_name: character.name,  // Human-readable name, not UUID
    fighters: updatedGarrison.fighters,
    fighter_loss: null,
    mode: updatedGarrison.mode,
    toll_amount: updatedGarrison.toll_amount,
    deployed_at: updatedGarrison.deployed_at,
    is_friendly: true,  // Garrison is always friendly to its owner
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
    senderId: characterId,
    sectorId: sector,
    requestId,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  // TODO: Emit sector.update to all sector occupants (omitted for initial deployment)

  // If mode is 'offensive', auto-initiate combat with sector occupants
  if (mode === 'offensive') {
    await autoInitiateCombatIfOffensive({
      supabase,
      characterId,
      sector,
      requestId,
      garrisonFighters: updatedGarrison.fighters,
    });
  }

  return successResponse({ success: true });
}

function deterministicSeed(combatId: string): number {
  const normalized = combatId.replace(/[^0-9a-f]/gi, '').slice(0, 12) || combatId;
  const parsed = Number.parseInt(normalized, 16);
  if (Number.isFinite(parsed)) {
    return parsed >>> 0;
  }
  return Math.floor(Math.random() * 1_000_000);
}

function generateCombatId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

async function autoInitiateCombatIfOffensive(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  sector: number;
  requestId: string;
  garrisonFighters: number;
}): Promise<void> {
  const { supabase, characterId, sector, requestId, garrisonFighters } = params;

  // Load all character combatants in the sector
  const participantStates = await loadCharacterCombatants(supabase, sector);

  // Get garrison owner's corporation membership
  const { data: ownerCorpData } = await supabase
    .from('corporation_members')
    .select('corp_id')
    .eq('character_id', characterId)
    .is('left_at', null)
    .maybeSingle();
  const ownerCorpId = ownerCorpData?.corp_id ?? null;

  // Find targetable opponents (exclude self, corp members, escape pods, no-fighter ships)
  const opponents = participantStates.filter((participant) => {
    if (participant.combatant_id === characterId) return false;
    if (participant.is_escape_pod) return false;
    if ((participant.fighters ?? 0) <= 0) return false;

    // Check if same corporation
    if (ownerCorpId && participant.metadata?.corporation_id === ownerCorpId) return false;

    return true;
  });

  // No opponents to fight
  if (opponents.length === 0) {
    return;
  }

  // Check if combat already exists in this sector
  const existingEncounter = await loadCombatForSector(supabase, sector);
  if (existingEncounter && !existingEncounter.ended) {
    // Combat already ongoing, don't create a new one
    return;
  }

  // Load character names for garrison display
  const ownerNames = await loadCharacterNames(
    supabase,
    participantStates.map((state) => state.owner_character_id ?? state.combatant_id),
  );

  // Load all garrisons (including the one just deployed)
  const garrisons = await loadGarrisonCombatants(supabase, sector, ownerNames);

  // Build participants map
  const participants: Record<string, CombatantState> = {};
  for (const state of participantStates) {
    participants[state.combatant_id] = state;
  }
  for (const garrison of garrisons) {
    participants[garrison.state.combatant_id] = garrison.state;
  }

  // Must have at least 2 participants
  if (Object.keys(participants).length < 2) {
    return;
  }

  // Create new combat encounter
  const combatId = generateCombatId();
  const encounter: CombatEncounterState = {
    combat_id: combatId,
    sector_id: sector,
    round: 1,
    deadline: computeNextCombatDeadline(),
    participants,
    pending_actions: {},
    logs: [],
    context: {
      initiator: characterId,
      created_at: nowIso(),
      garrison_sources: garrisons.map((g) => g.source),
      reason: 'garrison_deploy_auto',
    },
    awaiting_resolution: false,
    ended: false,
    end_state: null,
    base_seed: deterministicSeed(combatId),
    last_updated: nowIso(),
  };

  // Persist combat state
  await persistCombatState(supabase, encounter);

  // Emit combat.round_waiting events to all participants
  await emitRoundWaitingEvents(supabase, encounter, requestId, characterId);
}

async function emitRoundWaitingEvents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  encounter: CombatEncounterState,
  requestId: string,
  senderId: string | null,
): Promise<void> {
  const payload = buildRoundWaitingPayload(encounter);
  const source = buildEventSource('combat.round_waiting', requestId);
  payload.source = source;

  const recipients = Object.values(encounter.participants)
    .filter((participant) => participant.combatant_type === 'character')
    .map((participant) => participant.owner_character_id ?? participant.combatant_id);

  await Promise.all(
    recipients.map((recipient) =>
      emitCharacterEvent({
        supabase,
        characterId: recipient,
        eventType: 'combat.round_waiting',
        payload,
        sectorId: encounter.sector_id,
        requestId,
        senderId,
        actorCharacterId: recipient,
      }),
    ),
  );

  await emitSectorEnvelope({
    supabase,
    sectorId: encounter.sector_id,
    eventType: 'combat.round_waiting',
    payload,
    requestId,
    senderId,
  });
}
