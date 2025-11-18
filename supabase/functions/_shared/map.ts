import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { resolvePlayerType } from './status.ts';

function formatShipDisplayName(shipType: string): string {
  if (!shipType) {
    return 'Ship';
  }
  return shipType
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface WarpEdge {
  to: number;
  two_way?: boolean;
  hyperlane?: boolean;
}

export interface SectorSnapshot {
  id: number;
  adjacent_sectors: number[];
  position: [number, number];
  port: Record<string, unknown> | null;
  players: Array<Record<string, unknown>>;
  garrison: Array<Record<string, unknown>> | null;
  salvage: Array<Record<string, unknown>>;
  unowned_ships: Array<Record<string, unknown>>;
  scene_config: unknown;
}

export interface LocalMapSector {
  id: number;
  visited: boolean;
  hops_from_center: number;
  position: [number, number];
  port: string;
  lanes: WarpEdge[];
  adjacent_sectors?: number[];
  last_visited?: string;
}

export interface LocalMapRegionPayload {
  center_sector: number;
  sectors: LocalMapSector[];
  total_sectors: number;
  total_visited: number;
  total_unvisited: number;
}

export interface MapKnowledgeEntry {
  adjacent_sectors?: number[];
  last_visited?: string;
  position?: [number, number];
  port?: Record<string, unknown> | null;
}

export interface MapKnowledge {
  total_sectors_visited: number;
  sectors_visited: Record<string, MapKnowledgeEntry>;
  current_sector?: number | null;
  last_update?: string | null;
}

export interface PathRegionSector {
  sector_id: number;
  on_path: boolean;
  visited: boolean;
  hops_from_path: number;
  last_visited?: string;
  seen_from?: number[];
  adjacent_to_path_nodes?: number[];
  port?: Record<string, unknown> | null;
  players?: Array<Record<string, unknown>>;
  garrison?: Array<Record<string, unknown>>;
  salvage?: Array<Record<string, unknown>>;
  unowned_ships?: Array<Record<string, unknown>>;
  position?: [number, number];
  adjacent_sectors?: number[];
  [key: string]: unknown;
}

export interface ShortestPathResult {
  path: number[];
  distance: number;
}

export class PathNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathNotFoundError';
  }
}

const DEFAULT_KNOWLEDGE: MapKnowledge = {
  total_sectors_visited: 0,
  sectors_visited: {},
};

export function parseWarpEdges(raw: unknown): WarpEdge[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const toValue = (entry as Record<string, unknown>)['to'];
      const to = typeof toValue === 'number' ? toValue : Number(toValue);
      if (!Number.isFinite(to)) {
        return null;
      }
      return {
        to,
        two_way: Boolean((entry as Record<string, unknown>)['two_way'] ?? true),
        hyperlane: Boolean((entry as Record<string, unknown>)['hyperlane'] ?? false),
      } satisfies WarpEdge;
    })
    .filter((edge): edge is WarpEdge => Boolean(edge));
}

export function normalizeMapKnowledge(raw: unknown): MapKnowledge {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_KNOWLEDGE };
  }
  const obj = raw as Record<string, unknown>;
  const totalValue = obj['total_sectors_visited'];
  const total = typeof totalValue === 'number' && Number.isFinite(totalValue)
    ? totalValue
    : Number(obj['total']) || 0;

  const sectorsRaw = obj['sectors_visited'];
  const sectors: Record<string, MapKnowledgeEntry> = {};
  if (sectorsRaw && typeof sectorsRaw === 'object') {
    for (const [key, value] of Object.entries(sectorsRaw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const adjacentRaw = entry['adjacent_sectors'];
      let adjacent: number[] | undefined;
      if (Array.isArray(adjacentRaw)) {
        adjacent = adjacentRaw
          .map((val) => {
            if (typeof val === 'number') {
              return val;
            }
            if (typeof val === 'string' && val.trim() !== '') {
              const parsed = Number(val);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
          })
          .filter((item): item is number => Number.isFinite(item as number));
      }
      const lastVisitedValue = entry['last_visited'];
      const positionRaw = entry['position'];
      let position: [number, number] | undefined;
      if (
        Array.isArray(positionRaw) &&
        positionRaw.length === 2 &&
        positionRaw.every((component) => typeof component === 'number')
      ) {
        position = [positionRaw[0] as number, positionRaw[1] as number];
      }
      sectors[key] = {
        adjacent_sectors: adjacent,
        last_visited: typeof lastVisitedValue === 'string' ? lastVisitedValue : undefined,
        position,
      };
    }
  }

  return {
    total_sectors_visited: total,
    sectors_visited: sectors,
  };
}

export async function fetchSectorRow(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<{ sector_id: number; position_x: number; position_y: number; warps: unknown } | null> {
  const { data, error } = await supabase
    .from('universe_structure')
    .select('sector_id, position_x, position_y, warps')
    .eq('sector_id', sectorId)
    .maybeSingle();

  if (error) {
    throw new Error(`failed to load universe structure for sector ${sectorId}: ${error.message}`);
  }

  return data ?? null;
}

export async function buildSectorSnapshot(
  supabase: SupabaseClient,
  sectorId: number,
  currentCharacterId?: string,
): Promise<SectorSnapshot> {
  const [structureRow, sectorContents] = await Promise.all([
    fetchSectorRow(supabase, sectorId),
    supabase
      .from('sector_contents')
      .select('sector_id, port_id, salvage')
      .eq('sector_id', sectorId)
      .maybeSingle(),
  ]);

  if (!structureRow) {
    throw new Error(`sector ${sectorId} does not exist in universe_structure`);
  }

  if (sectorContents.error) {
    throw new Error(`failed to load sector contents: ${sectorContents.error.message}`);
  }

  const adjacentEdges = parseWarpEdges(structureRow.warps);
  const adjacent = adjacentEdges.map((edge) => edge.to);

  let port: Record<string, unknown> | null = null;
  const contentsData = sectorContents.data ?? undefined;
  if (contentsData && contentsData.port_id) {
    const { data: portRow, error: portError } = await supabase
      .from('ports')
      .select(
        'port_id, port_code, port_class, max_qf, max_ro, max_ns, stock_qf, stock_ro, stock_ns, last_updated',
      )
      .eq('port_id', contentsData.port_id)
      .maybeSingle();
    if (portError) {
      throw new Error(`failed to load port ${contentsData.port_id}: ${portError.message}`);
    }
    if (portRow) {
      port = {
        id: portRow.port_id,
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
        observed_at: portRow.last_updated,
      };
    }
  }

  const shipsQuery = supabase
    .from('ship_instances')
    .select('ship_id, ship_type, ship_name, owner_id, owner_character_id, owner_type, former_owner_name, became_unowned, current_fighters, current_shields, cargo_qf, cargo_ro, cargo_ns')
    .eq('current_sector', sectorId)
    .eq('in_hyperspace', false);
  const garrisonsQuery = supabase
    .from('garrisons')
    .select('owner_id, fighters, mode, toll_amount, toll_balance')
    .eq('sector_id', sectorId);

  const [{ data: ships, error: shipsError }, { data: garrisons, error: garrisonsError }] = await Promise.all([
    shipsQuery,
    garrisonsQuery,
  ]);

  if (shipsError) {
    throw new Error(`failed to load ships in sector ${sectorId}: ${shipsError.message}`);
  }
  if (garrisonsError) {
    throw new Error(`failed to load garrisons in sector ${sectorId}: ${garrisonsError.message}`);
  }

  const shipIds = (ships ?? []).map((ship) => ship.ship_id).filter((id): id is string => typeof id === 'string');
  let occupantRows: Array<{
    character_id: string;
    name: string;
    first_visit: string | null;
    player_metadata: Record<string, unknown> | null;
    current_ship_id: string;
  }> = [];
  if (shipIds.length > 0) {
    const { data, error } = await supabase
      .from('characters')
      .select('character_id, name, first_visit, player_metadata, current_ship_id')
      .in('current_ship_id', shipIds);
    if (error) {
      throw new Error(`failed to load occupants for sector ${sectorId}: ${error.message}`);
    }
    occupantRows = data ?? [];
  }

  const occupantMap = new Map(occupantRows.map((row) => [row.current_ship_id, row]));

  const ownerCharacterIds = (ships ?? [])
    .map((ship) => ship.owner_character_id)
    .filter((ownerId): ownerId is string => typeof ownerId === 'string');
  let ownerRows: Array<{ character_id: string; name: string; first_visit: string | null; player_metadata: Record<string, unknown> | null }> = [];
  if (ownerCharacterIds.length > 0) {
    const { data, error } = await supabase
      .from('characters')
      .select('character_id, name, first_visit, player_metadata')
      .in('character_id', ownerCharacterIds);
    if (error) {
      throw new Error(`failed to load ship owners for sector ${sectorId}: ${error.message}`);
    }
    ownerRows = data ?? [];
  }
  const ownerMap = new Map(ownerRows.map((row) => [row.character_id, row]));

  const players: Record<string, unknown>[] = [];
  const unownedShips: Record<string, unknown>[] = [];

  for (const ship of ships ?? []) {
    const occupant = ship.ship_id ? occupantMap.get(ship.ship_id) : null;

    if (!occupant) {
      // No occupant - this is an unowned ship
      const shipName = typeof ship.ship_name === 'string' ? ship.ship_name.trim() : '';
      const shipDisplayName = shipName.length > 0 ? shipName : formatShipDisplayName(ship.ship_type);
      unownedShips.push({
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        ship_name: shipDisplayName,
        owner_id: ship.owner_id ?? null,
        owner_type: ship.owner_type ?? null,
        former_owner_name: ship.former_owner_name ?? null,
        became_unowned: ship.became_unowned ?? null,
        fighters: ship.current_fighters ?? 0,
        shields: ship.current_shields ?? 0,
        cargo: {
          quantum_foam: ship.cargo_qf ?? 0,
          retro_organics: ship.cargo_ro ?? 0,
          neuro_symbolics: ship.cargo_ns ?? 0,
        },
      });
      continue;
    }

    // Has occupant - add to players list
    if (occupant.character_id === currentCharacterId) {
      continue;  // Skip current character
    }

    const playerType = resolvePlayerType(occupant.player_metadata);
    const characterMetadata = (occupant.player_metadata ?? null) as Record<string, unknown> | null;
    const legacyDisplayName = typeof characterMetadata?.legacy_display_name === 'string'
      ? characterMetadata.legacy_display_name.trim()
      : '';
    const displayName = legacyDisplayName?.length ? legacyDisplayName : (occupant.name ?? occupant.character_id);
    const shipName = typeof ship.ship_name === 'string' ? ship.ship_name.trim() : '';
    const shipDisplayName = shipName.length > 0 ? shipName : formatShipDisplayName(ship.ship_type);

    players.push({
      created_at: occupant.first_visit ?? null,
      id: occupant.character_id,
      name: displayName,
      player_type: playerType,
      ship: {
        ship_type: ship.ship_type,
        ship_name: shipDisplayName,
      },
    });
  }

  return {
    id: sectorId,
    adjacent_sectors: adjacent,
    position: [structureRow.position_x ?? 0, structureRow.position_y ?? 0],
    port,
    players,
    garrison: garrisons && garrisons.length > 0 ? garrisons : null,
    salvage: (contentsData && Array.isArray(contentsData.salvage)) ? contentsData.salvage : [],
    unowned_ships: unownedShips,
    scene_config: null,
  };
}

async function fetchUniverseRows(
  supabase: SupabaseClient,
  sectorIds: number[],
): Promise<Map<number, { position: [number, number]; warps: WarpEdge[] }>> {
  if (sectorIds.length === 0) {
    return new Map();
  }
  const uniqueIds = Array.from(new Set(sectorIds));
  const { data, error } = await supabase
    .from('universe_structure')
    .select('sector_id, position_x, position_y, warps')
    .in('sector_id', uniqueIds);
  if (error) {
    throw new Error(`failed to load universe rows: ${error.message}`);
  }
  const map = new Map<number, { position: [number, number]; warps: WarpEdge[] }>();
  for (const row of data ?? []) {
    map.set(row.sector_id, {
      position: [row.position_x ?? 0, row.position_y ?? 0],
      warps: parseWarpEdges(row.warps),
    });
  }
  return map;
}

async function loadPortCodes(
  supabase: SupabaseClient,
  sectorIds: number[],
): Promise<Record<number, string>> {
  if (sectorIds.length === 0) {
    return {};
  }
  const { data, error } = await supabase
    .from('ports')
    .select('sector_id, port_code')
    .in('sector_id', Array.from(new Set(sectorIds)));
  if (error) {
    throw new Error(`failed to load port codes: ${error.message}`);
  }
  const result: Record<number, string> = {};
  for (const row of data ?? []) {
    result[row.sector_id] = row.port_code;
  }
  return result;
}

export async function findShortestPath(
  supabase: SupabaseClient,
  params: { fromSector: number; toSector: number },
): Promise<ShortestPathResult> {
  const { fromSector, toSector } = params;
  if (fromSector === toSector) {
    return { path: [fromSector], distance: 0 };
  }

  const ensureSectorExists = async (sectorId: number): Promise<void> => {
    const row = await fetchSectorRow(supabase, sectorId);
    if (!row) {
      throw new Error(`sector ${sectorId} does not exist`);
    }
    adjacencyCache.set(sectorId, parseWarpEdges(row.warps ?? []).map((edge) => edge.to));
  };

  const adjacencyCache = new Map<number, number[]>();
  await Promise.all([ensureSectorExists(fromSector), ensureSectorExists(toSector)]);

  const getNeighbors = async (sectorId: number): Promise<number[]> => {
    if (adjacencyCache.has(sectorId)) {
      return adjacencyCache.get(sectorId)!;
    }
    const row = await fetchSectorRow(supabase, sectorId);
    if (!row) {
      throw new Error(`sector ${sectorId} does not exist`);
    }
    const neighbors = parseWarpEdges(row.warps ?? []).map((edge) => edge.to);
    adjacencyCache.set(sectorId, neighbors);
    return neighbors;
  };

  const visited = new Set<number>([fromSector]);
  const parents = new Map<number, number | null>([[fromSector, null]]);
  const queue: number[] = [fromSector];

  const buildPath = (target: number): number[] => {
    const path: number[] = [];
    let current: number | null | undefined = target;
    while (current !== null && current !== undefined) {
      path.unshift(current);
      current = parents.get(current) ?? null;
    }
    return path;
  };

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = await getNeighbors(current);
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parents.set(neighbor, current);
        if (neighbor === toSector) {
          const path = buildPath(neighbor);
          return {
            path,
            distance: path.length - 1,
          };
        }
        queue.push(neighbor);
      }
    }
  }

  throw new PathNotFoundError(`No path found from sector ${fromSector} to sector ${toSector}`);
}

export async function buildLocalMapRegion(
  supabase: SupabaseClient,
  params: {
    characterId: string;
    centerSector: number;
    mapKnowledge?: MapKnowledge;
    maxHops?: number;
    maxSectors?: number;
  },
): Promise<LocalMapRegionPayload> {
  const { characterId, centerSector } = params;
  const maxHops = params.maxHops ?? 4;
  const maxSectors = params.maxSectors ?? 28;

  let knowledge = params.mapKnowledge;
  if (!knowledge) {
    const { data, error } = await supabase
      .from('characters')
      .select('map_knowledge')
      .eq('character_id', characterId)
      .maybeSingle();
    if (error) {
      throw new Error(`failed to load map knowledge: ${error.message}`);
    }
    knowledge = normalizeMapKnowledge(data?.map_knowledge ?? null);
  }

  const visitedSet = new Set<number>(
    Object.keys(knowledge.sectors_visited).map((key) => Number(key)),
  );

  if (!visitedSet.has(centerSector)) {
    visitedSet.add(centerSector);
  }

  const distanceMap = new Map<number, number>([[centerSector, 0]]);
  const queue: Array<{ sector: number; hops: number }> = [{ sector: centerSector, hops: 0 }];
  const explored = new Set<number>([centerSector]);
  const unvisitedSeen = new Map<number, Set<number>>();

  const adjacencyCache = new Map<number, number[]>();

  const getAdjacency = async (sectorId: number): Promise<number[]> => {
    if (adjacencyCache.has(sectorId)) {
      return adjacencyCache.get(sectorId)!;
    }
    const knowledgeEntry = knowledge!.sectors_visited[String(sectorId)];
    let neighbors: number[] | undefined;
    if (knowledgeEntry?.adjacent_sectors) {
      neighbors = knowledgeEntry.adjacent_sectors;
    }
    if (!neighbors) {
      const row = await fetchSectorRow(supabase, sectorId);
      neighbors = parseWarpEdges(row?.warps ?? []).map((edge) => edge.to);
    }
    adjacencyCache.set(sectorId, neighbors ?? []);
    return neighbors ?? [];
  };

  while (queue.length > 0 && distanceMap.size < maxSectors) {
    const current = queue.shift()!;
    if (current.hops >= maxHops) {
      continue;
    }
    const neighbors = await getAdjacency(current.sector);
    for (const neighbor of neighbors) {
      if (!distanceMap.has(neighbor)) {
        distanceMap.set(neighbor, current.hops + 1);
      }
      if (!explored.has(neighbor) && visitedSet.has(neighbor)) {
        explored.add(neighbor);
        queue.push({ sector: neighbor, hops: current.hops + 1 });
      } else if (!visitedSet.has(neighbor)) {
        if (!unvisitedSeen.has(neighbor)) {
          unvisitedSeen.set(neighbor, new Set());
        }
        unvisitedSeen.get(neighbor)!.add(current.sector);
      }
      if (distanceMap.size >= maxSectors) {
        break;
      }
    }
  }

  const sectorIds = Array.from(distanceMap.keys());
  const [universeRows, portCodes] = await Promise.all([
    fetchUniverseRows(supabase, sectorIds),
    loadPortCodes(supabase, sectorIds.filter((id) => visitedSet.has(id))),
  ]);

  const resultSectors: LocalMapSector[] = [];
  for (const sectorId of sectorIds.sort((a, b) => a - b)) {
    const hops = distanceMap.get(sectorId) ?? 0;
    const universeRow = universeRows.get(sectorId);
    const position = universeRow?.position ?? [0, 0];
    const warps = universeRow?.warps ?? [];

    if (visitedSet.has(sectorId)) {
      const knowledgeEntry = knowledge.sectors_visited[String(sectorId)];
      resultSectors.push({
        id: sectorId,
        visited: true,
        hops_from_center: hops,
        position,
        port: portCodes[sectorId] ?? '',
        lanes: warps,
        adjacent_sectors: adjacencyCache.get(sectorId) ?? [],
        last_visited: knowledgeEntry?.last_visited,
      });
    } else {
      const seenFrom = Array.from(unvisitedSeen.get(sectorId) ?? []);
      const derivedLanes: WarpEdge[] = [];
      for (const source of seenFrom) {
        const sourceRow = universeRows.get(source);
        const match = sourceRow?.warps.find((warp) => warp.to === sectorId);
        if (match) {
          derivedLanes.push({ to: source, two_way: match.two_way, hyperlane: match.hyperlane });
        } else {
          derivedLanes.push({ to: source });
        }
      }
      resultSectors.push({
        id: sectorId,
        visited: false,
        hops_from_center: hops,
        position,
        port: '',
        lanes: derivedLanes,
      });
    }
  }

  const totalVisited = resultSectors.filter((sector) => sector.visited).length;
  const totalUnvisited = resultSectors.length - totalVisited;

  return {
    center_sector: centerSector,
    sectors: resultSectors,
    total_sectors: resultSectors.length,
    total_visited: totalVisited,
    total_unvisited: totalUnvisited,
  };
}

export function upsertVisitedSector(
  knowledge: MapKnowledge,
  sectorId: number,
  adjacent: number[],
  position: [number, number],
  timestamp: string,
): { updated: boolean; knowledge: MapKnowledge } {
  const key = String(sectorId);
  const existing = knowledge.sectors_visited[key];
  const nextEntry: MapKnowledgeEntry = {
    adjacent_sectors: adjacent,
    position,
    last_visited: timestamp,
  };
  const sameAdjacency = existing?.adjacent_sectors?.length === adjacent.length &&
    existing.adjacent_sectors?.every((value, idx) => value === adjacent[idx]);
  const sameTimestamp = existing?.last_visited === timestamp;

  if (existing && sameAdjacency && sameTimestamp) {
    return { updated: false, knowledge };
  }

  knowledge.sectors_visited[key] = nextEntry;
  const total = Object.keys(knowledge.sectors_visited).length;
  knowledge.total_sectors_visited = Math.max(knowledge.total_sectors_visited, total);
  return { updated: true, knowledge };
}

export async function getAdjacentSectors(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<number[]> {
  const row = await fetchSectorRow(supabase, sectorId);
  return parseWarpEdges(row?.warps ?? []).map((edge) => edge.to);
}

export async function loadMapKnowledge(
  supabase: SupabaseClient,
  characterId: string,
): Promise<MapKnowledge> {
  const { data, error } = await supabase
    .from('characters')
    .select('map_knowledge')
    .eq('character_id', characterId)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to load map knowledge: ${error.message}`);
  }
  return normalizeMapKnowledge(data?.map_knowledge ?? null);
}

export async function markSectorVisited(
  supabase: SupabaseClient,
  params: {
    characterId: string;
    sectorId: number;
    sectorSnapshot: SectorSnapshot;
    knowledge?: MapKnowledge;
  },
): Promise<{ firstVisit: boolean; knowledge: MapKnowledge }> {
  const { characterId, sectorId, sectorSnapshot } = params;
  const knowledge = params.knowledge ?? (await loadMapKnowledge(supabase, characterId));
  const sectorKey = String(sectorId);
  const visitedBefore = Boolean(knowledge.sectors_visited[sectorKey]);
  const timestamp = new Date().toISOString();

  const { knowledge: nextKnowledge } = upsertVisitedSector(
    knowledge,
    sectorId,
    sectorSnapshot.adjacent_sectors,
    sectorSnapshot.position,
    timestamp,
  );

  const entry = nextKnowledge.sectors_visited[sectorKey] ?? {};
  entry.port = sectorSnapshot.port ?? null;
  entry.last_visited = timestamp;
  nextKnowledge.sectors_visited[sectorKey] = entry;
  nextKnowledge.current_sector = sectorId;
  nextKnowledge.last_update = timestamp;

  const { error } = await supabase
    .from('characters')
    .update({ map_knowledge: nextKnowledge })
    .eq('character_id', characterId);
  if (error) {
    throw new Error(`failed to update map knowledge: ${error.message}`);
  }

  return { firstVisit: !visitedBefore, knowledge: nextKnowledge };
}

export async function buildPathRegionPayload(
  supabase: SupabaseClient,
  params: {
    characterId: string;
    knowledge: MapKnowledge;
    path: number[];
    regionHops: number;
    maxSectors: number;
  },
): Promise<{
  sectors: PathRegionSector[];
  total_sectors: number;
  known_sectors: number;
  unknown_sectors: number;
}> {
  const { characterId, knowledge, path, regionHops, maxSectors } = params;
  const visitedSet = new Set<number>(
    Object.keys(knowledge.sectors_visited).map((key) => Number(key)),
  );
  const pathSet = new Set(path);
  const distanceMap = new Map<number, number>();
  const unvisitedSeen = new Map<number, Set<number>>();
  const adjacencyCache = new Map<number, number[]>();

  const resolveAdjacency = async (sectorId: number): Promise<number[]> => {
    if (adjacencyCache.has(sectorId)) {
      return adjacencyCache.get(sectorId)!;
    }
    const knowledgeEntry = knowledge.sectors_visited[String(sectorId)];
    let neighbors: number[] | undefined = knowledgeEntry?.adjacent_sectors;
    if (!neighbors || neighbors.length === 0) {
      const row = await fetchSectorRow(supabase, sectorId);
      neighbors = parseWarpEdges(row?.warps ?? []).map((edge) => edge.to);
    }
    adjacencyCache.set(sectorId, neighbors ?? []);
    return adjacencyCache.get(sectorId)!;
  };

  const bfsQueue: Array<{ sector: number; hops: number }> = [];
  for (const sectorId of path) {
    distanceMap.set(sectorId, 0);
    if (visitedSet.has(sectorId) && regionHops > 0) {
      bfsQueue.push({ sector: sectorId, hops: 0 });
    }
  }

  let capacityReached = false;
  while (bfsQueue.length > 0 && !capacityReached) {
    const current = bfsQueue.shift()!;
    if (current.hops >= regionHops) {
      continue;
    }
    const neighbors = await resolveAdjacency(current.sector);
    for (const neighbor of neighbors) {
      const nextDistance = current.hops + 1;
      if (!distanceMap.has(neighbor) || nextDistance < (distanceMap.get(neighbor) ?? Infinity)) {
        distanceMap.set(neighbor, nextDistance);
      }
      if (visitedSet.has(neighbor)) {
        if (nextDistance < regionHops) {
          bfsQueue.push({ sector: neighbor, hops: nextDistance });
        }
      } else {
        if (!unvisitedSeen.has(neighbor)) {
          unvisitedSeen.set(neighbor, new Set());
        }
        unvisitedSeen.get(neighbor)!.add(current.sector);
      }
      if (distanceMap.size >= maxSectors) {
        capacityReached = true;
        break;
      }
    }
  }

  const sectorIds = Array.from(distanceMap.keys()).sort((a, b) => a - b);
  const visitedSnapshots = await Promise.all(
    sectorIds
      .filter((id) => visitedSet.has(id))
      .map(async (sectorId) => {
        try {
          const snapshot = await buildSectorSnapshot(supabase, sectorId, characterId);
          return [sectorId, snapshot] as const;
        } catch (error) {
          throw new Error(`failed to load sector snapshot for ${sectorId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
  );
  const snapshotMap = new Map<number, SectorSnapshot>(visitedSnapshots);

  const sectors: PathRegionSector[] = [];
  for (const sectorId of sectorIds) {
    const hopsFromPath = distanceMap.get(sectorId) ?? 0;
    const onPath = pathSet.has(sectorId);
    if (visitedSet.has(sectorId)) {
      const snapshot = snapshotMap.get(sectorId);
      if (!snapshot) {
        continue;
      }
      const knowledgeEntry = knowledge.sectors_visited[String(sectorId)] ?? {};
      const sectorPayload: PathRegionSector = {
        sector_id: sectorId,
        on_path: onPath,
        visited: true,
        hops_from_path: hopsFromPath,
        ...snapshot,
      };
      if (knowledgeEntry.last_visited) {
        sectorPayload.last_visited = knowledgeEntry.last_visited;
      }
      if (!onPath && knowledgeEntry.adjacent_sectors && knowledgeEntry.adjacent_sectors.length > 0) {
        const adjacentPathNodes = knowledgeEntry.adjacent_sectors.filter((adj) => pathSet.has(Number(adj)));
        if (adjacentPathNodes.length > 0) {
          sectorPayload.adjacent_to_path_nodes = adjacentPathNodes;
        }
      }
      sectors.push(sectorPayload);
    } else {
      const seenFrom = Array.from(unvisitedSeen.get(sectorId) ?? []);
      sectors.push({
        sector_id: sectorId,
        on_path: onPath,
        visited: false,
        hops_from_path: hopsFromPath,
        seen_from: seenFrom,
      });
    }
  }

  const knownCount = sectors.filter((sector) => sector.visited).length;
  return {
    sectors,
    total_sectors: sectors.length,
    known_sectors: knownCount,
    unknown_sectors: sectors.length - knownCount,
  };
}
