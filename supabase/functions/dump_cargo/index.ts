import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { buildStatusPayload, loadCharacter, loadShip, loadShipDefinition } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import { buildSectorSnapshot } from '../_shared/map.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { appendSalvageEntry, buildSalvageEntry } from '../_shared/salvage.ts';

const VALID_COMMODITIES = new Set(['quantum_foam', 'retro_organics', 'neuro_symbolics']);

class DumpCargoError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'DumpCargoError';
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
    console.error('dump_cargo.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  try {
    await enforceRateLimit(supabase, characterId, 'dump_cargo');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'dump_cargo',
        requestId,
        detail: 'Too many dump_cargo requests',
        status: 429,
      });
      return errorResponse('Too many dump_cargo requests', 429);
    }
    console.error('dump_cargo.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleDumpCargo(supabase, payload, characterId, requestId, actorCharacterId, adminOverride);
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'dump_cargo',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof DumpCargoError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'dump_cargo',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('dump_cargo.unhandled', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'dump_cargo',
      requestId,
      detail: 'internal server error',
      status: 500,
    });
    return errorResponse('internal server error', 500);
  }
});

function parseManifest(raw: unknown): Record<string, number> {
  if (!raw) {
    throw new DumpCargoError('Missing cargo manifest', 400);
  }
  const manifest: Record<string, number> = {};
  const iterator: Array<[unknown, unknown]> = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') {
        throw new DumpCargoError('Each cargo entry must be an object', 400);
      }
      iterator.push([(entry as Record<string, unknown>)['commodity'], (entry as Record<string, unknown>)['units']]);
    }
  } else if (typeof raw === 'object') {
    for (const [commodity, units] of Object.entries(raw as Record<string, unknown>)) {
      iterator.push([commodity, units]);
    }
  } else {
    throw new DumpCargoError('cargo/items must be an object or list', 400);
  }

  for (const [commodityRaw, unitsRaw] of iterator) {
    if (typeof commodityRaw !== 'string' || !VALID_COMMODITIES.has(commodityRaw)) {
      throw new DumpCargoError(`Invalid commodity: ${commodityRaw}`, 400);
    }
    if (typeof unitsRaw !== 'number' || !Number.isInteger(unitsRaw) || unitsRaw <= 0) {
      throw new DumpCargoError('Units must be positive integers', 400);
    }
    manifest[commodityRaw] = (manifest[commodityRaw] ?? 0) + unitsRaw;
  }

  if (!Object.keys(manifest).length) {
    throw new DumpCargoError('No cargo specified to dump', 400);
  }
  return manifest;
}

async function handleDumpCargo(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
): Promise<Response> {
  const manifest = parseManifest(payload['items'] ?? payload['cargo']);
  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  if (ship.in_hyperspace) {
    throw new DumpCargoError('Character is in hyperspace, cannot dump cargo', 400);
  }
  if (ship.current_sector === null) {
    throw new DumpCargoError('Ship sector is unavailable', 500);
  }

  const removed = calculateRemoved(manifest, ship);
  if (!Object.keys(removed).length) {
    throw new DumpCargoError('No cargo available to dump', 400);
  }

  await updateShipCargo(supabase, ship.ship_id, ship, removed);

  const shipDefinition = await loadShipDefinition(supabase, ship.ship_type);
  const salvageEntry = buildSalvageEntry(
    { ship_name: ship.ship_name, ship_type: ship.ship_type },
    shipDefinition.display_name,
    removed,
    0,
    0,
  );
  await appendSalvageEntry(supabase, ship.current_sector, salvageEntry);

  const source = buildEventSource('dump_cargo', requestId);
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'salvage.created',
    payload: {
      action: 'dumped',
      salvage_details: {
        salvage_id: salvageEntry.salvage_id,
        cargo: salvageEntry.cargo,
        scrap: salvageEntry.scrap,
        credits: salvageEntry.credits,
        expires_at: salvageEntry.expires_at,
      },
      sector: { id: ship.current_sector },
      timestamp: salvageEntry.created_at,
      source,
    },
    requestId,
  });

  const statusPayload = await buildStatusPayload(supabase, characterId);
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'status.update',
    payload: statusPayload,
    requestId,
  });

  const sectorRecipients = await listCharactersInSector(supabase, ship.current_sector);
  if (sectorRecipients.length) {
    const sectorSnapshot = await buildSectorSnapshot(supabase, ship.current_sector, characterId);
    await emitCharacterEvent({
      supabase,
      characterId: sectorRecipients[0],
      eventType: 'sector.update',
      payload: sectorSnapshot,
      sectorId: ship.current_sector,
      senderId: characterId,
      requestId,
    });
    for (let idx = 1; idx < sectorRecipients.length; idx += 1) {
      await emitCharacterEvent({
        supabase,
        characterId: sectorRecipients[idx],
        eventType: 'sector.update',
        payload: sectorSnapshot,
        sectorId: ship.current_sector,
        senderId: characterId,
        requestId,
      });
    }
  }

  return successResponse({ request_id: requestId });
}

function calculateRemoved(manifest: Record<string, number>, ship: { cargo_qf: number | null; cargo_ro: number | null; cargo_ns: number | null }): Record<string, number> {
  const removed: Record<string, number> = {};
  const cargoState: Record<string, number> = {
    quantum_foam: ship.cargo_qf ?? 0,
    retro_organics: ship.cargo_ro ?? 0,
    neuro_symbolics: ship.cargo_ns ?? 0,
  };
  for (const [commodity, units] of Object.entries(manifest)) {
    const available = cargoState[commodity] ?? 0;
    const unitsToRemove = Math.min(units, available);
    if (unitsToRemove > 0) {
      removed[commodity] = unitsToRemove;
      cargoState[commodity] = available - unitsToRemove;
    }
  }
  return removed;
}

async function updateShipCargo(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipId: string,
  ship: { cargo_qf: number | null; cargo_ro: number | null; cargo_ns: number | null },
  removed: Record<string, number>,
): Promise<void> {
  const nextCargo = {
    quantum_foam: (ship.cargo_qf ?? 0) - (removed.quantum_foam ?? 0),
    retro_organics: (ship.cargo_ro ?? 0) - (removed.retro_organics ?? 0),
    neuro_symbolics: (ship.cargo_ns ?? 0) - (removed.neuro_symbolics ?? 0),
  };
  const { error } = await supabase
    .from('ship_instances')
    .update({
      cargo_qf: Math.max(nextCargo.quantum_foam, 0),
      cargo_ro: Math.max(nextCargo.retro_organics, 0),
      cargo_ns: Math.max(nextCargo.neuro_symbolics, 0),
    })
    .eq('ship_id', shipId);
  if (error) {
    console.error('dump_cargo.update_ship', error);
    throw new DumpCargoError('Failed to update ship cargo', 500);
  }
}

async function listCharactersInSector(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sectorId: number,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('ship_instances')
    .select('ship_id')
    .eq('current_sector', sectorId)
    .eq('in_hyperspace', false);
  if (error) {
    console.error('dump_cargo.list_characters', error);
    return [];
  }
  const shipIds = (data ?? [])
    .map((row) => row.ship_id)
    .filter((shipId): shipId is string => typeof shipId === 'string');
  if (shipIds.length === 0) {
    return [];
  }
  const { data: characters, error: characterError } = await supabase
    .from('characters')
    .select('character_id, current_ship_id')
    .in('current_ship_id', shipIds);
  if (characterError) {
    console.error('dump_cargo.list_characters.characters', characterError);
    return [];
  }
  const ids = new Set<string>();
  for (const row of characters ?? []) {
    if (typeof row.character_id === 'string' && row.character_id.length > 0) {
      ids.add(row.character_id);
    }
  }
  return Array.from(ids);
}
