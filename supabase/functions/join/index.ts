import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import { buildStatusPayload } from '../_shared/status.ts';
import {
  buildLocalMapRegion,
  normalizeMapKnowledge,
  upsertVisitedSector,
} from '../_shared/map.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

type CharacterRow = {
  character_id: string;
  name: string;
  current_ship_id: string | null;
  map_knowledge: unknown;
};

type ShipRow = {
  ship_id: string;
  owner_id: string;
  ship_type: string;
  ship_name: string | null;
  current_sector: number | null;
};

type ShipDefinitionRow = {
  ship_type: string;
  display_name: string;
  cargo_holds: number;
  warp_power_capacity: number;
  shields: number;
  fighters: number;
};

interface UniverseSectorRow {
  sector_id: number;
  position_x: number;
  position_y: number;
  warps: unknown;
}

const DEFAULT_START_SECTOR = 0;
const DEFAULT_SHIP_TYPE = 'kestrel_courier';

class JoinError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'JoinError';
    this.status = status;
  }
}

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('join.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const shipTypeOverride = optionalString(payload, 'ship_type');
  const sectorOverride = optionalNumber(payload, 'sector');
  const creditsOverride = optionalNumber(payload, 'credits');

  try {
    let character = await loadCharacterRow(supabase, characterId);
    if (!character) {
      character = await createCharacterRow({
        supabase,
        characterId,
        displayName: payload.name ?? characterId,
      });
    }

    try {
      await enforceRateLimit(supabase, characterId, 'join');
    } catch (err) {
      if (err instanceof RateLimitError) {
        return errorResponse('Too many join requests', 429);
      }
      console.error('join.rate_limit', err);
      throw new JoinError('rate limit error', 500);
    }

    const ship = await loadOrCreateShip({
      supabase,
      character,
      shipTypeOverride,
    });

    const targetSector = await resolveTargetSector({
      supabase,
      sectorOverride,
      fallbackSector: ship.current_sector ?? DEFAULT_START_SECTOR,
    });

    await updateShipState({
      supabase,
      shipId: ship.ship_id,
      sectorId: targetSector,
      creditsOverride,
    });

    await ensureCharacterShipLink(supabase, character.character_id, ship.ship_id);

    await upsertKnowledgeEntry({
      supabase,
      character,
      sectorId: targetSector,
    });

    const source = buildEventSource('join', requestId);
    const statusPayload = await buildStatusPayload(supabase, characterId);
    statusPayload['source'] = source;
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'status.snapshot',
      payload: statusPayload,
      shipId: ship.ship_id,
      sectorId: targetSector,
      requestId,
    });

    const mapPayload = await buildLocalMapRegion(supabase, {
      characterId,
      centerSector: targetSector,
      maxHops: 4,
      maxSectors: 28,
    });
    mapPayload['source'] = source;
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'map.local',
      payload: mapPayload,
      sectorId: targetSector,
      requestId,
    });

    return successResponse({ request_id: requestId });
  } catch (err) {
    if (err instanceof JoinError) {
      console.warn('join.validation', err.message);
      return errorResponse(err.message, err.status);
    }
    console.error('join.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function loadCharacterRow(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
): Promise<CharacterRow | null> {
  const { data, error } = await supabase
    .from('characters')
    .select('character_id, name, current_ship_id, map_knowledge')
    .eq('character_id', characterId)
    .maybeSingle();
  if (error) {
    console.error('join.character.load', error);
    throw new JoinError('failed to load character', 500);
  }
  return (data as CharacterRow | null) ?? null;
}

async function createCharacterRow({
  supabase,
  characterId,
  displayName,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  displayName: string;
}): Promise<CharacterRow> {
  const initialKnowledge = {
    sectors_visited: {},
    total_sectors_visited: 0,
    current_sector: DEFAULT_START_SECTOR,
  } as Record<string, unknown>;

  const { data, error } = await supabase
    .from('characters')
    .insert({
      character_id: characterId,
      name: displayName,
      map_knowledge: initialKnowledge,
      player_metadata: {},
      is_npc: false,
      credits_in_megabank: 0,
      current_ship_id: null,
    })
    .select('character_id, name, current_ship_id, map_knowledge')
    .single();

  if (error) {
    console.error('join.character.create', error);
    const existing = await loadCharacterRow(supabase, characterId);
    if (existing) {
      return existing;
    }
    throw new JoinError('failed to create character', 500);
  }

  return data as CharacterRow;
}

async function loadShipRow(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipId: string,
): Promise<ShipRow | null> {
  const { data, error } = await supabase
    .from('ship_instances')
    .select('ship_id, owner_id, ship_type, ship_name, current_sector')
    .eq('ship_id', shipId)
    .maybeSingle();
  if (error) {
    console.error('join.ship.load', error);
    throw new JoinError('failed to load ship', 500);
  }
  return (data as ShipRow | null) ?? null;
}

async function loadShipDefinition(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipType: string,
): Promise<ShipDefinitionRow> {
  const { data, error } = await supabase
    .from('ship_definitions')
    .select('ship_type, display_name, cargo_holds, warp_power_capacity, shields, fighters')
    .eq('ship_type', shipType)
    .maybeSingle();
  if (error) {
    console.error('join.ship.definition', error);
    throw new JoinError('failed to load ship definition', 500);
  }
  if (!data) {
    throw new JoinError(`invalid ship type: ${shipType}`, 400);
  }
  return data as ShipDefinitionRow;
}

async function loadOrCreateShip({
  supabase,
  character,
  shipTypeOverride,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  character: CharacterRow;
  shipTypeOverride: string | null;
}): Promise<ShipRow> {
  if (character.current_ship_id) {
    const existing = await loadShipRow(supabase, character.current_ship_id);
    if (existing) {
      return existing;
    }
  }

  const shipType = shipTypeOverride ?? DEFAULT_SHIP_TYPE;
  const definition = await loadShipDefinition(supabase, shipType);
  const { data, error } = await supabase
    .from('ship_instances')
    .insert({
      owner_id: character.character_id,
      ship_type: shipType,
      ship_name: definition.display_name,
      current_sector: DEFAULT_START_SECTOR,
      in_hyperspace: false,
      credits: 0,
      cargo_qf: 0,
      cargo_ro: 0,
      cargo_ns: 0,
      current_warp_power: definition.warp_power_capacity,
      current_shields: definition.shields,
      current_fighters: definition.fighters,
      metadata: {},
    })
    .select('ship_id, owner_id, ship_type, ship_name, current_sector')
    .single();
  if (error) {
    console.error('join.ship.create', error);
    throw new JoinError('failed to create starter ship', 500);
  }

  await supabase
    .from('characters')
    .update({ current_ship_id: data.ship_id })
    .eq('character_id', character.character_id);

  return data as ShipRow;
}

async function resolveTargetSector({
  supabase,
  sectorOverride,
  fallbackSector,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  sectorOverride: number | null;
  fallbackSector: number;
}): Promise<number> {
  const target = sectorOverride ?? fallbackSector ?? DEFAULT_START_SECTOR;
  const { data, error } = await supabase
    .from('universe_structure')
    .select('sector_id')
    .eq('sector_id', target)
    .maybeSingle();
  if (error) {
    console.error('join.sector.load', error);
    throw new JoinError('failed to validate sector', 500);
  }
  if (!data) {
    throw new JoinError(`invalid sector: ${target}`, 400);
  }
  return target;
}

async function updateShipState({
  supabase,
  shipId,
  sectorId,
  creditsOverride,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  shipId: string;
  sectorId: number;
  creditsOverride: number | null;
}): Promise<void> {
  const updates: Record<string, unknown> = {
    current_sector: sectorId,
    in_hyperspace: false,
    hyperspace_destination: null,
    hyperspace_eta: null,
  };
  if (typeof creditsOverride === 'number') {
    updates.credits = creditsOverride;
  }
  const { error } = await supabase
    .from('ship_instances')
    .update(updates)
    .eq('ship_id', shipId);
  if (error) {
    console.error('join.ship.update', error);
    throw new JoinError('failed to update ship state', 500);
  }
}

async function ensureCharacterShipLink(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
  shipId: string,
): Promise<void> {
  const { error } = await supabase
    .from('characters')
    .update({ current_ship_id: shipId, last_active: new Date().toISOString() })
    .eq('character_id', characterId);
  if (error) {
    console.error('join.character.update', error);
    throw new JoinError('failed to update character state', 500);
  }
}

async function upsertKnowledgeEntry({
  supabase,
  character,
  sectorId,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  character: CharacterRow;
  sectorId: number;
}): Promise<void> {
  const { data, error } = await supabase
    .from('universe_structure')
    .select('sector_id, position_x, position_y, warps')
    .eq('sector_id', sectorId)
    .maybeSingle();
  if (error) {
    console.error('join.knowledge.structure', error);
    throw new JoinError('failed to load sector structure', 500);
  }
  if (!data) {
    return;
  }
  const knowledge = normalizeMapKnowledge(character.map_knowledge);
  const adjacent = parseAdjacentIds(data);
  const timestamp = new Date().toISOString();
  const { updated } = upsertVisitedSector(
    knowledge,
    sectorId,
    adjacent,
    [data.position_x ?? 0, data.position_y ?? 0],
    timestamp,
  );
  if (!updated) {
    return;
  }
  const { error: updateError } = await supabase
    .from('characters')
    .update({ map_knowledge: knowledge })
    .eq('character_id', character.character_id);
  if (updateError) {
    console.error('join.knowledge.update', updateError);
    throw new JoinError('failed to update map knowledge', 500);
  }
}

function parseAdjacentIds(structure: UniverseSectorRow): number[] {
  if (!Array.isArray(structure.warps)) {
    return [];
  }
  return structure.warps
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const toValue = (entry as Record<string, unknown>)['to'];
      const to = typeof toValue === 'number' ? toValue : Number(toValue);
      return Number.isFinite(to) ? to : null;
    })
    .filter((value): value is number => value !== null);
}
