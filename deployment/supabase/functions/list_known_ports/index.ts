import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  authenticate,
  authErrorResponse,
  canActOnCharacter,
  errorResponse,
  successResponse,
  type AuthContext,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import { isMegaPortSector, loadUniverseMeta } from "../_shared/fedspace.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import { loadMapKnowledge, fetchAllAdjacencies } from "../_shared/map.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import { loadCharacter, loadShip } from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";
import type { WeaveSpan } from "../_shared/weave.ts";
import { RequestLogger } from "../_shared/logger.ts";

const MAX_HOPS_DEFAULT = 5;
const MAX_HOPS_LIMIT = 100;

const COMMODITY_MAP: Record<string, number> = {
  quantum_foam: 0,
  retro_organics: 1,
  neuro_symbolics: 2,
};

// Trading price calculation (ported from legacy trading logic)
const BASE_PRICES: Record<string, number> = {
  quantum_foam: 25,
  retro_organics: 10,
  neuro_symbolics: 40,
};

const SELL_MIN = 0.75; // Port sells to player at 75% when full stock
const SELL_MAX = 1.1; // Port sells to player at 110% when low stock
const BUY_MIN = 0.9; // Port buys from player at 90% when low demand
const BUY_MAX = 1.3; // Port buys from player at 130% when high demand

/**
 * Calculate price when port sells TO player.
 * Price is LOW when stock is high (abundant), HIGH when stock is low (scarce).
 */
function calculatePriceSellToPlayer(
  commodity: string,
  stock: number,
  maxCapacity: number,
): number {
  if (maxCapacity <= 0) return 0;
  const fullness = stock / maxCapacity;
  const scarcity = 1 - fullness; // High stock = low scarcity = low price
  const priceMultiplier =
    SELL_MIN + (SELL_MAX - SELL_MIN) * Math.sqrt(scarcity);
  return Math.round(BASE_PRICES[commodity] * priceMultiplier);
}

/**
 * Calculate price when port buys FROM player.
 * Price is HIGH when stock is low (needs more), LOW when stock is high (saturated).
 */
function calculatePriceBuyFromPlayer(
  commodity: string,
  stock: number,
  maxCapacity: number,
): number {
  if (maxCapacity <= 0) return 0;
  const fullness = stock / maxCapacity;
  const need = 1 - fullness; // Low stock = high need = high price
  const priceMultiplier = BUY_MIN + (BUY_MAX - BUY_MIN) * Math.sqrt(need);
  return Math.round(BASE_PRICES[commodity] * priceMultiplier);
}

/**
 * Decode port_code to determine what commodities are bought/sold.
 * Format: BBB = all buy, SSS = all sell, BSS = buy QF, sell RO/NS, etc.
 * Position 0 = quantum_foam, 1 = retro_organics, 2 = neuro_symbolics
 */
function decodePortCode(portCode: string): { buys: string[]; sells: string[] } {
  const commodities = ["quantum_foam", "retro_organics", "neuro_symbolics"];
  const buys: string[] = [];
  const sells: string[] = [];

  for (let i = 0; i < 3 && i < portCode.length; i++) {
    if (portCode[i] === "B" || portCode[i] === "b") {
      buys.push(commodities[i]);
    } else if (portCode[i] === "S" || portCode[i] === "s") {
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
  maxNs: number,
): Record<string, number | null> {
  const { buys, sells } = decodePortCode(portCode);
  const stocks = {
    quantum_foam: stockQf,
    retro_organics: stockRo,
    neuro_symbolics: stockNs,
  };
  const maxes = {
    quantum_foam: maxQf,
    retro_organics: maxRo,
    neuro_symbolics: maxNs,
  };

  const prices: Record<string, number | null> = {
    quantum_foam: null,
    retro_organics: null,
    neuro_symbolics: null,
  };

  for (const commodity of [
    "quantum_foam",
    "retro_organics",
    "neuro_symbolics",
  ]) {
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

Deno.serve(traced("list_known_ports", async (req, trace) => {
  const sAuth = trace.span("auth_check");
  let auth: AuthContext;
  try {
    auth = await authenticate(req);
  } catch (err) {
    sAuth.end({ error: "unauthorized" });
    return authErrorResponse(err);
  }
  sAuth.end();

  const supabase = createServiceRoleClient();
  let payload;
  const sParse = trace.span("parse_request");
  try {
    payload = await parseJsonRequest(req);
    sParse.end();
  } catch (err) {
    sParse.end({ error: err instanceof Error ? err.message : String(err) });
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("list_known_ports.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const log = new RequestLogger("list_known_ports", requestId);

  const rawCharacterId = requireString(payload, "character_id");
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const actorCharacterLabel = optionalString(payload, "actor_character_id");
  const actorCharacterId = actorCharacterLabel
    ? await canonicalizeCharacterId(actorCharacterLabel)
    : null;
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  if (!(await canActOnCharacter(auth, actorCharacterId ?? characterId, supabase))) {
    return errorResponse("forbidden", 403);
  }

  trace.setInput({
    characterId,
    actorCharacterId,
    adminOverride,
    taskId,
    from_sector: payload.from_sector ?? null,
    max_hops: payload.max_hops ?? null,
    port_type: payload.port_type ?? null,
    commodity: payload.commodity ?? null,
    trade_type: payload.trade_type ?? null,
    mega: payload.mega ?? null,
    requestId,
  });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "list_known_ports");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "list_known_ports",
        requestId,
        detail: "Too many list_known_ports requests",
        status: 429,
        log,
      });
      return errorResponse("Too many list_known_ports requests", 429);
    }
    log.error("rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  const sHandle = trace.span("handle_list_known_ports", { characterId });
  try {
    const { response, eventPayload } = await handleListKnownPorts(
      supabase,
      payload,
      characterId,
      requestId,
      actorCharacterId,
      adminOverride,
      taskId,
      sHandle,
      log,
    );
    sHandle.end();
    trace.setOutput({ request_id: requestId, event: eventPayload });
    return response;
  } catch (err) {
    sHandle.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof ActorAuthorizationError) {
      log.error("actor_authorization", err.message);
      await emitErrorEvent(supabase, {
        characterId,
        method: "list_known_ports",
        requestId,
        detail: err.message,
        status: err.status,
        log,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof ListKnownPortsError) {
      log.error("known_ports_error", err.message);
      await emitErrorEvent(supabase, {
        characterId,
        method: "list_known_ports",
        requestId,
        detail: err.message,
        status: err.status,
        log,
      });
      return errorResponse(err.message, err.status);
    }
    log.error("unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "list_known_ports",
      requestId,
      detail: "internal server error",
      status: 500,
      log,
    });
    return errorResponse("internal server error", 500);
  }
}));

class ListKnownPortsError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ListKnownPortsError";
    this.status = status;
  }
}

interface HandleResult {
  response: Response;
  eventPayload: Record<string, unknown>;
}

async function handleListKnownPorts(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
  taskId: string | null,
  ws: WeaveSpan,
  log: RequestLogger,
): Promise<HandleResult> {
  const source = buildEventSource("list_known_ports", requestId);

  const sLoadChar = ws.span("load_character", { characterId });
  const character = await loadCharacter(supabase, characterId);
  sLoadChar.end({ name: character.name });

  const sLoadShip = ws.span("load_ship", { shipId: character.current_ship_id });
  const ship = await loadShip(supabase, character.current_ship_id);
  sLoadShip.end({ sector: ship.current_sector });

  const sActorAuth = ws.span("actor_authorization");
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  sActorAuth.end();

  const sMapKnowledge = ws.span("load_map_knowledge");
  // For corp ships, pass actorCharacterId so the ship inherits the driving
  // player's personal exploration (see loadMapKnowledge in _shared/map.ts).
  const knowledge = await loadMapKnowledge(
    supabase,
    characterId,
    actorCharacterId,
  );
  const visitedCount = Object.keys(knowledge.sectors_visited).length;
  sMapKnowledge.end({ visitedSectors: visitedCount });

  const sUniverseMeta = ws.span("load_universe_meta");
  const universeMeta = await loadUniverseMeta(supabase);
  sUniverseMeta.end();

  const requestedFromSector = optionalNumber(payload, "from_sector");
  let fromSector: number | null = null;
  if (requestedFromSector !== null) {
    if (!Number.isInteger(requestedFromSector)) {
      throw new ListKnownPortsError("from_sector must be an integer", 400);
    }
    fromSector = requestedFromSector;
  } else if (
    typeof ship.current_sector === "number" &&
    Number.isFinite(ship.current_sector)
  ) {
    fromSector = ship.current_sector;
  } else if (
    typeof knowledge.current_sector === "number" &&
    Number.isFinite(knowledge.current_sector)
  ) {
    fromSector = knowledge.current_sector;
  } else {
    fromSector = 0;
  }

  if (fromSector === null) {
    throw new ListKnownPortsError("from_sector could not be determined", 400);
  }
  fromSector = Math.trunc(fromSector);

  if (!knowledge.sectors_visited[String(fromSector)]) {
    throw new ListKnownPortsError(
      `Starting sector ${fromSector} must be a visited sector`,
      400,
    );
  }

  const megaFilter = optionalBoolean(payload, "mega");
  const maxHopsProvided = Object.prototype.hasOwnProperty.call(
    payload,
    "max_hops",
  );
  let maxHopsValue = optionalNumber(payload, "max_hops");
  if (!maxHopsProvided || maxHopsValue === null) {
    maxHopsValue = megaFilter === true ? MAX_HOPS_LIMIT : MAX_HOPS_DEFAULT;
  }
  if (!Number.isFinite(maxHopsValue)) {
    throw new ListKnownPortsError(
      `max_hops must be an integer between 0 and ${MAX_HOPS_LIMIT}`,
      400,
    );
  }
  const maxHops = Math.trunc(maxHopsValue);
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > MAX_HOPS_LIMIT) {
    throw new ListKnownPortsError(
      `max_hops must be an integer between 0 and ${MAX_HOPS_LIMIT}`,
      400,
    );
  }

  const portTypeFilterRaw = optionalString(payload, "port_type");
  const portTypeFilter = portTypeFilterRaw
    ? portTypeFilterRaw.toUpperCase()
    : null;
  const commodityFilterRaw = optionalString(payload, "commodity");
  const commodityFilter = commodityFilterRaw
    ? commodityFilterRaw.toLowerCase()
    : null;
  const tradeTypeFilterRaw = optionalString(payload, "trade_type");
  const tradeTypeFilter = tradeTypeFilterRaw
    ? tradeTypeFilterRaw.toLowerCase()
    : null;

  if (
    (commodityFilter && !tradeTypeFilter) ||
    (tradeTypeFilter && !commodityFilter)
  ) {
    throw new ListKnownPortsError(
      "commodity and trade_type must be provided together",
      400,
    );
  }
  if (
    tradeTypeFilter &&
    tradeTypeFilter !== "buy" &&
    tradeTypeFilter !== "sell"
  ) {
    throw new ListKnownPortsError("trade_type must be 'buy' or 'sell'", 400);
  }
  if (commodityFilter && !(commodityFilter in COMMODITY_MAP)) {
    const invalidValue = commodityFilterRaw ?? commodityFilter;
    throw new ListKnownPortsError(`Unknown commodity: ${invalidValue}`, 400);
  }

  const sAdjacencyLoad = ws.span("load_adjacencies");
  const adjacency = await fetchAllAdjacencies();
  sAdjacencyLoad.end({
    sectorCount: adjacency.size,
  });

  // Pure in-memory BFS
  const visitedBfs = new Set<number>([fromSector]);
  let sectorsSearched = 0;
  const searchedNodes: Array<{ sector: number; hops: number }> = [];
  const rpcTimestamp = source.timestamp;

  let frontier: number[] = [fromSector];
  let hops = 0;

  const sBfs = ws.span("bfs_port_search", { fromSector, maxHops });
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const sectorId of frontier) {
      const current = { sector: sectorId, hops };
      sectorsSearched += 1;
      searchedNodes.push(current);

      if (hops >= maxHops) {
        continue;
      }

      const neighbors = adjacency.get(current.sector) ?? [];
      for (const neighbor of neighbors) {
        if (!visitedBfs.has(neighbor)) {
          visitedBfs.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    if (hops >= maxHops) {
      break;
    }
    frontier = next;
    hops += 1;
  }
  sBfs.end({
    rounds: hops,
    sectorsSearched,
  });

  const candidateSectorIds = searchedNodes
    .filter((node) => knowledge.sectors_visited[String(node.sector)])
    .map((node) => node.sector);

  const sPortLoad = ws.span("load_searched_ports", {
    candidateSectorCount: candidateSectorIds.length,
  });
  const portRows = await fetchPortRows(candidateSectorIds, log);
  const portMap = new Map(portRows.map((row) => [row.sector_id, row]));
  sPortLoad.end({
    portCount: portRows.length,
  });

  const results: Array<PortResult> = [];
  for (const current of searchedNodes) {
    const portRow = portMap.get(current.sector);
    if (!portRow) {
      continue;
    }
    const isMega = isMegaPortSector(universeMeta, current.sector);
    if (
      !portMatchesFilters(
        portRow,
        portTypeFilter,
        commodityFilter,
        tradeTypeFilter,
        megaFilter,
        isMega,
      )
    ) {
      continue;
    }
    const knowledgeEntry = knowledge.sectors_visited[String(current.sector)];
    const inSector = typeof ship.current_sector === "number" &&
      ship.current_sector === current.sector &&
      !ship.in_hyperspace;
    results.push(
      buildPortResult(
        current,
        current.hops,
        portRow,
        knowledgeEntry,
        inSector,
        rpcTimestamp,
        isMega,
      ),
    );
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
    max_hops: maxHops,
    port_type: portTypeFilter,
    commodity: commodityFilter,
    trade_type: tradeTypeFilter,
    mega: megaFilter,
    source,
  };

  const sEmitEvent = ws.span("emit_ports_list");
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "ports.list",
    payload: payloadBody,
    sectorId: fromSector,
    requestId,
    taskId,
    shipId: ship.ship_id,
    scope: "direct",
    log,
  });
  sEmitEvent.end();

  // Include the full payloadBody in the HTTP response so callers can consume
  // the data synchronously. The matching `ports.list` event is still emitted
  // above for async consumers (TaskAgent's ASYNC_TOOL_COMPLETIONS waits on it).
  return {
    response: successResponse({ request_id: requestId, ...payloadBody }),
    eventPayload: payloadBody,
  };
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
  sectorIds: number[],
  log: RequestLogger,
): Promise<PortRow[]> {
  if (sectorIds.length === 0) {
    return [];
  }
  const uniqueIds = Array.from(new Set(sectorIds));
  const pg = await acquirePgClient();
  try {
    const result = await pg.queryObject<PortRow>(
      `SELECT
        sc.sector_id::int,
        p.port_code,
        p.port_class::int,
        p.max_qf::int,
        p.max_ro::int,
        p.max_ns::int,
        p.stock_qf::int,
        p.stock_ro::int,
        p.stock_ns::int,
        p.last_updated::text AS last_updated
      FROM sector_contents sc
      JOIN ports p ON p.port_id = sc.port_id
      WHERE sc.sector_id = ANY($1::int[])`,
      [uniqueIds],
    );
    return result.rows;
  } catch (err) {
    log.error("ports", err);
    throw new ListKnownPortsError("failed to load ports", 500);
  } finally {
    pg.release();
  }
}

function portMatchesFilters(
  portRow: PortRow,
  portTypeFilter: string | null,
  commodity: string | null,
  tradeType: string | null,
  megaFilter: boolean | null,
  isMega: boolean,
): boolean {
  const code = portRow.port_code?.toUpperCase() ?? "";
  if (portTypeFilter && code !== portTypeFilter) {
    return false;
  }
  if (megaFilter !== null && megaFilter !== isMega) {
    return false;
  }
  if (commodity && tradeType) {
    const index = COMMODITY_MAP[commodity];
    if (typeof index !== "number") {
      return false;
    }
    const codeChar = code.charAt(index);
    if (tradeType === "buy") {
      return codeChar === "S";
    }
    return codeChar === "B";
  }
  return true;
}

function buildPortResult(
  node: { sector: number; hops: number },
  hops: number,
  portRow: PortRow,
  knowledgeEntry:
    | { position?: [number, number]; last_visited?: string }
    | undefined,
  inSector: boolean,
  rpcTimestamp: string,
  isMega: boolean,
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
    portRow.max_ns,
  );

  const portPayload = {
    code: portRow.port_code,
    mega: isMega,
    stock: {
      quantum_foam: portRow.stock_qf,
      retro_organics: portRow.stock_ro,
      neuro_symbolics: portRow.stock_ns,
    },
    prices,
    observed_at: inSector ? null : portRow.last_updated,
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
