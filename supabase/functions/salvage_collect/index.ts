import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
  emitSectorEnvelope,
} from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { loadCharacter, loadShip, loadShipDefinition, buildStatusPayload } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import { computeSectorVisibilityRecipients } from '../_shared/visibility.ts';
import { recordEventWithRecipients } from '../_shared/events.ts';
import type { SalvageEntry } from '../_shared/salvage.ts';
import { buildSectorSnapshot } from '../_shared/map.ts';

const VALID_COMMODITIES = new Set(['quantum_foam', 'retro_organics', 'neuro_symbolics']);

// Mapping from full commodity names to database column suffixes
const COMMODITY_TO_COLUMN: Record<string, string> = {
  'quantum_foam': 'qf',
  'retro_organics': 'ro',
  'neuro_symbolics': 'ns',
};

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
    console.error('salvage_collect.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const salvageId = requireString(payload, 'salvage_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  try {
    await enforceRateLimit(supabase, characterId, 'salvage_collect');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'salvage_collect',
        requestId,
        detail: 'Too many requests',
        status: 429,
      });
      return errorResponse('Too many requests', 429);
    }
    console.error('salvage_collect.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleSalvageCollect({
      supabase,
      requestId,
      characterId,
      salvageId,
      actorCharacterId,
      adminOverride,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'salvage_collect',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('salvage_collect.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    const detail = err instanceof Error ? err.message : 'salvage collect failed';
    await emitErrorEvent(supabase, {
      characterId,
      method: 'salvage_collect',
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  }
});

async function handleSalvageCollect(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  salvageId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    salvageId,
    actorCharacterId,
    adminOverride,
  } = params;

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

  // Check escape pod restriction
  if (ship.ship_type === 'escape_pod') {
    const err = new Error('Escape pods cannot collect salvage') as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  if (ship.current_sector === null) {
    const err = new Error('Ship sector is unavailable') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  const sectorId = ship.current_sector;

  // Load sector salvage
  const { data: sectorData, error: sectorError } = await supabase
    .from('sector_contents')
    .select('salvage')
    .eq('sector_id', sectorId)
    .single();

  if (sectorError) {
    console.error('salvage_collect.sector_fetch', sectorError);
    const err = new Error('Failed to load sector salvage') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Find and claim salvage
  const salvageList = Array.isArray(sectorData.salvage) ? sectorData.salvage : [];
  const salvageIndex = salvageList.findIndex((s: any) => s?.salvage_id === salvageId);

  if (salvageIndex === -1) {
    const err = new Error('Salvage not available') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const container = salvageList[salvageIndex] as SalvageEntry;

  // Check if already claimed by someone else
  if (container.claimed) {
    const err = new Error('Salvage already claimed') as Error & { status?: number };
    err.status = 409;
    throw err;
  }

  // Mark as claimed temporarily (atomic operation for claiming)
  container.claimed = true;
  salvageList[salvageIndex] = container;

  const { error: claimError } = await supabase
    .from('sector_contents')
    .update({ salvage: salvageList, updated_at: new Date().toISOString() })
    .eq('sector_id', sectorId);

  if (claimError) {
    console.error('salvage_collect.claim', claimError);
    const err = new Error('Failed to claim salvage') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Get ship capacity
  const shipDefinition = await loadShipDefinition(supabase, ship.ship_type);
  const cargoUsed = (ship.cargo_qf ?? 0) + (ship.cargo_ro ?? 0) + (ship.cargo_ns ?? 0);
  let availableSpace = shipDefinition.cargo_holds - cargoUsed;

  // Track collection results
  const collectedCargo: Record<string, number> = {};
  const remainingCargo: Record<string, number> = {};
  let remainingScrap = 0;
  let collectedCredits = 0;

  // Always collect credits (no cargo space needed)
  if (container.credits) {
    collectedCredits = container.credits;
    const newCredits = ship.credits + container.credits;
    const { error: creditsError } = await supabase
      .from('ship_instances')
      .update({ credits: newCredits, updated_at: new Date().toISOString() })
      .eq('ship_id', ship.ship_id);

    if (creditsError) {
      console.error('salvage_collect.credits_update', creditsError);
      const err = new Error('Failed to update credits') as Error & { status?: number };
      err.status = 500;
      throw err;
    }
  }

  // Collect scrap first (highest priority - converted to neuro_symbolics)
  if (container.scrap && availableSpace > 0) {
    const collectibleScrap = Math.min(container.scrap, availableSpace);
    const currentNeuroSymbolics = ship.cargo_ns ?? 0;

    const { error: cargoError } = await supabase
      .from('ship_instances')
      .update({
        cargo_ns: currentNeuroSymbolics + collectibleScrap,
        updated_at: new Date().toISOString(),
      })
      .eq('ship_id', ship.ship_id);

    if (cargoError) {
      console.error('salvage_collect.scrap_update', cargoError);
      const err = new Error('Failed to update cargo') as Error & { status?: number };
      err.status = 500;
      throw err;
    }

    collectedCargo.neuro_symbolics = (collectedCargo.neuro_symbolics ?? 0) + collectibleScrap;
    availableSpace -= collectibleScrap;
    remainingScrap = container.scrap - collectibleScrap;
  } else {
    remainingScrap = container.scrap ?? 0;
  }

  // Collect cargo in alphabetical order (deterministic)
  const sortedCargo = Object.keys(container.cargo).sort();
  for (const commodity of sortedCargo) {
    const amount = container.cargo[commodity];
    if (amount <= 0) continue;

    if (availableSpace <= 0) {
      remainingCargo[commodity] = amount;
      continue;
    }

    if (VALID_COMMODITIES.has(commodity)) {
      // Valid commodity - collect what fits
      const collectible = Math.min(amount, availableSpace);
      const columnSuffix = COMMODITY_TO_COLUMN[commodity];
      const columnName = `cargo_${columnSuffix}` as keyof typeof ship;
      const currentAmount = (ship[columnName] as number) ?? 0;

      const { error: cargoError } = await supabase
        .from('ship_instances')
        .update({
          [columnName]: currentAmount + collectible,
          updated_at: new Date().toISOString(),
        })
        .eq('ship_id', ship.ship_id);

      if (cargoError) {
        console.error('salvage_collect.cargo_update', cargoError, commodity);
        const err = new Error(`Failed to update cargo: ${commodity}`) as Error & { status?: number };
        err.status = 500;
        throw err;
      }

      collectedCargo[commodity] = (collectedCargo[commodity] ?? 0) + collectible;
      availableSpace -= collectible;

      if (amount > collectible) {
        remainingCargo[commodity] = amount - collectible;
      }
    } else {
      // Unknown commodity - treat as neuro_symbolics scrap
      const collectible = Math.min(amount, availableSpace);
      const currentNeuroSymbolics = ship.cargo_ns ?? 0;

      const { error: cargoError } = await supabase
        .from('ship_instances')
        .update({
          cargo_ns: currentNeuroSymbolics + collectible,
          updated_at: new Date().toISOString(),
        })
        .eq('ship_id', ship.ship_id);

      if (cargoError) {
        console.error('salvage_collect.unknown_cargo', cargoError);
        const err = new Error('Failed to update cargo') as Error & { status?: number };
        err.status = 500;
        throw err;
      }

      collectedCargo.neuro_symbolics = (collectedCargo.neuro_symbolics ?? 0) + collectible;
      availableSpace -= collectible;

      if (amount > collectible) {
        remainingCargo[commodity] = amount - collectible;
      }
    }
  }

  // Update or remove salvage
  const fullyCollected = Object.keys(remainingCargo).length === 0 && remainingScrap === 0;

  // Reload fresh salvage list (in case it changed)
  const { data: freshSectorData, error: freshSectorError } = await supabase
    .from('sector_contents')
    .select('salvage')
    .eq('sector_id', sectorId)
    .single();

  if (freshSectorError) {
    console.error('salvage_collect.reload', freshSectorError);
    const err = new Error('Failed to reload sector salvage') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  const freshSalvageList = Array.isArray(freshSectorData.salvage) ? freshSectorData.salvage : [];
  const freshIndex = freshSalvageList.findIndex((s: any) => s?.salvage_id === salvageId);

  let updatedSalvageList;
  if (fullyCollected) {
    // Remove entirely
    updatedSalvageList = freshSalvageList.filter((_: any, idx: number) => idx !== freshIndex);
  } else {
    // Update with remaining items and unclaim
    const updatedContainer = {
      ...container,
      cargo: remainingCargo,
      scrap: remainingScrap,
      credits: 0, // Credits always collected
      claimed: false, // Unclaim for others
    };
    updatedSalvageList = [...freshSalvageList];
    updatedSalvageList[freshIndex] = updatedContainer;
  }

  const { error: updateError } = await supabase
    .from('sector_contents')
    .update({ salvage: updatedSalvageList, updated_at: new Date().toISOString() })
    .eq('sector_id', sectorId);

  if (updateError) {
    console.error('salvage_collect.update', updateError);
    const err = new Error('Failed to update salvage') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  const timestamp = new Date().toISOString();

  // Emit salvage.collected event (private to collector)
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'salvage.collected',
    payload: {
      action: 'collected',
      salvage_details: {
        salvage_id: salvageId,
        collected: {
          cargo: collectedCargo,
          credits: collectedCredits,
        },
        remaining: {
          cargo: remainingCargo,
          scrap: remainingScrap,
        },
        fully_collected: fullyCollected,
      },
      sector: { id: sectorId },
      timestamp,
      source: buildEventSource('salvage.collect', requestId),
    },
    sectorId,
    requestId,
    actorCharacterId: characterId,
  });

  // Emit status.update with full status snapshot (for legacy parity)
  const statusPayload = await buildStatusPayload(supabase, characterId);
  statusPayload.source = buildEventSource('salvage.collect', requestId);
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'status.update',
    payload: statusPayload,
    sectorId,
    requestId,
    actorCharacterId: characterId,
  });

  // Emit sector.update to all sector occupants with full sector snapshot (for legacy parity)
  const sectorSnapshot = await buildSectorSnapshot(supabase, sectorId);
  sectorSnapshot.source = buildEventSource('salvage.collect', requestId);
  await emitSectorEnvelope({
    supabase,
    sectorId,
    eventType: 'sector.update',
    payload: sectorSnapshot,
    requestId,
    actorCharacterId: characterId,
  });

  return successResponse({
    success: true,
    collected: {
      credits: collectedCredits,
      cargo: collectedCargo,
    },
    remaining: {
      cargo: remainingCargo,
      scrap: remainingScrap,
    },
    fully_collected: fullyCollected,
  });
}
