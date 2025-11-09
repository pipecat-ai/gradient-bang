import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { emitCharacterEvent, emitErrorEvent, buildEventSource } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  getAdjacentSectors,
  loadMapKnowledge,
} from '../_shared/map.ts';
import type { MapKnowledge } from '../_shared/map.ts';
import { loadCharacter, loadShip } from '../_shared/status.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

const MAX_HOPS_DEFAULT = 5;
const MAX_HOPS_LIMIT = 10;

const COMMODITY_MAP: Record<string, number> = {
  quantum_foam: 0,
  retro_organics: 1,
  neuro_symbolics: 2,
};

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
    console.error('list_known_ports.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  if (actorCharacterId && actorCharacterId !== characterId && !adminOverride) {
    return errorResponse('actor_character_id must match character_id unless admin_override is true', 403);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'list_known_ports');
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'list_known_ports',
        requestId,
        detail: 'Too many list_known_ports requests',
        status: 429,
      });
      return errorResponse('Too many list_known_ports requests', 429);
    }
    console.error('list_known_ports.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleListKnownPorts(supabase, payload, characterId, requestId);
  } catch (err) {
    if (err instanceof ListKnownPortsError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'list_known_ports',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('list_known_ports.unhandled', err);
    await emitErrorEvent(supabase, {
      characterId,
      method: 'list_known_ports',
      requestId,
      detail: 'internal server error',
      status: 500,
    });
    return errorResponse('internal server error', 500);
  }
});

class ListKnownPortsError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ListKnownPortsError';
    this.status = status;
  }
}

async function handleListKnownPorts(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
): Promise<Response> {
  const source = buildEventSource('list_known_ports', requestId);

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  const knowledge = await loadMapKnowledge(supabase, characterId);

  let fromSector = optionalNumber(payload, 'from_sector');
  if (fromSector === null) {
    fromSector = ship.current_sector ?? knowledge.current_sector ?? 0;
  }
  if (fromSector === null) {
    throw new ListKnownPortsError('from_sector could not be determined', 400);
  }

  if (!knowledge.sectors_visited[String(fromSector)]) {
    throw new ListKnownPortsError(`Starting sector ${fromSector} must be a visited sector`, 400);
  }

  let maxHops = optionalNumber(payload, 'max_hops');
  if (maxHops === null) {
    maxHops = MAX_HOPS_DEFAULT;
  }
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > MAX_HOPS_LIMIT) {
    throw new ListKnownPortsError('max_hops must be an integer between 0 and 10', 400);
  }

  const portTypeFilter = optionalString(payload, 'port_type');
  const commodityFilter = optionalString(payload, 'commodity');
  const tradeTypeFilter = optionalString(payload, 'trade_type');

  if ((commodityFilter && !tradeTypeFilter) || (tradeTypeFilter && !commodityFilter)) {
    throw new ListKnownPortsError('commodity and trade_type must be provided together', 400);
  }
  if (tradeTypeFilter && tradeTypeFilter !== 'buy' && tradeTypeFilter !== 'sell') {
    throw new ListKnownPortsError("trade_type must be 'buy' or 'sell'", 400);
  }
  if (commodityFilter && !(commodityFilter in COMMODITY_MAP)) {
    throw new ListKnownPortsError(`Unknown commodity: ${commodityFilter}`, 400);
  }

  const visitedIds = Object.keys(knowledge.sectors_visited).map((key) => Number(key));
  const portRows = await fetchPortRows(supabase, visitedIds);
  const portMap = new Map(portRows.map((row) => [row.sector_id, row]));

  const queue: Array<{ sector: number; hops: number }> = [{ sector: fromSector, hops: 0 }];
  const visitedBfs = new Set<number>([fromSector]);
  let sectorsSearched = 0;
  const results: Array<PortResult> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sectorsSearched += 1;

    const portRow = portMap.get(current.sector);
    if (portRow) {
      if (portMatchesFilters(portRow, portTypeFilter, commodityFilter, tradeTypeFilter)) {
        const knowledgeEntry = knowledge.sectors_visited[String(current.sector)];
        results.push(buildPortResult(current, current.hops, portRow, knowledgeEntry));
      }
    }

    if (current.hops >= maxHops) {
      continue;
    }

    const adjacency = await resolveAdjacency(knowledge, supabase, current.sector);
    for (const neighbor of adjacency) {
      if (!visitedBfs.has(neighbor) && knowledge.sectors_visited[String(neighbor)]) {
        visitedBfs.add(neighbor);
        queue.push({ sector: neighbor, hops: current.hops + 1 });
      }
    }
  }

  const payloadBody = {
    from_sector: fromSector,
    max_hops: maxHops,
    ports: results,
    total_ports_found: results.length,
    sectors_searched: sectorsSearched,
    source,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'ports.list',
    payload: payloadBody,
    sectorId: fromSector,
    requestId,
  });

  return successResponse({ request_id: requestId });
}

type PortRow = {
  sector_id: number;
  port_code: string;
  port_class: number;
  max_qf: number;
  max_ro: number;
  max_ns: number;
  stock_qf: number;
  stock_ro: number;
  stock_ns: number;
  last_updated: string | null;
};

type PortResult = {
  sector: {
    id: number;
    position: [number, number];
    port: Record<string, unknown>;
  };
  updated_at: string | null;
  hops_from_start: number;
  last_visited?: string;
};

async function fetchPortRows(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sectorIds: number[],
): Promise<PortRow[]> {
  if (sectorIds.length === 0) {
    return [];
  }
  const { data, error } = await supabase
    .from('ports')
    .select(
      'sector_id, port_code, port_class, max_qf, max_ro, max_ns, stock_qf, stock_ro, stock_ns, last_updated',
    )
    .in('sector_id', Array.from(new Set(sectorIds)));
  if (error) {
    console.error('list_known_ports.ports', error);
    throw new ListKnownPortsError('failed to load ports', 500);
  }
  return data ?? [];
}

async function resolveAdjacency(
  knowledge: MapKnowledge,
  supabase: ReturnType<typeof createServiceRoleClient>,
  sectorId: number,
): Promise<number[]> {
  const entry = knowledge.sectors_visited[String(sectorId)];
  if (entry?.adjacent_sectors && entry.adjacent_sectors.length > 0) {
    return entry.adjacent_sectors;
  }
  return await getAdjacentSectors(supabase, sectorId);
}

function portMatchesFilters(
  portRow: PortRow,
  portTypeFilter: string | null,
  commodity: string | null,
  tradeType: string | null,
): boolean {
  if (portTypeFilter && portRow.port_code !== portTypeFilter) {
    return false;
  }
  if (commodity && tradeType) {
    const index = COMMODITY_MAP[commodity];
    const codeChar = portRow.port_code?.charAt(index) ?? '';
    if (tradeType === 'buy') {
      return codeChar === 'S';
    }
    return codeChar === 'B';
  }
  return true;
}

function buildPortResult(
  node: { sector: number; hops: number },
  hops: number,
  portRow: PortRow,
  knowledgeEntry?: { position?: [number, number]; last_visited?: string },
): PortResult {
  const position = knowledgeEntry?.position ?? [0, 0];
  const portPayload = {
    code: portRow.port_code,
    port_class: portRow.port_class,
    stock: {
      quantum_foam: portRow.stock_qf,
      retro_organics: portRow.stock_ro,
      neuro_symbolics: portRow.stock_ns,
    },
    capacity: {
      quantum_foam: portRow.max_qf,
      retro_organics: portRow.max_ro,
      neuro_symbolics: portRow.max_ns,
    },
  } as Record<string, unknown>;

  return {
    sector: {
      id: node.sector,
      position,
      port: portPayload,
    },
    updated_at: portRow.last_updated,
    hops_from_start: hops,
    last_visited: knowledgeEntry?.last_visited,
  };
}
