import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import { getMegaPortSectors, loadUniverseMeta } from "../_shared/fedspace.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import { loadMapKnowledgeParallel, parseWarpEdges } from "../_shared/map.ts";
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
import {
  searchPorts,
  COMMODITY_MAP,
  MAX_HOPS_DEFAULT,
  MAX_HOPS_LIMIT,
  type PortRow,
} from "./port_search.ts";

Deno.serve(async (req: Request): Promise<Response> => {
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
  const rawCharacterId = requireString(payload, "character_id");
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const actorCharacterLabel = optionalString(payload, "actor_character_id");
  const actorCharacterId = actorCharacterLabel
    ? await canonicalizeCharacterId(actorCharacterLabel)
    : null;
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  try {
    await enforceRateLimit(supabase, characterId, "list_known_ports");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "list_known_ports",
        requestId,
        detail: "Too many list_known_ports requests",
        status: 429,
      });
      return errorResponse("Too many list_known_ports requests", 429);
    }
    console.error("list_known_ports.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    return await handleListKnownPorts(
      supabase,
      payload,
      characterId,
      requestId,
      actorCharacterId,
      adminOverride,
      taskId,
    );
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "list_known_ports",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof ListKnownPortsError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "list_known_ports",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("list_known_ports.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "list_known_ports",
      requestId,
      detail: "internal server error",
      status: 500,
    });
    return errorResponse("internal server error", 500);
  }
});

class ListKnownPortsError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ListKnownPortsError";
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
  taskId: string | null,
): Promise<Response> {
  const source = buildEventSource("list_known_ports", requestId);

  const character = await loadCharacter(supabase, characterId);
  const [ship, knowledge, universeMeta] = await Promise.all([
    loadShip(supabase, character.current_ship_id),
    loadMapKnowledgeParallel(supabase, characterId, character.corporation_id),
    loadUniverseMeta(supabase),
  ]);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

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

  const visitedIds = Object.keys(knowledge.sectors_visited).map((key) =>
    Number(key),
  );

  // Build adjacency map from knowledge + DB
  const adjacencyMap = new Map<number, number[]>();
  const needAdjacencyFetch: number[] = [];
  for (const id of visitedIds) {
    const entry = knowledge.sectors_visited[String(id)];
    if (entry?.adjacent_sectors && entry.adjacent_sectors.length > 0) {
      adjacencyMap.set(id, entry.adjacent_sectors);
    } else {
      needAdjacencyFetch.push(id);
    }
  }

  // Fetch port rows and missing adjacency in parallel
  const [portRows, dbAdjacency] = await Promise.all([
    fetchPortRows(supabase, visitedIds),
    needAdjacencyFetch.length > 0
      ? fetchAdjacencyBatch(supabase, needAdjacencyFetch)
      : Promise.resolve(new Map<number, number[]>()),
  ]);
  for (const [id, neighbors] of dbAdjacency) {
    adjacencyMap.set(id, neighbors);
  }

  const portMap = new Map(portRows.map((row) => [row.sector_id, row]));
  const megaPortSectors = new Set(getMegaPortSectors(universeMeta));
  const rpcTimestamp = source.timestamp;

  const { results, sectorsSearched } = searchPorts({
    fromSector,
    maxHops,
    filters: { portTypeFilter, commodityFilter, tradeTypeFilter, megaFilter },
    portMap,
    adjacencyMap,
    knowledge,
    megaPortSectors,
    shipCurrentSector:
      typeof ship.current_sector === "number" ? ship.current_sector : null,
    shipInHyperspace: ship.in_hyperspace,
    rpcTimestamp,
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
  });

  return successResponse({ request_id: requestId });
}

async function fetchPortRows(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sectorIds: number[],
): Promise<PortRow[]> {
  if (sectorIds.length === 0) {
    return [];
  }
  const uniqueIds = Array.from(new Set(sectorIds));
  const { data: ports, error: portsError } = await supabase
    .from("ports")
    .select(
      "sector_id, port_code, port_class, max_qf, max_ro, max_ns, stock_qf, stock_ro, stock_ns, last_updated",
    )
    .in("sector_id", uniqueIds);
  if (portsError) {
    console.error("list_known_ports.ports", portsError);
    throw new ListKnownPortsError("failed to load ports", 500);
  }

  return (ports ?? []).map((port) => ({
    sector_id: port.sector_id,
    port_code: port.port_code,
    port_class: port.port_class,
    max_qf: port.max_qf,
    max_ro: port.max_ro,
    max_ns: port.max_ns,
    stock_qf: port.stock_qf,
    stock_ro: port.stock_ro,
    stock_ns: port.stock_ns,
    last_updated: port.last_updated ?? null,
  }));
}

async function fetchAdjacencyBatch(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sectorIds: number[],
): Promise<Map<number, number[]>> {
  if (sectorIds.length === 0) {
    return new Map();
  }
  const uniqueIds = Array.from(new Set(sectorIds));
  const { data, error } = await supabase
    .from("universe_structure")
    .select("sector_id, warps")
    .in("sector_id", uniqueIds);
  if (error) {
    throw new Error(`failed to load universe rows: ${error.message}`);
  }
  const adjacencyMap = new Map<number, number[]>();
  for (const row of data ?? []) {
    adjacencyMap.set(
      row.sector_id,
      parseWarpEdges(row.warps ?? []).map((edge) => edge.to),
    );
  }
  return adjacencyMap;
}

