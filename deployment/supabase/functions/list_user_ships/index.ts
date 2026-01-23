/**
 * Edge Function: list_user_ships
 *
 * Returns all ships accessible to a user (personal ship + corporation ships).
 * Emits a ships.list event with the results.
 */

import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, buildEventSource } from '../_shared/events.ts';
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import type { ShipDefinitionRow } from '../_shared/status.ts';
import { fetchActiveTaskIdsByShip } from '../_shared/tasks.ts';

type JsonRecord = Record<string, unknown>;

interface ShipSummary {
  ship_id: string;
  ship_type: string;
  name: string;
  sector: number | null;
  owner_type: 'personal' | 'corporation';
  cargo: {
    quantum_foam: number;
    retro_organics: number;
    neuro_symbolics: number;
  };
  cargo_capacity: number;
  warp_power: number;
  warp_power_capacity: number;
  shields: number;
  max_shields: number;
  fighters: number;
  max_fighters: number;
  credits: number;
  current_task_id: string | null;
}

interface ShipsListResult {
  ships: ShipSummary[];
}

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: JsonRecord;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('list_user_ships.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok' });
  }

  const requestId = resolveRequestId(payload);

  try {
    // character_id is the user's personal character
    const characterId = requireString(payload, 'character_id');

    const result = await fetchUserShips(supabase, characterId);

    // Emit event with results so client receives them via WebSocket
    const source = buildEventSource('list_user_ships', requestId);
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: 'ships.list',
      payload: { source, ...result },
      requestId,
    });

    return successResponse({ request_id: requestId });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error('list_user_ships.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function fetchUserShips(
  supabase: SupabaseClient,
  characterId: string,
): Promise<ShipsListResult> {
  const ships: ShipSummary[] = [];

  // 1. Get the user's personal ship
  const { data: character, error: charError } = await supabase
    .from('characters')
    .select('character_id, current_ship_id, corporation_id')
    .eq('character_id', characterId)
    .maybeSingle();

  if (charError) {
    console.error('list_user_ships.character', charError);
    throw new Error('Failed to load character data');
  }

  if (!character) {
    throw new Error('Character not found');
  }

  const personalShipId = character.current_ship_id;
  const corporationId = character.corporation_id;

  // Collect all ship IDs to fetch
  const shipIds: string[] = [];
  if (personalShipId) {
    shipIds.push(personalShipId);
  }

  // 2. Get corporation ship IDs if in a corporation
  let corpShipIds: string[] = [];
  if (corporationId) {
    const { data: corpShips, error: corpShipError } = await supabase
      .from('corporation_ships')
      .select('ship_id')
      .eq('corp_id', corporationId);

    if (corpShipError) {
      console.error('list_user_ships.corp_ships', corpShipError);
      // Don't throw - just skip corp ships
    } else {
      corpShipIds = (corpShips ?? [])
        .map((row) => row?.ship_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      shipIds.push(...corpShipIds);
    }
  }

  if (!shipIds.length) {
    return { ships: [] };
  }

  // 3. Fetch all ship instances
  const { data: shipRows, error: shipError } = await supabase
    .from('ship_instances')
    .select(
      'ship_id, ship_type, ship_name, current_sector, owner_type, credits, cargo_qf, cargo_ro, cargo_ns, current_warp_power, current_shields, current_fighters',
    )
    .in('ship_id', shipIds);

  if (shipError) {
    console.error('list_user_ships.ship_instances', shipError);
    throw new Error('Failed to load ship instances');
  }

  // 4. Load ship definitions for capacity/stats
  const definitionMap = await loadShipDefinitions(supabase, shipRows ?? []);

  // 5. Build ship summaries
  const corpShipIdSet = new Set(corpShipIds);
  const activeTasks = await fetchActiveTaskIdsByShip(supabase, shipIds);

  for (const row of shipRows ?? []) {
    if (!row || typeof row.ship_id !== 'string') {
      continue;
    }

    const shipId = row.ship_id;
    const definition = definitionMap.get(row.ship_type ?? '') ?? null;
    const isCorpShip = corpShipIdSet.has(shipId);

    const cargo = {
      quantum_foam: Number(row.cargo_qf ?? 0),
      retro_organics: Number(row.cargo_ro ?? 0),
      neuro_symbolics: Number(row.cargo_ns ?? 0),
    };

    ships.push({
      ship_id: shipId,
      ship_type: row.ship_type ?? 'unknown',
      name: typeof row.ship_name === 'string' && row.ship_name.trim().length > 0
        ? row.ship_name
        : definition?.display_name ?? row.ship_type ?? shipId,
      sector: typeof row.current_sector === 'number' ? row.current_sector : null,
      owner_type: isCorpShip ? 'corporation' : 'personal',
      cargo,
      cargo_capacity: definition?.cargo_holds ?? 0,
      warp_power: Number(row.current_warp_power ?? definition?.warp_power_capacity ?? 0),
      warp_power_capacity: definition?.warp_power_capacity ?? 0,
      shields: Number(row.current_shields ?? definition?.shields ?? 0),
      max_shields: definition?.shields ?? 0,
      fighters: Number(row.current_fighters ?? definition?.fighters ?? 0),
      max_fighters: definition?.fighters ?? 0,
      credits: Number(row.credits ?? 0),
      current_task_id: activeTasks.get(shipId) ?? null,
    });
  }

  // Sort: personal ship first, then corp ships by name
  ships.sort((a, b) => {
    if (a.owner_type === 'personal' && b.owner_type !== 'personal') return -1;
    if (a.owner_type !== 'personal' && b.owner_type === 'personal') return 1;
    return a.name.localeCompare(b.name);
  });

  return { ships };
}

async function loadShipDefinitions(
  supabase: SupabaseClient,
  shipRows: Array<Record<string, unknown>>,
): Promise<Map<string, ShipDefinitionRow>> {
  const shipTypes = Array.from(
    new Set(
      shipRows
        .map((row) => (typeof row.ship_type === 'string' ? row.ship_type : null))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const definitionMap = new Map<string, ShipDefinitionRow>();
  if (!shipTypes.length) {
    return definitionMap;
  }
  const { data, error } = await supabase
    .from('ship_definitions')
    .select('ship_type, display_name, cargo_holds, warp_power_capacity, shields, fighters')
    .in('ship_type', shipTypes);
  if (error) {
    console.error('list_user_ships.definitions', error);
    throw new Error('Failed to load ship definitions');
  }
  for (const row of data ?? []) {
    if (row && typeof row.ship_type === 'string') {
      definitionMap.set(row.ship_type, row as ShipDefinitionRow);
    }
  }
  return definitionMap;
}
