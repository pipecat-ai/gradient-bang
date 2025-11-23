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

const MAX_HOPS_DEFAULT = 5;
const MAX_HOPS_LIMIT = 10;

const COMMODITY_MAP: Record<string, number> = {
  quantum_foam: 0,
  retro_organics: 1,
  neuro_symbolics: 2,
};

// Trading price calculation (ported from game-server/trading.py)
const BASE_PRICES: Record<string, number> = {
  quantum_foam: 25,
  retro_organics: 10,
  neuro_symbolics: 40,
};

const SELL_MIN = 0.75;  // Port sells to player at 75% when full stock
const SELL_MAX = 1.10;  // Port sells to player at 110% when low stock
const BUY_MIN = 0.90;   // Port buys from player at 90% when low demand
const BUY_MAX = 1.30;   // Port buys from player at 130% when high demand

/**
 * Calculate price when port sells TO player.
 * Price is LOW when stock is high (abundant), HIGH when stock is low (scarce).
 */
function calculatePriceSellToPlayer(commodity: string, stock: number, maxCapacity: number): number {
  if (maxCapacity <= 0) return 0;
  const fullness = stock / maxCapacity;
  const scarcity = 1 - fullness;  // High stock = low scarcity = low price
  const priceMultiplier = SELL_MIN + (SELL_MAX - SELL_MIN) * Math.sqrt(scarcity);
  return Math.round(BASE_PRICES[commodity] * priceMultiplier);
}

/**
 * Calculate price when port buys FROM player.
 * Price is HIGH when stock is low (needs more), LOW when stock is high (saturated).
 */
function calculatePriceBuyFromPlayer(commodity: string, stock: number, maxCapacity: number): number {
  if (maxCapacity <= 0) return 0;
  const fullness = stock / maxCapacity;
  const need = 1 - fullness;  // Low stock = high need = high price
  const priceMultiplier = BUY_MIN + (BUY_MAX - BUY_MIN) * Math.sqrt(need);
  return Math.round(BASE_PRICES[commodity] * priceMultiplier);
}

/**
 * Decode port_code to determine what commodities are bought/sold.
 * Format: BBB = all buy, SSS = all sell, BSS = buy QF, sell RO/NS, etc.
 * Position 0 = quantum_foam, 1 = retro_organics, 2 = neuro_symbolics
 */
function decodePortCode(portCode: string): { buys: string[], sells: string[] } {
  const commodities = ['quantum_foam', 'retro_organics', 'neuro_symbolics'];
  const buys: string[] = [];
  const sells: string[] = [];

  for (let i = 0; i < 3 && i < portCode.length; i++) {
    if (portCode[i] === 'B' || portCode[i] === 'b') {
      buys.push(commodities[i]);
    } else if (portCode[i] === 'S' || portCode[i] === 's') {
      sells.push(commodities[i]);
    }
  }

  return { buys, sells };
}

/**
 * Calculate trading prices for all commodities at a port.
 * Returns prices object with null for commodities not traded.
 */
function getPortPrices(
  portCode: string,
  stockQf: number,
  stockRo: number,
  stockNs: number,
  maxQf: number,
  maxRo: number,
  maxNs: number
): Record<string, number | null> {
  const { buys, sells } = decodePortCode(portCode);
  const stocks = { quantum_foam: stockQf, retro_organics: stockRo, neuro_symbolics: stockNs };
  const maxes = { quantum_foam: maxQf, retro_organics: maxRo, neuro_symbolics: maxNs };

  const prices: Record<string, number | null> = {
    quantum_foam: null,
    retro_organics: null,
    neuro_symbolics: null,
  };

  for (const commodity of ['quantum_foam', 'retro_organics', 'neuro_symbolics']) {
    const stock = stocks[commodity];
    const maxCap = maxes[commodity];

    if (sells.includes(commodity) && maxCap > 0) {
      // Port sells this commodity (price is what player pays)
      prices[commodity] = calculatePriceSellToPlayer(commodity, stock, maxCap);
    } else if (buys.includes(commodity) && maxCap > 0 && stock < maxCap) {
      // Port buys this commodity (price is what player receives)
      prices[commodity] = calculatePriceBuyFromPlayer(commodity, stock, maxCap);
    }
  }

  return prices;
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
    console.error('list_known_ports.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const rawCharacterId = requireString(payload, 'character_id');
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const actorCharacterLabel = optionalString(payload, 'actor_character_id');
  const actorCharacterId = actorCharacterLabel ? await canonicalizeCharacterId(actorCharacterLabel) : null;
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

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
    return await handleListKnownPorts(supabase, payload, characterId, requestId, actorCharacterId, adminOverride);
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: 'list_known_ports',
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
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
  actorCharacterId: string | null,
  adminOverride: boolean,
): Promise<Response> {
  const source = buildEventSource('list_known_ports', requestId);

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  const knowledge = await loadMapKnowledge(supabase, characterId);

  const requestedFromSector = optionalNumber(payload, 'from_sector');
  let fromSector: number | null = null;
  if (requestedFromSector !== null) {
    if (!Number.isInteger(requestedFromSector)) {
      throw new ListKnownPortsError('from_sector must be an integer', 400);
    }
    fromSector = requestedFromSector;
  } else if (typeof ship.current_sector === 'number' && Number.isFinite(ship.current_sector)) {
    fromSector = ship.current_sector;
  } else if (typeof knowledge.current_sector === 'number' && Number.isFinite(knowledge.current_sector)) {
    fromSector = knowledge.current_sector;
  } else {
    fromSector = 0;
  }

  if (fromSector === null) {
    throw new ListKnownPortsError('from_sector could not be determined', 400);
  }
  fromSector = Math.trunc(fromSector);

  if (!knowledge.sectors_visited[String(fromSector)]) {
    throw new ListKnownPortsError(`Starting sector ${fromSector} must be a visited sector`, 400);
  }

  let maxHopsValue = optionalNumber(payload, 'max_hops');
  if (maxHopsValue === null) {
    maxHopsValue = MAX_HOPS_DEFAULT;
  }
  if (!Number.isFinite(maxHopsValue)) {
    throw new ListKnownPortsError('max_hops must be an integer between 0 and 10', 400);
  }
  const maxHops = Math.trunc(maxHopsValue);
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > MAX_HOPS_LIMIT) {
    throw new ListKnownPortsError('max_hops must be an integer between 0 and 10', 400);
  }

  const portTypeFilterRaw = optionalString(payload, 'port_type');
  const portTypeFilter = portTypeFilterRaw ? portTypeFilterRaw.toUpperCase() : null;
  const commodityFilterRaw = optionalString(payload, 'commodity');
  const commodityFilter = commodityFilterRaw ? commodityFilterRaw.toLowerCase() : null;
  const tradeTypeFilterRaw = optionalString(payload, 'trade_type');
  const tradeTypeFilter = tradeTypeFilterRaw ? tradeTypeFilterRaw.toLowerCase() : null;

  if ((commodityFilter && !tradeTypeFilter) || (tradeTypeFilter && !commodityFilter)) {
    throw new ListKnownPortsError('commodity and trade_type must be provided together', 400);
  }
  if (tradeTypeFilter && tradeTypeFilter !== 'buy' && tradeTypeFilter !== 'sell') {
    throw new ListKnownPortsError("trade_type must be 'buy' or 'sell'", 400);
  }
  if (commodityFilter && !(commodityFilter in COMMODITY_MAP)) {
    const invalidValue = commodityFilterRaw ?? commodityFilter;
    throw new ListKnownPortsError(`Unknown commodity: ${invalidValue}`, 400);
  }

  const visitedIds = Object.keys(knowledge.sectors_visited).map((key) => Number(key));
  const portRows = await fetchPortRows(supabase, visitedIds);
  const portMap = new Map(portRows.map((row) => [row.sector_id, row]));

  const queue: Array<{ sector: number; hops: number }> = [{ sector: fromSector, hops: 0 }];
  const visitedBfs = new Set<number>([fromSector]);
  let sectorsSearched = 0;
  const results: Array<PortResult> = [];
  const rpcTimestamp = source.timestamp;

  while (queue.length > 0) {
    const current = queue.shift()!;
    sectorsSearched += 1;

    const portRow = portMap.get(current.sector);
    if (portRow && portMatchesFilters(portRow, portTypeFilter, commodityFilter, tradeTypeFilter)) {
      const knowledgeEntry = knowledge.sectors_visited[String(current.sector)];
      const inSector = typeof ship.current_sector === 'number'
        && ship.current_sector === current.sector
        && !ship.in_hyperspace;
      results.push(buildPortResult(current, current.hops, portRow, knowledgeEntry, inSector, rpcTimestamp));
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

  results.sort((a, b) => {
    if (a.hops_from_start !== b.hops_from_start) {
      return a.hops_from_start - b.hops_from_start;
    }
    return a.sector.id - b.sector.id;
  });

  const payloadBody = {
    from_sector: fromSector,
    ports: results,
    total_ports_found: results.length,
    searched_sectors: sectorsSearched,
    source,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: 'ports.list',
    payload: payloadBody,
    sectorId: fromSector,
    requestId,
    corpId: character.corporation_id,
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
  const code = portRow.port_code?.toUpperCase() ?? '';
  if (portTypeFilter && code !== portTypeFilter) {
    return false;
  }
  if (commodity && tradeType) {
    const index = COMMODITY_MAP[commodity];
    if (typeof index !== 'number') {
      return false;
    }
    const codeChar = code.charAt(index);
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
  knowledgeEntry: { position?: [number, number]; last_visited?: string } | undefined,
  inSector: boolean,
  rpcTimestamp: string,
): PortResult {
  const position = knowledgeEntry?.position ?? [0, 0];

  // Calculate trading prices based on current stock levels (matches Legacy behavior)
  const prices = getPortPrices(
    portRow.port_code,
    portRow.stock_qf,
    portRow.stock_ro,
    portRow.stock_ns,
    portRow.max_qf,
    portRow.max_ro,
    portRow.max_ns
  );

  const portPayload = {
    code: portRow.port_code,
    stock: {
      quantum_foam: portRow.stock_qf,
      retro_organics: portRow.stock_ro,
      neuro_symbolics: portRow.stock_ns,
    },
    prices,
    observed_at: inSector ? null : rpcTimestamp,
  } as Record<string, unknown>;

  return {
    sector: {
      id: node.sector,
      position,
      port: portPayload,
    },
    updated_at: rpcTimestamp,
    hops_from_start: hops,
    last_visited: knowledgeEntry?.last_visited,
  };
}
