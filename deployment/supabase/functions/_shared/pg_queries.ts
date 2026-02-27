/**
 * Direct PostgreSQL query helpers for edge functions.
 * Uses the Deno Postgres client for efficient database access.
 */

import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { RATE_LIMITS } from "./constants.ts";
import type { CharacterRow, ShipRow, ShipDefinitionRow } from "./status.ts";
import type {
  MapKnowledge,
  WarpEdge,
  SectorSnapshot,
  LocalMapSectorGarrison,
} from "./map.ts";
import {
  parseWarpEdges,
  normalizeMapKnowledge,
  mergeMapKnowledge,
} from "./map.ts";
import { resolvePlayerType } from "./status.ts";
import { ActorAuthorizationError } from "./actors.ts";
import { runBFS, findDisconnectedSectors } from "./local_map_bfs.ts";
import { getPortPrices, getPortStock, type PortData } from "./trading.ts";
import { injectCharacterEventIdentity } from "./event_identity.ts";

// Helper to convert BigInt values to numbers recursively
// deno-postgres returns BigInt for int8 columns even with ::int cast
function convertBigInts<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === "bigint") {
    return Number(obj) as unknown as T;
  }
  if (obj instanceof Date) {
    return obj.toISOString() as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(convertBigInts) as unknown as T;
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = convertBigInts(value);
    }
    return result as T;
  }
  return obj;
}

// ============================================================================
// Universe Meta Helpers
// ============================================================================

interface UniverseMeta {
  mega_port_sectors?: number[] | null;
  mega_port_sector?: number | null;
  fedspace_sectors?: number[] | null;
  fedspace_region_name?: string | null;
}

const META_CACHE_TTL_MS = 30_000;
let cachedUniverseMeta: UniverseMeta | null = null;
let cachedUniverseMetaExpiresAt = 0;

function normalizeSectorList(raw: unknown): number[] {
  const values: number[] = [];
  const pushValue = (entry: unknown) => {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      values.push(Math.floor(entry));
      return;
    }
    if (typeof entry === "string") {
      const parsed = Number(entry);
      if (Number.isFinite(parsed)) {
        values.push(Math.floor(parsed));
      }
    }
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      pushValue(entry);
    }
  } else if (raw !== null && raw !== undefined) {
    pushValue(raw);
  }

  return Array.from(new Set(values));
}

export function pgIsMegaPortSector(
  meta: UniverseMeta,
  sectorId: number,
): boolean {
  const list = normalizeSectorList(meta.mega_port_sectors);
  if (list.length > 0) {
    return list.includes(sectorId);
  }
  const fallback = normalizeSectorList(meta.mega_port_sector);
  if (fallback.length > 0) {
    return fallback.includes(sectorId);
  }
  return sectorId === 0;
}

export async function pgLoadUniverseMeta(pg: Client): Promise<UniverseMeta> {
  if (cachedUniverseMeta && cachedUniverseMetaExpiresAt > Date.now()) {
    return cachedUniverseMeta;
  }
  const result = await pg.queryObject<{ meta: unknown }>(
    `SELECT meta FROM universe_config WHERE id = 1`,
  );
  cachedUniverseMeta = (result.rows[0]?.meta ?? {}) as UniverseMeta;
  cachedUniverseMetaExpiresAt = Date.now() + META_CACHE_TTL_MS;
  return cachedUniverseMeta;
}

async function pgIsFedspaceSector(
  pg: Client,
  sectorId: number,
  meta?: UniverseMeta,
): Promise<boolean> {
  const resolvedMeta = meta ?? (await pgLoadUniverseMeta(pg));
  const fedspace = normalizeSectorList(resolvedMeta.fedspace_sectors);
  if (fedspace.length > 0) {
    return fedspace.includes(sectorId);
  }

  const regionName =
    typeof resolvedMeta.fedspace_region_name === "string" &&
    resolvedMeta.fedspace_region_name.trim()
      ? resolvedMeta.fedspace_region_name.trim()
      : "Federation Space";
  const result = await pg.queryObject<{ region: string | null }>(
    `SELECT region FROM universe_structure WHERE sector_id = $1`,
    [sectorId],
  );
  return result.rows[0]?.region === regionName;
}

// ============================================================================
// Rate Limiting
// ============================================================================

export class RateLimitError extends Error {
  constructor(message = "rate limit exceeded") {
    super(message);
    this.name = "RateLimitError";
  }
}

export async function pgEnforceRateLimit(
  pg: Client,
  characterId: string | null,
  endpoint: string,
): Promise<void> {
  if (!characterId) {
    return;
  }

  const rule = RATE_LIMITS[endpoint] ?? RATE_LIMITS.default;

  const result = await pg.queryArray<[boolean]>(
    `SELECT check_and_increment_rate_limit($1, $2, $3, $4)`,
    [characterId, endpoint, rule.max, rule.window],
  );

  const allowed = result.rows[0]?.[0];
  if (allowed !== true) {
    throw new RateLimitError();
  }
}

// ============================================================================
// Character / Ship / Ship Definition Loading
// ============================================================================

export async function pgLoadCharacter(
  pg: Client,
  characterId: string,
): Promise<CharacterRow> {
  const result = await pg.queryObject<CharacterRow>(
    `SELECT
      character_id,
      name,
      current_ship_id,
      credits_in_megabank::bigint as credits_in_megabank,
      map_knowledge,
      player_metadata,
      first_visit,
      last_active,
      corporation_id,
      corporation_joined_at
    FROM characters
    WHERE character_id = $1`,
    [characterId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`character ${characterId} not found`);
  }
  if (!row.current_ship_id) {
    throw new Error(`character ${characterId} does not have an assigned ship`);
  }
  return convertBigInts(row);
}

export async function pgLoadShip(pg: Client, shipId: string): Promise<ShipRow> {
  const result = await pg.queryObject<ShipRow>(
    `SELECT
      ship_id,
      owner_id,
      owner_type,
      owner_character_id,
      owner_corporation_id,
      acquired,
      became_unowned,
      former_owner_name,
      ship_type,
      ship_name,
      current_sector::int as current_sector,
      in_hyperspace,
      credits::bigint as credits,
      cargo_qf::int as cargo_qf,
      cargo_ro::int as cargo_ro,
      cargo_ns::int as cargo_ns,
      current_warp_power::int as current_warp_power,
      current_shields::int as current_shields,
      current_fighters::int as current_fighters
    FROM ship_instances
    WHERE ship_id = $1`,
    [shipId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`ship ${shipId} not found`);
  }
  return convertBigInts(row);
}

export async function pgLoadShipDefinition(
  pg: Client,
  shipType: string,
): Promise<ShipDefinitionRow> {
  const result = await pg.queryObject<ShipDefinitionRow>(
    `SELECT
      ship_type,
      display_name,
      cargo_holds::int as cargo_holds,
      warp_power_capacity::int as warp_power_capacity,
      turns_per_warp::int as turns_per_warp,
      shields::int as shields,
      fighters::int as fighters,
      purchase_price::numeric as purchase_price
    FROM ship_definitions
    WHERE ship_type = $1`,
    [shipType],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`ship definition ${shipType} missing`);
  }
  return convertBigInts(row);
}

// ============================================================================
// Actor Authorization
// ============================================================================

export async function pgEnsureActorCanControlShip(
  pg: Client,
  actorId: string,
  corpId: string,
): Promise<boolean> {
  const result = await pg.queryObject<{ character_id: string }>(
    `SELECT character_id
    FROM corporation_members
    WHERE corp_id = $1
      AND character_id = $2
      AND left_at IS NULL
    LIMIT 1`,
    [corpId, actorId],
  );
  return result.rows.length > 0;
}

// ============================================================================
// Combat State
// ============================================================================

interface CombatRow {
  sector_id: number;
  combat: unknown;
}

export async function pgLoadCombatForSector(
  pg: Client,
  sectorId: number,
): Promise<{ combat: unknown; sector_id: number } | null> {
  const result = await pg.queryObject<CombatRow>(
    `SELECT sector_id::int, combat
    FROM sector_contents
    WHERE sector_id = $1`,
    [sectorId],
  );

  const row = result.rows[0];
  if (!row || !row.combat) {
    return null;
  }
  return { combat: row.combat, sector_id: row.sector_id };
}

// ============================================================================
// Universe Structure / Sectors
// ============================================================================

interface SectorRow {
  sector_id: number;
  position_x: number;
  position_y: number;
  warps: unknown;
}

export async function pgFetchSectorRow(
  pg: Client,
  sectorId: number,
): Promise<SectorRow | null> {
  const result = await pg.queryObject<SectorRow>(
    `SELECT sector_id::int, position_x::int, position_y::int, warps
    FROM universe_structure
    WHERE sector_id = $1`,
    [sectorId],
  );
  return result.rows[0] ?? null;
}

export async function pgGetAdjacentSectors(
  pg: Client,
  sectorId: number,
): Promise<number[]> {
  const row = await pgFetchSectorRow(pg, sectorId);
  return parseWarpEdges(row?.warps ?? []).map((edge) => edge.to);
}

export interface ShortestPathResult {
  path: number[];
  distance: number;
}

export async function pgFindShortestPath(
  pg: Client,
  params: { fromSector: number; toSector: number },
): Promise<ShortestPathResult | null> {
  const { fromSector, toSector } = params;
  if (fromSector === toSector) {
    return { path: [fromSector], distance: 0 };
  }

  const adjacencyCache = new Map<number, number[]>();
  const universeRowCache = new Map<
    number,
    { position: [number, number]; region: string | null; warps: WarpEdge[] }
  >();

  const hydrateUniverseRows = async (sectorIds: number[]): Promise<void> => {
    const missing = sectorIds.filter((id) => !universeRowCache.has(id));
    if (missing.length === 0) {
      return;
    }
    const rows = await pgFetchUniverseRows(pg, missing);
    for (const [id, row] of rows) {
      universeRowCache.set(id, row);
    }
    for (const id of missing) {
      if (!universeRowCache.has(id)) {
        throw new Error(`sector ${id} does not exist`);
      }
    }
  };

  const ensureAdjacency = async (sectorIds: number[]): Promise<void> => {
    const toFetch: number[] = [];
    for (const sectorId of sectorIds) {
      if (adjacencyCache.has(sectorId)) {
        continue;
      }
      const row = universeRowCache.get(sectorId);
      if (row) {
        adjacencyCache.set(
          sectorId,
          row.warps.map((edge) => edge.to),
        );
      } else {
        toFetch.push(sectorId);
      }
    }
    if (toFetch.length === 0) {
      return;
    }
    await hydrateUniverseRows(toFetch);
    for (const sectorId of toFetch) {
      const row = universeRowCache.get(sectorId);
      const neighbors = row?.warps.map((edge) => edge.to) ?? [];
      adjacencyCache.set(sectorId, neighbors);
    }
  };

  await hydrateUniverseRows([fromSector, toSector]);

  const visited = new Set<number>([fromSector]);
  const parents = new Map<number, number | null>([[fromSector, null]]);
  let frontier: number[] = [fromSector];

  const buildPath = (target: number): number[] => {
    const path: number[] = [];
    let current: number | null | undefined = target;
    while (current !== null && current !== undefined) {
      path.unshift(current);
      current = parents.get(current) ?? null;
    }
    return path;
  };

  while (frontier.length > 0) {
    await ensureAdjacency(frontier);
    const next: number[] = [];
    for (const current of frontier) {
      const neighbors = adjacencyCache.get(current) ?? [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          parents.set(neighbor, current);
          if (neighbor === toSector) {
            const path = buildPath(neighbor);
            return { path, distance: path.length - 1 };
          }
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  // No path found
  return null;
}

// ============================================================================
// Hyperspace Operations
// ============================================================================

export class MoveError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MoveError";
    this.status = status;
  }
}

export async function pgStartHyperspace(
  pg: Client,
  params: {
    shipId: string;
    currentSector: number;
    destination: number;
    eta: string;
    newWarpTotal: number;
  },
): Promise<void> {
  const { shipId, currentSector, destination, eta, newWarpTotal } = params;

  const result = await pg.queryObject<{ ship_id: string }>(
    `UPDATE ship_instances
    SET
      in_hyperspace = true,
      hyperspace_destination = $1,
      hyperspace_eta = $2::timestamptz,
      current_warp_power = $3
    WHERE ship_id = $4
      AND in_hyperspace = false
      AND current_sector = $5
    RETURNING ship_id`,
    [destination, eta, newWarpTotal, shipId, currentSector],
  );

  if (result.rows.length === 0) {
    throw new MoveError("failed to enter hyperspace", 409);
  }
}

export async function pgFinishHyperspace(
  pg: Client,
  params: {
    shipId: string;
    destination: number;
  },
): Promise<void> {
  const { shipId, destination } = params;

  const result = await pg.queryObject(
    `UPDATE ship_instances
    SET
      current_sector = $1,
      in_hyperspace = false,
      hyperspace_destination = NULL,
      hyperspace_eta = NULL
    WHERE ship_id = $2`,
    [destination, shipId],
  );

  if (result.rowCount === 0) {
    throw new MoveError("failed to complete movement", 500);
  }
}

/**
 * Combined finish hyperspace + update last active in a single round trip.
 * Used by completeMovement to save 1 query.
 */
export async function pgFinishHyperspaceAndUpdateActive(
  pg: Client,
  params: {
    shipId: string;
    destination: number;
    characterId: string;
  },
): Promise<void> {
  const { shipId, destination, characterId } = params;

  const result = await pg.queryObject(
    `WITH finish AS (
      UPDATE ship_instances
      SET current_sector = $1, in_hyperspace = false,
          hyperspace_destination = NULL, hyperspace_eta = NULL
      WHERE ship_id = $2
    )
    UPDATE characters SET last_active = NOW() WHERE character_id = $3`,
    [destination, shipId, characterId],
  );

  // The CTE rowCount reflects the outer UPDATE; check it ran
  if (result.rowCount === 0) {
    throw new MoveError("failed to complete movement (character update)", 500);
  }
}

// ============================================================================
// Character Updates
// ============================================================================

export async function pgUpdateCharacterLastActive(
  pg: Client,
  characterId: string,
): Promise<void> {
  await pg.queryObject(
    `UPDATE characters
    SET last_active = NOW()
    WHERE character_id = $1`,
    [characterId],
  );
}

/**
 * Set source='player' on all entries in a MapKnowledge object.
 * Used when there's no corp knowledge to merge.
 */
function setPlayerSource(knowledge: MapKnowledge): MapKnowledge {
  const result: MapKnowledge = {
    total_sectors_visited: knowledge.total_sectors_visited,
    sectors_visited: {},
    current_sector: knowledge.current_sector,
    last_update: knowledge.last_update,
  };
  for (const [sectorId, entry] of Object.entries(knowledge.sectors_visited)) {
    result.sectors_visited[sectorId] = { ...entry, source: "player" };
  }
  return result;
}

export interface MapKnowledgeComponents {
  personal: MapKnowledge;
  corp: MapKnowledge | null;
  merged: MapKnowledge;
}

/**
 * Load personal and corp map knowledge, returning both separately and merged.
 * Use this when you need the individual components (e.g., to pass to pgMarkSectorVisited).
 */
export async function pgLoadMapKnowledgeComponents(
  pg: Client,
  characterId: string,
): Promise<MapKnowledgeComponents> {
  const result = await pg.queryObject<{
    map_knowledge: unknown;
    corporation_id: string | null;
    corp_map_knowledge: unknown | null;
  }>(
    `SELECT
      c.map_knowledge,
      c.corporation_id,
      cmk.map_knowledge as corp_map_knowledge
    FROM characters c
    LEFT JOIN corporation_map_knowledge cmk ON cmk.corp_id = c.corporation_id
    WHERE c.character_id = $1`,
    [characterId],
  );

  const row = result.rows[0];
  const personal = normalizeMapKnowledge(row?.map_knowledge ?? null);
  const corp = row?.corp_map_knowledge
    ? normalizeMapKnowledge(row.corp_map_knowledge)
    : null;

  const merged = corp
    ? mergeMapKnowledge(personal, corp)
    : setPlayerSource(personal);
  return { personal, corp, merged };
}

export async function pgLoadMapKnowledge(
  pg: Client,
  characterId: string,
): Promise<MapKnowledge> {
  const { merged } = await pgLoadMapKnowledgeComponents(pg, characterId);
  return merged;
}

export async function pgUpdateMapKnowledge(
  pg: Client,
  characterId: string,
  knowledge: MapKnowledge,
): Promise<void> {
  await pg.queryObject(
    `UPDATE characters
    SET map_knowledge = $1::jsonb
    WHERE character_id = $2`,
    [JSON.stringify(knowledge), characterId],
  );
}

// ============================================================================
// Corporation Map Knowledge
// ============================================================================

export async function pgUpsertCorporationSectorKnowledge(
  pg: Client,
  params: {
    corpId: string;
    sectorId: number;
    sectorSnapshot: SectorSnapshot;
  },
): Promise<{ firstVisit: boolean; knowledge: MapKnowledge }> {
  const { corpId, sectorId, sectorSnapshot } = params;
  const sectorKey = String(sectorId);
  const timestamp = new Date().toISOString();

  // Ensure row exists for corporation
  await pg.queryObject(
    `INSERT INTO corporation_map_knowledge (corp_id)
    VALUES ($1)
    ON CONFLICT (corp_id) DO NOTHING`,
    [corpId],
  );

  // Load current corp knowledge
  const result = await pg.queryObject<{ map_knowledge: unknown }>(
    `SELECT map_knowledge
    FROM corporation_map_knowledge
    WHERE corp_id = $1`,
    [corpId],
  );

  const knowledge = normalizeMapKnowledge(
    result.rows[0]?.map_knowledge ?? null,
  );
  const visitedBefore = Boolean(knowledge.sectors_visited[sectorKey]);

  // Update the sector entry
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

  // Save updated knowledge
  await pg.queryObject(
    `UPDATE corporation_map_knowledge
    SET map_knowledge = $1::jsonb
    WHERE corp_id = $2`,
    [JSON.stringify(nextKnowledge), corpId],
  );

  return { firstVisit: !visitedBefore, knowledge: nextKnowledge };
}

// ============================================================================
// Sector Snapshot Building (for buildSectorSnapshot)
// ============================================================================

interface SectorContentsRow {
  sector_id: number;
  port_id: string | null;
  salvage: unknown;
}

interface ShipInSectorRow {
  ship_id: string;
  ship_type: string;
  ship_name: string | null;
  owner_id: string | null;
  owner_character_id: string | null;
  owner_type: string | null;
  former_owner_name: string | null;
  became_unowned: string | null;
  current_fighters: number;
  current_shields: number;
  cargo_qf: number;
  cargo_ro: number;
  cargo_ns: number;
}

interface GarrisonRow {
  owner_id: string;
  fighters: number;
  mode: string;
  toll_amount: number;
  toll_balance: number;
}

interface CharacterOccupantRow {
  character_id: string;
  name: string;
  first_visit: string | null;
  player_metadata: Record<string, unknown> | null;
  current_ship_id: string;
  corporation_id: string | null;
  corporation_joined_at: string | null;
}

interface CorpRow {
  corp_id: string;
  name: string;
}

function formatShipDisplayName(shipType: string): string {
  if (!shipType) {
    return "Ship";
  }
  return shipType
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function pgBuildSectorSnapshot(
  pg: Client,
  sectorId: number,
  currentCharacterId?: string,
): Promise<SectorSnapshot> {
  // Single CTE query to fetch all sector data in one round trip
  const result = await pg.queryObject<{
    sector_id: number;
    warps: unknown;
    position_x: number;
    position_y: number;
    region: string | null;
    salvage: unknown[] | null;
    port_json: string | null;
    ships_json: string | null;
    garrisons_json: string | null;
    garrison_count: number | null;
    occupants_json: string | null;
    corps_json: string | null;
  }>(
    `WITH
    sector_base AS (
      SELECT sector_id, warps, position_x, position_y, region
      FROM universe_structure
      WHERE sector_id = $1
    ),
    sector_contents AS (
      SELECT sector_id, port_id, salvage
      FROM sector_contents
      WHERE sector_id = $1
    ),
    port_data AS (
      SELECT p.port_id, p.port_code, p.port_class,
             p.max_qf::int, p.max_ro::int, p.max_ns::int,
             p.stock_qf::int, p.stock_ro::int, p.stock_ns::int,
             p.last_updated
      FROM sector_contents sc
      JOIN ports p ON p.port_id = sc.port_id
      WHERE sc.sector_id = $1
    ),
    ships_data AS (
      SELECT ship_id, ship_type, ship_name, owner_id, owner_character_id, owner_type,
             former_owner_name, became_unowned,
             current_fighters::int, current_shields::int,
             cargo_qf::int, cargo_ro::int, cargo_ns::int
      FROM ship_instances
      WHERE current_sector = $1 AND in_hyperspace = false AND destroyed_at IS NULL
    ),
    garrisons_data AS (
      SELECT owner_id,
             fighters::int,
             mode,
             toll_amount::float8 AS toll_amount,
             toll_balance::float8 AS toll_balance,
             deployed_at,
             updated_at
      FROM garrisons
      WHERE sector_id = $1
      ORDER BY updated_at DESC NULLS LAST, deployed_at DESC NULLS LAST, owner_id ASC
    ),
    garrison_count_data AS (
      SELECT COUNT(*)::int AS garrison_count
      FROM garrisons_data
    ),
    occupants_data AS (
      SELECT c.character_id, c.name, c.first_visit, c.player_metadata,
             c.current_ship_id, c.corporation_id, c.corporation_joined_at
      FROM characters c
      WHERE c.current_ship_id IN (SELECT ship_id FROM ships_data)
    ),
    all_character_ids AS (
      SELECT character_id FROM occupants_data
      UNION
      SELECT owner_id FROM garrisons_data WHERE owner_id IS NOT NULL
    ),
    character_corp_info AS (
      SELECT c.character_id, c.corporation_id, c.name
      FROM characters c
      WHERE c.character_id IN (SELECT character_id FROM all_character_ids)
    ),
    corp_ids AS (
      SELECT DISTINCT corporation_id
      FROM occupants_data
      WHERE corporation_id IS NOT NULL
    ),
    corps_data AS (
      SELECT corp.corp_id, corp.name, COUNT(cm.character_id)::int as member_count
      FROM corporations corp
      LEFT JOIN corporation_members cm ON cm.corp_id = corp.corp_id AND cm.left_at IS NULL
      WHERE corp.corp_id IN (SELECT corporation_id FROM corp_ids)
      GROUP BY corp.corp_id, corp.name
    )
    SELECT
      sb.sector_id::int,
      sb.warps,
      sb.position_x::int,
      sb.position_y::int,
      sb.region,
      sc.salvage,
      (SELECT row_to_json(p) FROM port_data p) as port_json,
      (SELECT COALESCE(json_agg(s), '[]'::json) FROM ships_data s) as ships_json,
      (SELECT COALESCE(json_agg(g), '[]'::json) FROM garrisons_data g) as garrisons_json,
      (SELECT garrison_count FROM garrison_count_data) as garrison_count,
      (SELECT COALESCE(json_agg(json_build_object(
        'character_id', o.character_id,
        'name', o.name,
        'first_visit', o.first_visit,
        'player_metadata', o.player_metadata,
        'current_ship_id', o.current_ship_id,
        'corporation_id', o.corporation_id,
        'corporation_joined_at', o.corporation_joined_at,
        'corp_name', cci.name
      )), '[]'::json) FROM occupants_data o
        LEFT JOIN character_corp_info cci ON cci.character_id = o.character_id
      ) as occupants_json,
      (SELECT COALESCE(json_agg(c), '[]'::json) FROM corps_data c) as corps_json
    FROM sector_base sb
    LEFT JOIN sector_contents sc ON sc.sector_id = sb.sector_id`,
    [sectorId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`sector ${sectorId} does not exist in universe_structure`);
  }

  // Parse JSON results
  type PortJson = {
    port_id: number;
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
  type ShipJson = {
    ship_id: string;
    ship_type: string;
    ship_name: string | null;
    owner_id: string | null;
    owner_character_id: string | null;
    owner_type: string | null;
    former_owner_name: string | null;
    became_unowned: string | null;
    current_fighters: number;
    current_shields: number;
    cargo_qf: number;
    cargo_ro: number;
    cargo_ns: number;
  };
  type GarrisonJson = {
    owner_id: string | null;
    fighters: number;
    mode: string;
    toll_amount: number;
    toll_balance: number;
    deployed_at: string | null;
    updated_at?: string | null;
  };
  type OccupantJson = {
    character_id: string;
    name: string;
    first_visit: string | null;
    player_metadata: Record<string, unknown> | null;
    current_ship_id: string;
    corporation_id: string | null;
    corporation_joined_at: string | null;
    corp_name: string | null;
  };
  type CorpJson = {
    corp_id: string;
    name: string;
    member_count: number;
  };

  const portData: PortJson | null = row.port_json
    ? typeof row.port_json === "string"
      ? JSON.parse(row.port_json)
      : row.port_json
    : null;
  const ships: ShipJson[] = row.ships_json
    ? typeof row.ships_json === "string"
      ? JSON.parse(row.ships_json)
      : row.ships_json
    : [];
  const garrisons: GarrisonJson[] = row.garrisons_json
    ? typeof row.garrisons_json === "string"
      ? JSON.parse(row.garrisons_json)
      : row.garrisons_json
    : [];
  const garrisonCount =
    typeof row.garrison_count === "number" && Number.isFinite(row.garrison_count)
      ? row.garrison_count
      : garrisons.length;
  if (garrisonCount > 1) {
    console.warn("pgBuildSectorSnapshot.multiple_garrisons", {
      sector_id: sectorId,
      garrison_count: garrisonCount,
      owners: garrisons.map((garrison) => garrison.owner_id).filter(Boolean),
    });
  }
  const occupants: OccupantJson[] = row.occupants_json
    ? typeof row.occupants_json === "string"
      ? JSON.parse(row.occupants_json)
      : row.occupants_json
    : [];
  const corps: CorpJson[] = row.corps_json
    ? typeof row.corps_json === "string"
      ? JSON.parse(row.corps_json)
      : row.corps_json
    : [];

  // Parse warps for adjacent sectors
  const adjacentEdges = parseWarpEdges(row.warps);
  const adjacent = adjacentEdges.map((edge) => edge.to);

  // Build port object with calculated prices
  let port: Record<string, unknown> | null = null;
  if (portData) {
    const universeMeta = await pgLoadUniverseMeta(pg);
    const isMega = pgIsMegaPortSector(universeMeta, sectorId);
    // Build PortData structure for price calculation
    const portDataForPricing: PortData = {
      code: portData.port_code,
      class: portData.port_class,
      stock: {
        QF: portData.stock_qf,
        RO: portData.stock_ro,
        NS: portData.stock_ns,
      },
      max_capacity: {
        QF: portData.max_qf,
        RO: portData.max_ro,
        NS: portData.max_ns,
      },
      buys: [],
      sells: [],
    };
    // Determine buys/sells from port code
    const commodityOrder = [
      "quantum_foam",
      "retro_organics",
      "neuro_symbolics",
    ] as const;
    for (let i = 0; i < commodityOrder.length; i++) {
      const char = portData.port_code?.charAt(i) ?? "S";
      if (char === "B") {
        portDataForPricing.buys.push(commodityOrder[i]);
      } else {
        portDataForPricing.sells.push(commodityOrder[i]);
      }
    }

    // Calculate prices based on supply/demand
    const prices = getPortPrices(portDataForPricing);
    const stock = getPortStock(portDataForPricing);

    port = {
      id: portData.port_id,
      code: portData.port_code,
      port_class: portData.port_class,
      mega: isMega,
      prices,
      stock,
      observed_at: portData.last_updated,
    };
  }

  // Build maps for lookups
  const occupantMap = new Map(occupants.map((o) => [o.current_ship_id, o]));
  const corporationMap = new Map(corps.map((c) => [c.corp_id, c]));

  // For garrison owner lookup, we need character info
  // Query separately only if we have garrisons with owners not in occupants
  const garrisonOwnerIds = garrisons
    .map((g) => g.owner_id)
    .filter((id): id is string => typeof id === "string");
  const occupantCharIds = new Set(occupants.map((o) => o.character_id));
  const missingOwnerIds = garrisonOwnerIds.filter(
    (id) => !occupantCharIds.has(id),
  );

  let characterCorpMap = new Map<string, string | null>();
  let characterNameMap = new Map<string, string>();

  // Populate from occupants
  for (const occ of occupants) {
    characterCorpMap.set(occ.character_id, occ.corporation_id);
    characterNameMap.set(occ.character_id, occ.name);
  }

  // If we have garrison owners not in occupants, fetch them separately
  if (missingOwnerIds.length > 0) {
    const extraChars = await pg.queryObject<{
      character_id: string;
      corporation_id: string | null;
      name: string;
    }>(
      `SELECT character_id, corporation_id, name
      FROM characters
      WHERE character_id = ANY($1::uuid[])`,
      [missingOwnerIds],
    );
    for (const char of extraChars.rows) {
      characterCorpMap.set(char.character_id, char.corporation_id);
      characterNameMap.set(char.character_id, char.name);
    }
  }

  // Build players and unowned ships lists
  const players: Record<string, unknown>[] = [];
  const unownedShips: Record<string, unknown>[] = [];

  for (const ship of ships) {
    const occupant = ship.ship_id ? occupantMap.get(ship.ship_id) : null;

    if (!occupant) {
      const shipName =
        typeof ship.ship_name === "string" ? ship.ship_name.trim() : "";
      const shipDisplayName =
        shipName.length > 0 ? shipName : formatShipDisplayName(ship.ship_type);
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

    if (occupant.character_id === currentCharacterId) {
      continue;
    }

    const playerType = resolvePlayerType(occupant.player_metadata);
    const characterMetadata = occupant.player_metadata ?? null;
    const legacyDisplayName =
      typeof characterMetadata?.legacy_display_name === "string"
        ? (characterMetadata.legacy_display_name as string).trim()
        : "";
    const displayName = legacyDisplayName?.length
      ? legacyDisplayName
      : (occupant.name ?? occupant.character_id);
    const shipName =
      typeof ship.ship_name === "string" ? ship.ship_name.trim() : "";
    const shipDisplayName =
      shipName.length > 0 ? shipName : formatShipDisplayName(ship.ship_type);

    let corporationInfo: Record<string, unknown> | null = null;
    if (occupant.corporation_id) {
      const corpSummary = corporationMap.get(occupant.corporation_id);
      if (corpSummary) {
        corporationInfo = {
          ...corpSummary,
          joined_at: occupant.corporation_joined_at,
        };
      }
    }

    players.push({
      created_at: occupant.first_visit ?? null,
      id: occupant.character_id,
      name: displayName,
      player_type: playerType,
      corporation: corporationInfo,
      ship: {
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        ship_name: shipDisplayName,
      },
    });
  }

  // Build garrison object
  let garrisonObject: Record<string, unknown> | null = null;
  if (garrisons.length > 0) {
    const garrison = garrisons[0];
    const garrisonOwnerId = garrison.owner_id;
    const currentCharacterCorpId = currentCharacterId
      ? characterCorpMap.get(currentCharacterId)
      : null;
    const garrisonOwnerCorpId = garrisonOwnerId
      ? characterCorpMap.get(garrisonOwnerId)
      : null;

    const isFriendly = Boolean(
      currentCharacterId === garrisonOwnerId ||
      (currentCharacterCorpId &&
        garrisonOwnerCorpId &&
        currentCharacterCorpId === garrisonOwnerCorpId),
    );

    const ownerName = garrisonOwnerId
      ? (characterNameMap.get(garrisonOwnerId) ?? "unknown")
      : "unknown";

    garrisonObject = {
      owner_id: garrison.owner_id,
      owner_name: ownerName,
      fighters: garrison.fighters,
      mode: garrison.mode,
      toll_amount: garrison.toll_amount ?? 0,
      toll_balance: garrison.toll_balance ?? 0,
      is_friendly: isFriendly,
    };
  }

  return convertBigInts({
    id: sectorId,
    region: row.region ?? null,
    adjacent_sectors: adjacent,
    position: [row.position_x ?? 0, row.position_y ?? 0],
    port,
    players,
    garrison: garrisonObject,
    salvage: row.salvage && Array.isArray(row.salvage) ? row.salvage : [],
    unowned_ships: unownedShips,
    scene_config: null,
  });
}

// ============================================================================
// Status Payload Building
// ============================================================================

let cachedUniverseSize: number | null = null;

async function pgLoadUniverseSize(pg: Client): Promise<number> {
  if (cachedUniverseSize !== null) {
    return cachedUniverseSize;
  }
  const result = await pg.queryObject<{ sector_count: number }>(
    `SELECT sector_count::int
    FROM universe_config
    WHERE id = 1`,
    [],
  );
  cachedUniverseSize = result.rows[0]?.sector_count ?? 0;
  return cachedUniverseSize;
}

function buildPlayerSnapshot(
  character: CharacterRow,
  playerType: string,
  knowledge: MapKnowledge,
  universeSize: number,
): Record<string, unknown> {
  // Derive stats from source field
  let sectorsVisited = 0;
  let corpSectorsVisited = 0;
  let hasCorpKnowledge = false;

  for (const entry of Object.values(knowledge.sectors_visited)) {
    if (entry.source === "player" || entry.source === "both") {
      sectorsVisited++;
    }
    if (entry.source === "corp" || entry.source === "both") {
      corpSectorsVisited++;
      hasCorpKnowledge = true;
    }
  }

  const totalSectorsKnown = Object.keys(knowledge.sectors_visited).length;

  return {
    id: character.character_id,
    name: character.name,
    player_type: playerType,
    credits_in_bank: character.credits_in_megabank ?? 0,
    sectors_visited: sectorsVisited,
    corp_sectors_visited: hasCorpKnowledge ? corpSectorsVisited : null,
    total_sectors_known: totalSectorsKnown,
    universe_size: universeSize,
    created_at: character.first_visit,
    last_active: character.last_active,
  };
}

function buildShipSnapshot(
  ship: ShipRow,
  definition: ShipDefinitionRow,
): Record<string, unknown> {
  const cargo = {
    quantum_foam: ship.cargo_qf ?? 0,
    retro_organics: ship.cargo_ro ?? 0,
    neuro_symbolics: ship.cargo_ns ?? 0,
  };
  const cargoUsed =
    cargo.quantum_foam + cargo.retro_organics + cargo.neuro_symbolics;
  const cargoCapacity = definition.cargo_holds;
  return {
    ship_id: ship.ship_id,
    ship_type: ship.ship_type,
    ship_name: ship.ship_name ?? definition.display_name,
    credits: ship.credits ?? 0,
    cargo,
    cargo_capacity: cargoCapacity,
    empty_holds: Math.max(cargoCapacity - cargoUsed, 0),
    warp_power: ship.current_warp_power ?? definition.warp_power_capacity,
    warp_power_capacity: definition.warp_power_capacity,
    turns_per_warp: definition.turns_per_warp,
    shields: ship.current_shields ?? definition.shields,
    max_shields: definition.shields,
    fighters: ship.current_fighters ?? definition.fighters,
    max_fighters: definition.fighters,
  };
}

export interface PgBuildStatusPayloadOptions {
  pg: Client;
  characterId: string;
  // Optional pre-loaded data to avoid re-fetching
  character?: CharacterRow;
  ship?: ShipRow;
  shipDefinition?: ShipDefinitionRow;
  sectorSnapshot?: SectorSnapshot;
  mapKnowledge?: MapKnowledge;
}

export async function pgBuildStatusPayload(
  pg: Client,
  characterId: string,
  options?: Omit<PgBuildStatusPayloadOptions, "pg" | "characterId">,
): Promise<Record<string, unknown>> {
  const _t0 = performance.now();
  const _spTimings: Record<string, number> = {};
  const _spMark = (label: string) => {
    _spTimings[label] = Math.round(performance.now() - _t0);
  };

  // Use provided data or fetch if not provided
  const character =
    options?.character ?? (await pgLoadCharacter(pg, characterId));
  _spMark("character");
  const ship =
    options?.ship ?? (await pgLoadShip(pg, character.current_ship_id));
  _spMark("ship");
  const definition =
    options?.shipDefinition ?? (await pgLoadShipDefinition(pg, ship.ship_type));
  _spMark("definition");
  // Load merged knowledge (with source field set on each entry)
  const knowledge =
    options?.mapKnowledge ?? (await pgLoadMapKnowledge(pg, characterId));
  _spMark("knowledge");
  const universeSize = await pgLoadUniverseSize(pg);
  _spMark("universe_size");
  const playerType = resolvePlayerType(character.player_metadata);
  const player = buildPlayerSnapshot(
    character,
    playerType,
    knowledge,
    universeSize,
  );
  const shipSnapshot = buildShipSnapshot(ship, definition);
  const sectorSnapshot =
    options?.sectorSnapshot ??
    (await pgBuildSectorSnapshot(pg, ship.current_sector ?? 0, characterId));
  _spMark("sector_snapshot");

  // Load corporation info with member count in a single query
  let corporationPayload: Record<string, unknown> | null = null;
  if (character.corporation_id) {
    const corpResult = await pg.queryObject<{
      corp_id: string;
      name: string;
      member_count: number;
    }>(
      `SELECT c.corp_id, c.name, COUNT(cm.character_id)::int as member_count
      FROM corporations c
      LEFT JOIN corporation_members cm ON cm.corp_id = c.corp_id AND cm.left_at IS NULL
      WHERE c.corp_id = $1
      GROUP BY c.corp_id, c.name`,
      [character.corporation_id],
    );
    const corp = corpResult.rows[0];
    if (corp) {
      corporationPayload = {
        corp_id: corp.corp_id,
        name: corp.name,
        member_count: corp.member_count ?? 0,
        joined_at: character.corporation_joined_at,
      };
    }
  }
  _spMark("corporation");

  console.log("pgBuildStatusPayload.trace", {
    preloaded: {
      character: !!options?.character,
      ship: !!options?.ship,
      definition: !!options?.shipDefinition,
      knowledge: !!options?.mapKnowledge,
      sector: !!options?.sectorSnapshot,
    },
    ..._spTimings,
  });

  return convertBigInts({
    player,
    ship: shipSnapshot,
    sector: sectorSnapshot,
    corporation: corporationPayload,
  });
}

// ============================================================================
// Local Map Building
// ============================================================================

interface UniverseRow {
  sector_id: number;
  position_x: number;
  position_y: number;
  region: string | null;
  warps: unknown;
}

async function pgFetchUniverseRows(
  pg: Client,
  sectorIds: number[],
): Promise<
  Map<
    number,
    { position: [number, number]; region: string | null; warps: WarpEdge[] }
  >
> {
  if (sectorIds.length === 0) {
    return new Map();
  }
  const uniqueIds = Array.from(new Set(sectorIds));
  const result = await pg.queryObject<UniverseRow>(
    `SELECT sector_id::int, position_x::int, position_y::int, region, warps
    FROM universe_structure
    WHERE sector_id = ANY($1::int[])`,
    [uniqueIds],
  );

  const map = new Map<
    number,
    { position: [number, number]; region: string | null; warps: WarpEdge[] }
  >();
  for (const row of result.rows) {
    map.set(row.sector_id, {
      position: [row.position_x ?? 0, row.position_y ?? 0],
      region: row.region ?? null,
      warps: parseWarpEdges(row.warps),
    });
  }
  return map;
}

async function pgLoadPortCodes(
  pg: Client,
  sectorIds: number[],
): Promise<Record<number, string>> {
  if (sectorIds.length === 0) {
    return {};
  }
  const uniqueIds = Array.from(new Set(sectorIds));
  const result = await pg.queryObject<{ sector_id: number; port_code: string }>(
    `SELECT sector_id::int, port_code
    FROM ports
    WHERE sector_id = ANY($1::int[])`,
    [uniqueIds],
  );

  const portCodes: Record<number, string> = {};
  for (const row of result.rows) {
    portCodes[row.sector_id] = row.port_code;
  }
  return portCodes;
}

async function pgLoadSectorGarrisons(
  pg: Client,
  sectorIds: number[],
): Promise<Record<number, LocalMapSectorGarrison>> {
  if (sectorIds.length === 0) {
    return {};
  }

  const uniqueIds = Array.from(new Set(sectorIds));
  const result = await pg.queryObject<{
    sector_id: number;
    player_id: string;
    corporation_id: string | null;
    garrison_count: number;
  }>(
    `WITH ranked AS (
      SELECT
        g.sector_id::int AS sector_id,
        g.owner_id::text AS player_id,
        c.corporation_id::text AS corporation_id,
        COUNT(*) OVER (PARTITION BY g.sector_id) AS garrison_count,
        ROW_NUMBER() OVER (
          PARTITION BY g.sector_id
          ORDER BY g.updated_at DESC NULLS LAST, g.deployed_at DESC NULLS LAST, g.owner_id ASC
        ) AS row_num
      FROM garrisons g
      LEFT JOIN characters c ON c.character_id = g.owner_id
      WHERE g.sector_id = ANY($1::int[])
    )
    SELECT sector_id, player_id, corporation_id, garrison_count::int
    FROM ranked
    WHERE row_num = 1`,
    [uniqueIds],
  );

  const garrisonBySector: Record<number, LocalMapSectorGarrison> = {};
  const duplicateSectors: number[] = [];
  for (const row of result.rows) {
    if (row.garrison_count > 1) {
      duplicateSectors.push(row.sector_id);
    }
    garrisonBySector[row.sector_id] = {
      player_id: row.player_id,
      corporation_id: row.corporation_id ?? null,
    };
  }
  if (duplicateSectors.length > 0) {
    console.warn("pgLoadSectorGarrisons.multiple_garrisons", {
      sector_ids: Array.from(new Set(duplicateSectors)).sort((a, b) => a - b),
    });
  }
  return garrisonBySector;
}

interface LocalMapSector {
  id: number;
  visited: boolean;
  hops_from_center: number;
  position: [number, number];
  region?: string | null;
  port: { code: string; mega?: boolean } | null;
  lanes: WarpEdge[];
  adjacent_sectors: number[];
  last_visited?: string;
  source?: "player" | "corp" | "both";
  garrison?: LocalMapSectorGarrison | null;
}

interface LocalMapRegionPayload {
  center_sector: number;
  sectors: LocalMapSector[];
  total_sectors: number;
  total_visited: number;
  total_unvisited: number;
}

function buildLocalMapPort(
  portValue: Record<string, unknown> | null | undefined,
  fallbackCode?: string,
  fallbackMega?: boolean,
): { code: string; mega?: boolean } | null {
  const portCode =
    (portValue && typeof portValue.code === "string" ? portValue.code : null) ??
    (portValue && typeof portValue.port_code === "string"
      ? portValue.port_code
      : null) ??
    (fallbackCode && fallbackCode.trim().length > 0 ? fallbackCode : null);
  if (!portCode) {
    return null;
  }
  const mega =
    portValue && typeof portValue.mega === "boolean"
      ? portValue.mega
      : fallbackMega;
  return mega === undefined ? { code: portCode } : { code: portCode, mega };
}

function extractPortCodeValue(
  portValue: Record<string, unknown> | null | undefined,
): string | null {
  if (!portValue) {
    return null;
  }
  const code =
    typeof portValue.code === "string"
      ? portValue.code
      : typeof portValue.port_code === "string"
        ? portValue.port_code
        : null;
  if (!code || !code.trim()) {
    return null;
  }
  return code;
}

export async function pgBuildLocalMapRegion(
  pg: Client,
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

  const _t0 = performance.now();
  const _lmrTimings: Record<string, number> = {};
  const _lmrMark = (label: string) => {
    _lmrTimings[label] = Math.round(performance.now() - _t0);
  };

  let knowledge = params.mapKnowledge;
  if (!knowledge) {
    knowledge = await pgLoadMapKnowledge(pg, characterId);
    _lmrMark("load_knowledge");
  }

  // Phase 1: Synchronous BFS using knowledge adjacency data (0 queries)
  const bfs = runBFS(centerSector, maxHops, maxSectors, knowledge);
  _lmrMark("bfs");
  const { distanceMap, unvisitedFrontier, unvisitedSeenFrom } = bfs;

  const visitedSet = new Set<number>(
    Object.keys(knowledge.sectors_visited).map((key) => Number(key)),
  );
  visitedSet.add(centerSector);

  // Phase 2: Handle missing adjacency (rare — fetch + re-expand)
  if (bfs.missingAdjacency.length > 0) {
    const rows = await pgFetchUniverseRows(pg, bfs.missingAdjacency);
    for (const sectorId of bfs.missingAdjacency) {
      const row = rows.get(sectorId);
      if (!row) continue;
      const neighbors = row.warps.map((e) => e.to);
      for (const neighbor of neighbors) {
        if (!distanceMap.has(neighbor)) {
          distanceMap.set(neighbor, (distanceMap.get(sectorId) ?? 0) + 1);
        }
        if (!visitedSet.has(neighbor)) {
          unvisitedFrontier.add(neighbor);
          let seenFrom = unvisitedSeenFrom.get(neighbor);
          if (!seenFrom) {
            seenFrom = new Set();
            unvisitedSeenFrom.set(neighbor, seenFrom);
          }
          seenFrom.add(sectorId);
        }
      }
    }
  }

  // Phase 3: Find disconnected sectors (0 queries — knowledge positions only)
  const disconnectedSectors = findDisconnectedSectors(distanceMap, knowledge);
  const disconnectedSet = new Set(disconnectedSectors);

  // Discover unvisited neighbors of disconnected sectors from knowledge
  const disconnectedUnvisitedNeighbors = new Set<number>();
  for (const sectorId of disconnectedSectors) {
    const entry = knowledge.sectors_visited[String(sectorId)];
    const neighbors = entry?.adjacent_sectors ?? [];
    for (const neighbor of neighbors) {
      if (visitedSet.has(neighbor)) continue;
      disconnectedUnvisitedNeighbors.add(neighbor);
      unvisitedFrontier.add(neighbor);
      let seenFrom = unvisitedSeenFrom.get(neighbor);
      if (!seenFrom) {
        seenFrom = new Set();
        unvisitedSeenFrom.set(neighbor, seenFrom);
      }
      seenFrom.add(sectorId);
    }
  }

  // Phase 4: Batch-fetch all needed data in parallel (1 round trip)
  const allSectorIds = [
    ...distanceMap.keys(),
    ...disconnectedSectors,
    ...disconnectedUnvisitedNeighbors,
  ];
  const visitedSectorIds = allSectorIds.filter((id) => visitedSet.has(id));

  // Check which data we need
  let needsPortCodes = false;
  let needsUniverseMeta = false;
  for (const sectorId of visitedSectorIds) {
    const knowledgeEntry = knowledge.sectors_visited[String(sectorId)];
    const portValue = knowledgeEntry?.port as
      | Record<string, unknown>
      | null
      | undefined;
    const portCode = extractPortCodeValue(portValue);
    if (!portCode) {
      needsPortCodes = true;
      needsUniverseMeta = true;
      continue;
    }
    if (typeof portValue?.mega !== "boolean") {
      needsUniverseMeta = true;
    }
  }

  _lmrMark("pre_batch");

  const [universeRowMap, portCodes, universeMeta, garrisonsBySector] =
    await Promise.all([
      pgFetchUniverseRows(pg, allSectorIds),
      needsPortCodes
        ? pgLoadPortCodes(pg, visitedSectorIds)
        : Promise.resolve({}),
      needsUniverseMeta ? pgLoadUniverseMeta(pg) : Promise.resolve(null),
      pgLoadSectorGarrisons(pg, visitedSectorIds),
    ]);
  _lmrMark("batch_fetch");

  // Build adjacency lookup from knowledge + universe data
  const adjacencyCache = new Map<number, number[]>();
  for (const sectorId of allSectorIds) {
    const knowledgeEntry = knowledge.sectors_visited[String(sectorId)];
    if (knowledgeEntry?.adjacent_sectors) {
      adjacencyCache.set(sectorId, knowledgeEntry.adjacent_sectors);
    } else {
      const row = universeRowMap.get(sectorId);
      adjacencyCache.set(sectorId, row?.warps.map((e) => e.to) ?? []);
    }
  }

  // Phase 5: Build output (0 queries)
  const resultSectors: LocalMapSector[] = [];
  for (const sectorId of allSectorIds.sort((a, b) => a - b)) {
    const isDisconnected = disconnectedSet.has(sectorId);
    const hops = isDisconnected
      ? -1
      : disconnectedUnvisitedNeighbors.has(sectorId)
        ? -1
        : (distanceMap.get(sectorId) ?? 0);
    const universeRow = universeRowMap.get(sectorId);
    const position = universeRow?.position ?? [0, 0];
    const warps = universeRow?.warps ?? [];

    if (visitedSet.has(sectorId)) {
      const knowledgeEntry = knowledge.sectors_visited[String(sectorId)];
      const portValue = knowledgeEntry?.port as
        | Record<string, unknown>
        | null
        | undefined;
      const portCodeFromKnowledge = extractPortCodeValue(portValue);
      const fallbackCode = portCodes[sectorId];
      const hasPort = Boolean(fallbackCode || portCodeFromKnowledge);
      const mega = hasPort
        ? universeMeta
          ? pgIsMegaPortSector(universeMeta, sectorId)
          : undefined
        : undefined;
      const portPayload = buildLocalMapPort(portValue, fallbackCode, mega);
      resultSectors.push({
        id: sectorId,
        visited: true,
        hops_from_center: hops,
        position,
        region: universeRow?.region ?? null,
        port: portPayload,
        lanes: warps,
        adjacent_sectors: adjacencyCache.get(sectorId) ?? [],
        last_visited: knowledgeEntry?.last_visited,
        source: knowledgeEntry?.source,
        garrison: garrisonsBySector[sectorId] ?? null,
      });
    } else {
      const seenFrom = Array.from(unvisitedSeenFrom.get(sectorId) ?? []);
      const derivedLanes: WarpEdge[] = [];
      for (const source of seenFrom) {
        const sourceRow = universeRowMap.get(source);
        const match = sourceRow?.warps.find((warp) => warp.to === sectorId);
        if (match) {
          derivedLanes.push({
            to: source,
            two_way: match.two_way,
            hyperlane: match.hyperlane,
          });
        } else {
          derivedLanes.push({ to: source });
        }
      }
      resultSectors.push({
        id: sectorId,
        visited: false,
        hops_from_center: hops,
        position,
        port: null,
        lanes: derivedLanes,
        adjacent_sectors: [],
      });
    }
  }

  const totalVisited = resultSectors.filter((sector) => sector.visited).length;
  const totalUnvisited = resultSectors.length - totalVisited;

  _lmrMark("build_output");
  console.log("pgBuildLocalMapRegion.trace", {
    center: centerSector,
    maxHops,
    sectors: resultSectors.length,
    allSectorIds: allSectorIds.length,
    ..._lmrTimings,
  });

  return convertBigInts({
    center_sector: centerSector,
    sectors: resultSectors,
    total_sectors: resultSectors.length,
    total_visited: totalVisited,
    total_unvisited: totalUnvisited,
  });
}

// ============================================================================
// Mark Sector Visited
// ============================================================================

function upsertVisitedSector(
  knowledge: MapKnowledge,
  sectorId: number,
  adjacent: number[],
  position: [number, number],
  timestamp: string,
): { updated: boolean; knowledge: MapKnowledge } {
  const key = String(sectorId);
  const existing = knowledge.sectors_visited[key];
  const sameAdjacency =
    existing?.adjacent_sectors?.length === adjacent.length &&
    existing.adjacent_sectors?.every((value, idx) => value === adjacent[idx]);
  const sameTimestamp = existing?.last_visited === timestamp;

  if (existing && sameAdjacency && sameTimestamp) {
    return { updated: false, knowledge };
  }

  knowledge.sectors_visited[key] = {
    adjacent_sectors: adjacent,
    position,
    last_visited: timestamp,
  };
  const total = Object.keys(knowledge.sectors_visited).length;
  knowledge.total_sectors_visited = Math.max(
    knowledge.total_sectors_visited,
    total,
  );
  return { updated: true, knowledge };
}

export interface MarkSectorVisitedResult {
  firstPersonalVisit: boolean;
  knownToCorp: boolean;
  knowledge: MapKnowledge;
}

export async function pgMarkSectorVisited(
  pg: Client,
  params: {
    characterId: string;
    sectorId: number;
    sectorSnapshot: SectorSnapshot;
    // Optional pre-loaded data to skip the character query entirely.
    // When all three are provided, no SELECT is needed — only the UPDATE.
    playerMetadata?: Record<string, unknown> | null;
    corporationId?: string | null;
    knowledgeComponents?: { personal: MapKnowledge; corp: MapKnowledge | null };
  },
): Promise<MarkSectorVisitedResult> {
  const { characterId, sectorId, sectorSnapshot } = params;
  const sectorKey = String(sectorId);
  const timestamp = new Date().toISOString();

  let playerMetadata: Record<string, unknown> | null;
  let corpId: string | null;
  let personalKnowledge: MapKnowledge;
  let corpKnowledge: MapKnowledge | null;

  if (
    params.playerMetadata !== undefined &&
    params.corporationId !== undefined &&
    params.knowledgeComponents !== undefined
  ) {
    // All pre-loaded data provided — skip character query
    playerMetadata = params.playerMetadata;
    corpId = params.corporationId;
    personalKnowledge = params.knowledgeComponents.personal;
    corpKnowledge = params.knowledgeComponents.corp;
  } else {
    // Load character info with player_metadata, corporation_id, and both knowledge sources
    const charResult = await pg.queryObject<{
      player_metadata: Record<string, unknown> | null;
      corporation_id: string | null;
      map_knowledge: unknown;
      corp_map_knowledge: unknown | null;
    }>(
      `SELECT
        c.player_metadata,
        c.corporation_id,
        c.map_knowledge,
        cmk.map_knowledge as corp_map_knowledge
      FROM characters c
      LEFT JOIN corporation_map_knowledge cmk ON cmk.corp_id = c.corporation_id
      WHERE c.character_id = $1`,
      [characterId],
    );

    const charRow = charResult.rows[0];
    if (!charRow) {
      throw new Error(`character ${characterId} not found`);
    }
    playerMetadata = charRow.player_metadata;
    corpId = charRow.corporation_id;
    personalKnowledge = normalizeMapKnowledge(charRow.map_knowledge);
    corpKnowledge = charRow.corp_map_knowledge
      ? normalizeMapKnowledge(charRow.corp_map_knowledge)
      : null;
  }

  const playerType = resolvePlayerType(playerMetadata);
  const isCorporationShip = playerType === "corporation_ship";

  // Corporation ship: update corp knowledge only
  if (isCorporationShip) {
    if (!corpId) {
      // Corp ship without corporation (shouldn't happen, but handle gracefully)
      console.warn(
        `Corp ship ${characterId} has no corporation_id, skipping knowledge update`,
      );
      const emptyKnowledge = normalizeMapKnowledge(null);
      return {
        firstPersonalVisit: false,
        knownToCorp: false,
        knowledge: emptyKnowledge,
      };
    }

    const result = await pgUpsertCorporationSectorKnowledge(pg, {
      corpId,
      sectorId,
      sectorSnapshot,
    });

    // Merge personal + updated corp knowledge for the return value
    const mergedKnowledge = mergeMapKnowledge(
      personalKnowledge,
      result.knowledge,
    );
    return {
      firstPersonalVisit: result.firstVisit, // First time corp learned this sector
      knownToCorp: false, // N/A for corp ships
      knowledge: mergedKnowledge,
    };
  }

  // Human player: update personal knowledge

  // Check if corp already knew about this sector BEFORE we update personal knowledge
  const knownToCorp = corpKnowledge
    ? Boolean(corpKnowledge.sectors_visited[sectorKey])
    : false;

  const visitedBefore = Boolean(personalKnowledge.sectors_visited[sectorKey]);

  const { knowledge: nextKnowledge } = upsertVisitedSector(
    personalKnowledge,
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

  await pgUpdateMapKnowledge(pg, characterId, nextKnowledge);

  // Return merged knowledge (personal + corp) to avoid a separate pgLoadMapKnowledge call
  const mergedKnowledge = corpKnowledge
    ? mergeMapKnowledge(nextKnowledge, corpKnowledge)
    : setPlayerSource(nextKnowledge);

  return {
    firstPersonalVisit: !visitedBefore,
    knownToCorp,
    knowledge: mergedKnowledge,
  };
}

// ============================================================================
// Direct PG Event Recording
// ============================================================================

export interface EventRecipientSnapshot {
  characterId: string;
  reason: string;
}

export interface PgRecordEventOptions {
  pg: Client;
  eventType: string;
  scope?: string;
  direction?: string;
  payload: Record<string, unknown>;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  sectorId?: number | null;
  shipId?: string | null;
  characterId?: string | null;
  senderId?: string | null;
  actorCharacterId?: string | null;
  corpId?: string | null;
  taskId?: string | null;
  recipients?: EventRecipientSnapshot[];
  broadcast?: boolean;
}

function dedupeRecipients(
  recipients: EventRecipientSnapshot[],
): EventRecipientSnapshot[] {
  if (!recipients.length) return [];
  const seen = new Set<string>();
  const deduped: EventRecipientSnapshot[] = [];
  for (const r of recipients) {
    const id = typeof r.characterId === "string" ? r.characterId.trim() : "";
    const reason = typeof r.reason === "string" ? r.reason.trim() : "";
    if (!id || !reason || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ characterId: id, reason });
  }
  return deduped;
}

export async function pgRecordEvent(
  options: PgRecordEventOptions,
): Promise<number | null> {
  const _t0 = performance.now();
  const {
    pg,
    eventType,
    scope = "direct",
    direction = "event_out",
    payload,
    requestId,
    meta,
    sectorId,
    shipId,
    characterId,
    senderId,
    actorCharacterId,
    corpId,
    taskId,
    recipients = [],
    broadcast = false,
  } = options;

  const normalizedRecipients = dedupeRecipients(recipients);
  if (!normalizedRecipients.length && !broadcast) {
    return null;
  }

  const recipientIds = normalizedRecipients.map((r) => r.characterId);
  const recipientReasons = normalizedRecipients.map((r) => r.reason);

  const result = await pg.queryObject<{ record_event_with_recipients: string }>(
    `SELECT record_event_with_recipients(
      $1, $2, $3, $4::uuid, $5::uuid, $6::int, $7::uuid, $8::uuid, $9::uuid,
      $10::jsonb, $11::jsonb, $12, $13::uuid[], $14::text[], $15, $16::uuid
    )`,
    [
      eventType,
      direction,
      scope,
      actorCharacterId ?? null,
      corpId ?? null,
      sectorId ?? null,
      shipId ?? null,
      characterId ?? null,
      senderId ?? null,
      JSON.stringify(payload ?? {}),
      meta ? JSON.stringify(meta) : null,
      requestId ?? null,
      recipientIds,
      recipientReasons,
      broadcast,
      taskId ?? null,
    ],
  );

  const _ms = Math.round(performance.now() - _t0);
  if (_ms > 50) {
    console.log("pgRecordEvent.slow", { eventType, ms: _ms, recipients: normalizedRecipients.length });
  }

  const returnVal = result.rows[0]?.record_event_with_recipients;
  if (typeof returnVal === "string") {
    return parseInt(returnVal, 10);
  }
  if (typeof returnVal === "number" || typeof returnVal === "bigint") {
    return Number(returnVal);
  }
  return null;
}

export interface PgEmitCharacterEventOptions {
  pg: Client;
  characterId: string;
  eventType: string;
  payload: Record<string, unknown>;
  senderId?: string | null;
  sectorId?: number | null;
  shipId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  corpId?: string | null;
  taskId?: string | null;
  recipientReason?: string;
  additionalRecipients?: EventRecipientSnapshot[];
  actorCharacterId?: string | null;
  scope?: string;
}

export async function pgEmitCharacterEvent(
  options: PgEmitCharacterEventOptions,
): Promise<void> {
  const {
    pg,
    characterId,
    eventType,
    payload,
    senderId,
    sectorId,
    shipId,
    requestId,
    meta,
    corpId,
    taskId,
    recipientReason,
    additionalRecipients = [],
    actorCharacterId,
    scope,
  } = options;

  const recipients = dedupeRecipients([
    { characterId, reason: recipientReason ?? "direct" },
    ...additionalRecipients,
  ]);

  if (!recipients.length) return;

  const finalPayload = injectCharacterEventIdentity({
    payload,
    characterId,
    shipId,
    eventType,
  });

  await pgRecordEvent({
    pg,
    eventType,
    scope: scope ?? "direct",
    payload: finalPayload,
    requestId,
    meta,
    corpId,
    taskId,
    sectorId,
    shipId,
    characterId,
    senderId,
    actorCharacterId: actorCharacterId ?? senderId ?? characterId,
    recipients,
  });
}

// ============================================================================
// Movement Observers (direct PG)
// ============================================================================

export interface ObserverMetadata {
  characterId: string;
  characterName: string;
  shipId: string;
  shipName: string;
  shipType: string;
  corpId?: string | null;
}

interface EventSource {
  type: string;
  method: string;
  request_id: string;
  timestamp: string;
}

async function pgListSectorObservers(
  pg: Client,
  sectorId: number,
  exclude: string[] = [],
): Promise<string[]> {
  const excludeSet = new Set(exclude);
  const result = await pg.queryObject<{
    owner_character_id: string | null;
    owner_id: string | null;
    owner_type: string | null;
  }>(
    `SELECT owner_character_id, owner_id, owner_type
    FROM ship_instances
    WHERE current_sector = $1
      AND in_hyperspace = false
      AND destroyed_at IS NULL
      AND (owner_character_id IS NOT NULL OR owner_type = 'character')`,
    [sectorId],
  );

  const observers: string[] = [];
  for (const row of result.rows) {
    const charId =
      row.owner_character_id ??
      (row.owner_type === "character" ? row.owner_id : null);
    if (!charId || excludeSet.has(charId)) continue;
    if (!observers.includes(charId)) {
      observers.push(charId);
    }
  }
  return observers;
}

interface GarrisonRow {
  owner_id: string | null;
  fighters: number;
  mode: string;
  toll_amount: number;
  deployed_at: string;
}

interface CharacterInfo {
  character_id: string;
  name: string;
  corporation_id: string | null;
}

interface GarrisonContext {
  garrisons: GarrisonRow[];
  ownerMap: Map<string, CharacterInfo>;
  membersByCorp: Map<string, string[]>;
}

async function pgLoadGarrisonContext(
  pg: Client,
  sectorId: number,
): Promise<GarrisonContext> {
  const garrisonResult = await pg.queryObject<GarrisonRow>(
    `SELECT owner_id, fighters::int, mode, toll_amount::numeric, deployed_at
    FROM garrisons
    WHERE sector_id = $1`,
    [sectorId],
  );

  const garrisonRows = garrisonResult.rows;
  const ownerIds = Array.from(
    new Set(
      garrisonRows
        .map((row) => row.owner_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  const ownerMap = new Map<string, CharacterInfo>();
  const corpIds = new Set<string>();

  if (ownerIds.length > 0) {
    const ownerResult = await pg.queryObject<CharacterInfo>(
      `SELECT character_id, name, corporation_id
      FROM characters
      WHERE character_id = ANY($1::uuid[])`,
      [ownerIds],
    );
    for (const row of ownerResult.rows) {
      ownerMap.set(row.character_id, row);
      if (row.corporation_id) {
        corpIds.add(row.corporation_id);
      }
    }
  }

  const membersByCorp = new Map<string, string[]>();
  if (corpIds.size > 0) {
    const corpIdList = Array.from(corpIds);
    const memberResult = await pg.queryObject<{
      character_id: string;
      corporation_id: string | null;
    }>(
      `SELECT character_id, corporation_id
      FROM characters
      WHERE corporation_id = ANY($1::uuid[])`,
      [corpIdList],
    );
    for (const row of memberResult.rows) {
      if (!row.corporation_id) continue;
      const list = membersByCorp.get(row.corporation_id) ?? [];
      list.push(row.character_id);
      membersByCorp.set(row.corporation_id, list);
    }
  }

  return { garrisons: convertBigInts(garrisonRows), ownerMap, membersByCorp };
}

function buildCharacterMovedPayload(
  metadata: ObserverMetadata,
  movement: "depart" | "arrive",
  source?: EventSource,
  options?: { moveType?: string; extraFields?: Record<string, unknown> },
): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const moveType = options?.moveType ?? "normal";
  const extraFields = options?.extraFields;
  const payload: Record<string, unknown> = {
    player: { id: metadata.characterId, name: metadata.characterName },
    ship: {
      ship_id: metadata.shipId,
      ship_name: metadata.shipName,
      ship_type: metadata.shipType,
    },
    timestamp,
    move_type: moveType,
    movement,
    name: metadata.characterName,
  };
  if (source) payload.source = source;
  if (extraFields && Object.keys(extraFields).length) {
    Object.assign(payload, extraFields);
  }
  return payload;
}

export interface PgMovementObserverOptions {
  pg: Client;
  sectorId: number;
  metadata: ObserverMetadata;
  movement: "depart" | "arrive";
  source?: EventSource;
  requestId?: string;
  excludeCharacterIds?: string[];
  moveType?: string;
  extraPayload?: Record<string, unknown>;
  includeGarrisons?: boolean;
  /** Corp IDs whose members should receive this event (for arrival events) */
  corpIds?: string[];
}

export interface MovementObserverResult {
  characterObservers: number;
  garrisonRecipients: number;
  corpMemberRecipients: number;
}

/**
 * Compute corp member recipients for event visibility.
 */
export async function pgComputeCorpMemberRecipients(
  pg: Client,
  corpIds: string[],
  excludeCharacterIds: string[] = [],
): Promise<EventRecipientSnapshot[]> {
  if (!corpIds.length) {
    return [];
  }
  const excludeSet = new Set(excludeCharacterIds);
  const uniqueCorpIds = Array.from(new Set(corpIds));

  const result = await pg.queryObject<{
    character_id: string;
    corp_id: string;
  }>(
    `SELECT character_id, corp_id
    FROM corporation_members
    WHERE corp_id = ANY($1::uuid[])
      AND left_at IS NULL`,
    [uniqueCorpIds],
  );

  const recipients: EventRecipientSnapshot[] = [];
  for (const row of result.rows) {
    const memberId = row?.character_id;
    if (!memberId || excludeSet.has(memberId)) {
      continue;
    }
    recipients.push({ characterId: memberId, reason: "corp_member" });
  }

  return dedupeRecipients(recipients);
}

export async function pgEmitMovementObservers(
  options: PgMovementObserverOptions,
): Promise<MovementObserverResult> {
  const _t0 = performance.now();
  const {
    pg,
    sectorId,
    metadata,
    movement,
    source,
    requestId,
    excludeCharacterIds,
    moveType,
    extraPayload,
    includeGarrisons = true,
    corpIds = [],
  } = options;

  const exclude = new Set<string>([metadata.characterId]);
  if (excludeCharacterIds) {
    for (const id of excludeCharacterIds) {
      if (id) exclude.add(id);
    }
  }

  const observers = await pgListSectorObservers(
    pg,
    sectorId,
    Array.from(exclude),
  );
  const payload = buildCharacterMovedPayload(metadata, movement, source, {
    moveType,
    extraFields: { sector: sectorId, ...(extraPayload ?? {}) },
  });

  // Get corp member recipients if corpIds provided (for arrival events)
  let corpMemberRecipients: EventRecipientSnapshot[] = [];
  if (corpIds.length > 0) {
    corpMemberRecipients = await pgComputeCorpMemberRecipients(
      pg,
      corpIds,
      Array.from(exclude),
    );
  }

  // Combine sector observers + corp members for character.moved event
  const allRecipients = dedupeRecipients([
    ...observers.map((id) => ({ characterId: id, reason: "sector_snapshot" })),
    ...corpMemberRecipients,
  ]);

  // Emit to character observers + corp members
  if (allRecipients.length > 0) {
    await pgRecordEvent({
      pg,
      eventType: "character.moved",
      scope: "sector",
      payload,
      requestId,
      sectorId,
      actorCharacterId: metadata.characterId,
      corpId: metadata.corpId ?? null,
      recipients: allRecipients,
    });
  }

  // Emit to garrison owners and corp members
  let garrisonRecipients = 0;
  if (includeGarrisons) {
    const { garrisons, ownerMap, membersByCorp } = await pgLoadGarrisonContext(
      pg,
      sectorId,
    );

    for (const garrison of garrisons) {
      const ownerId = garrison.owner_id;
      if (!ownerId) continue;

      const owner = ownerMap.get(ownerId);
      if (!owner) continue;

      const corpMembers = owner.corporation_id
        ? (membersByCorp.get(owner.corporation_id) ?? [])
        : [];
      const allGarrisonRecipients = Array.from(
        new Set([ownerId, ...corpMembers]),
      );
      if (!allGarrisonRecipients.length) continue;

      const garrisonPayload = {
        owner_id: owner.character_id,
        owner_name: owner.name,
        corporation_id: owner.corporation_id,
        fighters: garrison.fighters,
        mode: garrison.mode,
        toll_amount: garrison.toll_amount,
        deployed_at: garrison.deployed_at,
      };

      const eventPayload = { ...payload, garrison: garrisonPayload };
      const recipientSnapshots = dedupeRecipients(
        allGarrisonRecipients.map((charId) => ({
          characterId: charId,
          reason:
            charId === owner.character_id
              ? "garrison_owner"
              : "garrison_corp_member",
        })),
      );

      if (recipientSnapshots.length > 0) {
        await pgRecordEvent({
          pg,
          eventType: "garrison.character_moved",
          scope: "sector",
          payload: eventPayload,
          requestId,
          sectorId,
          actorCharacterId: owner.character_id,
          corpId: owner.corporation_id ?? null,
          recipients: recipientSnapshots,
        });
        garrisonRecipients += allGarrisonRecipients.length;
      }
    }
  }

  const corpMemberCount = corpMemberRecipients.length;
  const _ms = Math.round(performance.now() - _t0);
  console.log("pgEmitMovementObservers.trace", {
    sector_id: sectorId,
    movement,
    character_observers: observers.length,
    garrison_recipients: garrisonRecipients,
    corp_member_recipients: corpMemberCount,
    ms: _ms,
  });

  return {
    characterObservers: observers.length,
    garrisonRecipients,
    corpMemberRecipients: corpMemberCount,
  };
}

// ============================================================================
// Garrison Auto-Combat Check (direct PG)
// ============================================================================

interface GarrisonAutoEngageRow {
  sector_id: number;
  owner_id: string;
  fighters: number;
  mode: string;
  toll_amount: number;
  toll_balance: number;
  deployed_at: string;
}

export interface PgCheckGarrisonAutoEngageOptions {
  pg: Client;
  characterId: string;
  sectorId: number;
  requestId: string;
  /** Pre-loaded character — skips character query when provided */
  character?: { current_ship_id: string; corporation_id: string | null };
  /** Pre-loaded ship — skips ship hyperspace query when provided */
  ship?: { in_hyperspace: boolean };
}

/**
 * Check if there are auto-engaging garrisons in a sector.
 * Returns true if combat would be initiated (caller should handle via REST),
 * false if no combat needed.
 *
 * This is an optimized check - it quickly returns false for the common case
 * where no combat is needed, avoiding expensive REST calls.
 */
export async function pgCheckGarrisonAutoEngage(
  options: PgCheckGarrisonAutoEngageOptions,
): Promise<boolean> {
  const _t0 = performance.now();
  const _logGarrison = (reason: string, result: boolean) => {
    console.log("pgCheckGarrisonAutoEngage.trace", {
      reason,
      result,
      preloaded: { character: !!options.character, ship: !!options.ship },
      ms: Math.round(performance.now() - _t0),
    });
    return result;
  };

  const { pg, characterId, sectorId, character, ship } = options;
  const meta = await pgLoadUniverseMeta(pg);
  if (await pgIsFedspaceSector(pg, sectorId, meta)) {
    return _logGarrison("fedspace", false);
  }

  // Use pre-loaded data when available, otherwise query
  let currentShipId: string;
  if (character) {
    currentShipId = character.current_ship_id;
  } else {
    const charResult = await pg.queryObject<{ current_ship_id: string }>(
      `SELECT current_ship_id FROM characters WHERE character_id = $1`,
      [characterId],
    );
    const charRow = charResult.rows[0];
    if (!charRow?.current_ship_id) return _logGarrison("no_ship", false);
    currentShipId = charRow.current_ship_id;
  }

  if (ship) {
    if (ship.in_hyperspace) return _logGarrison("in_hyperspace", false);
  } else {
    const shipResult = await pg.queryObject<{ in_hyperspace: boolean }>(
      `SELECT in_hyperspace FROM ship_instances WHERE ship_id = $1`,
      [currentShipId],
    );
    if (shipResult.rows[0]?.in_hyperspace) return _logGarrison("in_hyperspace", false);
  }

  // Fetch combat state and garrisons in a single combined query
  const combatAndGarrisonResult = await pg.queryObject<
    GarrisonAutoEngageRow & { combat: unknown }
  >(
    `SELECT g.sector_id::int, g.owner_id, g.fighters::int, g.mode,
            g.toll_amount::numeric, g.toll_balance::numeric, g.deployed_at,
            sc.combat
    FROM garrisons g
    JOIN sector_contents sc ON sc.sector_id = g.sector_id
    WHERE g.sector_id = $1 AND g.fighters > 0`,
    [sectorId],
  );

  // Check combat state from first row (same for all rows since it's per-sector)
  if (combatAndGarrisonResult.rows.length > 0) {
    const combat = combatAndGarrisonResult.rows[0].combat as Record<
      string,
      unknown
    > | null;
    if (combat && !combat.ended) return _logGarrison("active_combat", false);
  } else {
    // No garrisons with fighters — also need to check combat in case there are 0 garrisons
    const combatResult = await pg.queryObject<{ combat: unknown }>(
      `SELECT combat FROM sector_contents WHERE sector_id = $1`,
      [sectorId],
    );
    const combatRow = combatResult.rows[0];
    if (combatRow?.combat) {
      const combat = combatRow.combat as Record<string, unknown>;
      if (combat && !combat.ended) return _logGarrison("active_combat_no_garrison", false);
    }
    return _logGarrison("no_garrisons", false);
  }

  const garrisons = combatAndGarrisonResult.rows;

  // Check for auto-engaging garrisons (offensive or toll mode)
  const autoEngagingGarrisons = garrisons.filter(
    (g) => g.mode === "offensive" || g.mode === "toll",
  );
  if (autoEngagingGarrisons.length === 0) return _logGarrison("no_auto_engage", false);

  // Use pre-loaded corporation_id when available, otherwise query
  let charCorpId: string | null;
  if (character) {
    charCorpId = character.corporation_id;
  } else {
    const charCorpResult = await pg.queryObject<{ corp_id: string | null }>(
      `SELECT COALESCE(
        (SELECT corp_id FROM corporation_members WHERE character_id = $1 AND left_at IS NULL),
        (SELECT owner_corporation_id FROM ship_instances WHERE ship_id = $2)
      ) as corp_id`,
      [characterId, currentShipId],
    );
    charCorpId = charCorpResult.rows[0]?.corp_id ?? null;
  }

  // Collect unique garrison owner IDs (excluding self and empty)
  const ownerIds = [
    ...new Set(
      autoEngagingGarrisons
        .map((g) => g.owner_id)
        .filter((id): id is string => !!id && id !== characterId),
    ),
  ];
  if (ownerIds.length === 0) return _logGarrison("own_garrisons_only", false);

  // Batch-load all garrison owners' corporations in a single query
  const ownerCorpResult = await pg.queryObject<{
    owner_id: string;
    corp_id: string | null;
  }>(
    `SELECT
      o.id as owner_id,
      COALESCE(cm.corp_id, si.owner_corporation_id) as corp_id
    FROM unnest($1::text[]) AS o(id)
    LEFT JOIN corporation_members cm ON cm.character_id = o.id AND cm.left_at IS NULL
    LEFT JOIN ship_instances si ON si.ship_id = o.id`,
    [ownerIds],
  );
  const ownerCorpMap = new Map(
    ownerCorpResult.rows.map((r) => [r.owner_id, r.corp_id]),
  );

  // Check if any garrison is owned by a different (or no) corporation
  for (const garrison of autoEngagingGarrisons) {
    const ownerId = garrison.owner_id;
    if (!ownerId || ownerId === characterId) continue;
    if (garrison.fighters <= 0) continue;

    const ownerCorpId = ownerCorpMap.get(ownerId) ?? null;

    // Skip if same corporation
    if (charCorpId && ownerCorpId === charCorpId) continue;

    // Found an enemy garrison - combat should be initiated
    return _logGarrison("enemy_garrison", true);
  }

  return _logGarrison("all_friendly", false);
}

// ============================================================================
// Actor Authorization (direct PG)
// ============================================================================

export async function pgEnsureActorAuthorization(
  pg: Client,
  options: {
    ship: ShipRow | null;
    actorCharacterId: string | null;
    adminOverride: boolean;
    targetCharacterId?: string | null;
    requireActorForCorporationShip?: boolean;
  },
): Promise<void> {
  const {
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId,
    requireActorForCorporationShip = true,
  } = options;

  if (adminOverride) {
    return;
  }

  // If no ship provided, only validate actor matches target
  if (!ship) {
    if (
      actorCharacterId &&
      targetCharacterId &&
      actorCharacterId !== targetCharacterId
    ) {
      throw new ActorAuthorizationError(
        "actor_character_id must match character_id unless admin_override is true",
        403,
      );
    }
    return;
  }

  const resolvedTargetId =
    targetCharacterId ??
    ship.owner_character_id ??
    ship.owner_id ??
    ship.ship_id;

  if (ship.owner_type === "corporation") {
    if (requireActorForCorporationShip && !actorCharacterId) {
      throw new ActorAuthorizationError(
        "actor_character_id is required when controlling a corporation ship",
        400,
      );
    }
    if (!ship.owner_corporation_id) {
      throw new ActorAuthorizationError(
        "Corporation ship is missing ownership data",
        403,
      );
    }
    if (!actorCharacterId) {
      return;
    }
    const allowed = await pgEnsureActorCanControlShip(
      pg,
      actorCharacterId,
      ship.owner_corporation_id,
    );
    if (!allowed) {
      throw new ActorAuthorizationError(
        "Actor is not authorized to control this corporation ship",
        403,
      );
    }
    return;
  }

  if (actorCharacterId && actorCharacterId !== resolvedTargetId) {
    throw new ActorAuthorizationError(
      "actor_character_id must match character_id unless admin_override is true",
      403,
    );
  }
}

// Import ActorAuthorizationError - re-export for convenience
export { ActorAuthorizationError } from "./actors.ts";

// ============================================================================
// Trading Functions (direct PG)
// ============================================================================

export interface PortRow {
  port_id: number;
  sector_id: number;
  port_code: string;
  port_class: number;
  max_qf: number;
  max_ro: number;
  max_ns: number;
  stock_qf: number;
  stock_ro: number;
  stock_ns: number;
  version: number;
  last_updated: string | null;
}

export async function pgLoadPortBySector(
  pg: Client,
  sectorId: number,
): Promise<PortRow | null> {
  const result = await pg.queryObject<PortRow>(
    `SELECT p.port_id::int, sc.sector_id::int, p.port_code, p.port_class::int,
            p.max_qf::int, p.max_ro::int, p.max_ns::int,
            p.stock_qf::int, p.stock_ro::int, p.stock_ns::int,
            p.version::int, p.last_updated
    FROM sector_contents sc
    JOIN ports p ON p.port_id = sc.port_id
    WHERE sc.sector_id = $1`,
    [sectorId],
  );
  return convertBigInts(result.rows[0]) ?? null;
}

export async function pgAttemptPortUpdate(
  pg: Client,
  portRow: PortRow,
  updatedStock: { QF: number; RO: number; NS: number },
  observedAt: string,
): Promise<PortRow | null> {
  const result = await pg.queryObject<PortRow>(
    `UPDATE ports
    SET stock_qf = $1,
        stock_ro = $2,
        stock_ns = $3,
        last_updated = $4,
        version = $5
    WHERE port_id = $6 AND version = $7
    RETURNING port_id::int, sector_id::int, port_code, port_class::int,
              max_qf::int, max_ro::int, max_ns::int,
              stock_qf::int, stock_ro::int, stock_ns::int,
              version::int, last_updated`,
    [
      updatedStock.QF,
      updatedStock.RO,
      updatedStock.NS,
      observedAt,
      portRow.version + 1,
      portRow.port_id,
      portRow.version,
    ],
  );
  return convertBigInts(result.rows[0]) ?? null;
}

export async function pgRevertPortInventory(
  pg: Client,
  previous: PortRow,
  current: PortRow,
): Promise<void> {
  await pg.queryObject(
    `UPDATE ports
    SET stock_qf = $1,
        stock_ro = $2,
        stock_ns = $3,
        last_updated = $4,
        version = $5
    WHERE port_id = $6 AND version = $7`,
    [
      previous.stock_qf,
      previous.stock_ro,
      previous.stock_ns,
      new Date().toISOString(),
      current.version + 1,
      current.port_id,
      current.version,
    ],
  );
}

export interface ShipTradeUpdate {
  credits: number;
  cargo_qf: number;
  cargo_ro: number;
  cargo_ns: number;
}

export async function pgUpdateShipAfterTrade(
  pg: Client,
  shipId: string,
  ownerId: string | null,
  updates: ShipTradeUpdate,
): Promise<boolean> {
  let query = `UPDATE ship_instances
    SET credits = $1,
        cargo_qf = $2,
        cargo_ro = $3,
        cargo_ns = $4
    WHERE ship_id = $5`;
  const params: (string | number | null)[] = [
    updates.credits,
    updates.cargo_qf,
    updates.cargo_ro,
    updates.cargo_ns,
    shipId,
  ];

  if (ownerId) {
    query += ` AND owner_id = $6`;
    params.push(ownerId);
  }

  query += ` RETURNING ship_id`;

  const result = await pg.queryObject<{ ship_id: string }>(query, params);
  return result.rows.length > 0;
}

export interface PortTransactionParams {
  sectorId: number;
  portId: number;
  characterId: string;
  shipId: string;
  commodity: string; // 'QF' | 'RO' | 'NS'
  quantity: number;
  transactionType: "buy" | "sell";
  pricePerUnit: number;
  totalPrice: number;
}

export async function pgRecordPortTransaction(
  pg: Client,
  params: PortTransactionParams,
): Promise<void> {
  await pg.queryObject(
    `INSERT INTO port_transactions (
      sector_id, port_id, character_id, ship_id,
      commodity, quantity, transaction_type,
      price_per_unit, total_price
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.sectorId,
      params.portId,
      params.characterId,
      params.shipId,
      params.commodity,
      params.quantity,
      params.transactionType,
      params.pricePerUnit,
      params.totalPrice,
    ],
  );
}

export async function pgListCharactersInSector(
  pg: Client,
  sectorId: number,
  excludeCharacterIds: string[] = [],
): Promise<string[]> {
  // Get ships in sector that are not in hyperspace
  const shipResult = await pg.queryObject<{ ship_id: string }>(
    `SELECT ship_id
    FROM ship_instances
    WHERE current_sector = $1 AND in_hyperspace = false AND destroyed_at IS NULL`,
    [sectorId],
  );

  const shipIds = shipResult.rows.map((row) => row.ship_id).filter(Boolean);
  if (shipIds.length === 0) {
    return [];
  }

  // Get characters piloting those ships
  const charResult = await pg.queryObject<{ character_id: string }>(
    `SELECT character_id
    FROM characters
    WHERE current_ship_id = ANY($1::uuid[])`,
    [shipIds],
  );

  const excludeSet = new Set(excludeCharacterIds);
  const characterIds: string[] = [];
  for (const row of charResult.rows) {
    if (row.character_id && !excludeSet.has(row.character_id)) {
      characterIds.push(row.character_id);
    }
  }
  return characterIds;
}

// Execute port and ship updates in a transaction
export async function pgExecuteTradeTransaction(
  pg: Client,
  params: {
    portRow: PortRow;
    updatedStock: { QF: number; RO: number; NS: number };
    observedAt: string;
    shipId: string;
    ownerId: string | null;
    shipUpdates: ShipTradeUpdate;
  },
): Promise<
  | { success: true; updatedPort: PortRow }
  | { success: false; reason: "version_mismatch" | "ship_update_failed" }
> {
  try {
    await pg.queryObject("BEGIN");

    // Attempt port update with version check
    const portResult = await pg.queryObject<PortRow>(
      `UPDATE ports
      SET stock_qf = $1,
          stock_ro = $2,
          stock_ns = $3,
          last_updated = $4,
          version = $5
      WHERE port_id = $6 AND version = $7
      RETURNING port_id::int, sector_id::int, port_code, port_class::int,
                max_qf::int, max_ro::int, max_ns::int,
                stock_qf::int, stock_ro::int, stock_ns::int,
                version::int, last_updated`,
      [
        params.updatedStock.QF,
        params.updatedStock.RO,
        params.updatedStock.NS,
        params.observedAt,
        params.portRow.version + 1,
        params.portRow.port_id,
        params.portRow.version,
      ],
    );

    if (!portResult.rows[0]) {
      await pg.queryObject("ROLLBACK");
      return { success: false, reason: "version_mismatch" };
    }

    // Update ship
    let shipQuery = `UPDATE ship_instances
      SET credits = $1,
          cargo_qf = $2,
          cargo_ro = $3,
          cargo_ns = $4
      WHERE ship_id = $5`;
    const shipParams: (string | number | null)[] = [
      params.shipUpdates.credits,
      params.shipUpdates.cargo_qf,
      params.shipUpdates.cargo_ro,
      params.shipUpdates.cargo_ns,
      params.shipId,
    ];

    if (params.ownerId) {
      shipQuery += ` AND owner_id = $6`;
      shipParams.push(params.ownerId);
    }

    shipQuery += ` RETURNING ship_id`;

    const shipResult = await pg.queryObject<{ ship_id: string }>(
      shipQuery,
      shipParams,
    );
    if (!shipResult.rows[0]) {
      await pg.queryObject("ROLLBACK");
      return { success: false, reason: "ship_update_failed" };
    }

    await pg.queryObject("COMMIT");
    return { success: true, updatedPort: convertBigInts(portResult.rows[0]) };
  } catch (error) {
    try {
      await pg.queryObject("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw error;
  }
}

// ============================================================================
// Join Function Helpers (direct PG)
// ============================================================================

export class JoinError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "JoinError";
    this.status = status;
  }
}

/**
 * Resolve and validate the target sector for joining.
 */
export async function pgResolveTargetSector(
  pg: Client,
  params: {
    sectorOverride: number | null;
    fallbackSector: number;
    defaultSector?: number;
  },
): Promise<number> {
  const DEFAULT_START_SECTOR = params.defaultSector ?? 0;
  const target =
    params.sectorOverride ?? params.fallbackSector ?? DEFAULT_START_SECTOR;

  const result = await pg.queryObject<{ sector_id: number }>(
    `SELECT sector_id::int FROM universe_structure WHERE sector_id = $1`,
    [target],
  );

  if (!result.rows[0]) {
    throw new JoinError(`invalid sector: ${target}`, 400);
  }
  return target;
}

/**
 * Update ship state when joining (set sector, clear hyperspace).
 */
export async function pgUpdateShipState(
  pg: Client,
  params: {
    shipId: string;
    sectorId: number;
    creditsOverride?: number | null;
  },
): Promise<void> {
  const { shipId, sectorId, creditsOverride } = params;

  if (typeof creditsOverride === "number") {
    await pg.queryObject(
      `UPDATE ship_instances
      SET current_sector = $1,
          in_hyperspace = false,
          hyperspace_destination = NULL,
          hyperspace_eta = NULL,
          credits = $2
      WHERE ship_id = $3`,
      [sectorId, creditsOverride, shipId],
    );
  } else {
    await pg.queryObject(
      `UPDATE ship_instances
      SET current_sector = $1,
          in_hyperspace = false,
          hyperspace_destination = NULL,
          hyperspace_eta = NULL
      WHERE ship_id = $2`,
      [sectorId, shipId],
    );
  }
}

/**
 * Ensure character is linked to their ship and update last_active.
 */
export async function pgEnsureCharacterShipLink(
  pg: Client,
  characterId: string,
  shipId: string,
): Promise<void> {
  await pg.queryObject(
    `UPDATE characters
    SET current_ship_id = $1, last_active = NOW()
    WHERE character_id = $2`,
    [shipId, characterId],
  );
}

interface UniverseSectorRow {
  sector_id: number;
  position_x: number;
  position_y: number;
  warps: unknown;
}

function parseAdjacentIds(structure: UniverseSectorRow): number[] {
  if (!Array.isArray(structure.warps)) {
    return [];
  }
  return structure.warps
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const toValue = (entry as Record<string, unknown>)["to"];
      const to = typeof toValue === "number" ? toValue : Number(toValue);
      return Number.isFinite(to) ? to : null;
    })
    .filter((value): value is number => value !== null);
}

/**
 * Upsert map knowledge entry for a sector (when joining).
 */
export async function pgUpsertKnowledgeEntry(
  pg: Client,
  params: {
    characterId: string;
    sectorId: number;
    existingKnowledge?: MapKnowledge;
  },
): Promise<void> {
  const { characterId, sectorId } = params;

  // Fetch sector structure
  const structResult = await pg.queryObject<UniverseSectorRow>(
    `SELECT sector_id::int, position_x::int, position_y::int, warps
    FROM universe_structure
    WHERE sector_id = $1`,
    [sectorId],
  );

  const structure = structResult.rows[0];
  if (!structure) {
    return; // Sector not found, skip update
  }

  // Load existing personal knowledge if not provided
  let knowledge = params.existingKnowledge;
  if (!knowledge) {
    // Load personal knowledge directly (not merged) since we're updating the character's map_knowledge
    const charResult = await pg.queryObject<{ map_knowledge: unknown }>(
      `SELECT map_knowledge FROM characters WHERE character_id = $1`,
      [characterId],
    );
    knowledge = normalizeMapKnowledge(
      charResult.rows[0]?.map_knowledge ?? null,
    );
  }

  const adjacent = parseAdjacentIds(structure);
  const timestamp = new Date().toISOString();
  const key = String(sectorId);

  // Check if update is needed
  const existing = knowledge.sectors_visited[key];
  const sameAdjacency =
    existing?.adjacent_sectors?.length === adjacent.length &&
    existing.adjacent_sectors?.every((value, idx) => value === adjacent[idx]);

  if (existing && sameAdjacency) {
    // Just update timestamp
    existing.last_visited = timestamp;
  } else {
    // Full update
    knowledge.sectors_visited[key] = {
      adjacent_sectors: adjacent,
      position: [structure.position_x ?? 0, structure.position_y ?? 0],
      last_visited: timestamp,
    };
  }

  // Update total count
  const total = Object.keys(knowledge.sectors_visited).length;
  knowledge.total_sectors_visited = Math.max(
    knowledge.total_sectors_visited,
    total,
  );

  // Persist
  await pgUpdateMapKnowledge(pg, characterId, knowledge);
}

/**
 * Load a character with corporation info for join operations.
 * Returns null if character not found.
 */
export async function pgLoadCharacterForJoin(
  pg: Client,
  characterId: string,
): Promise<(CharacterRow & { corporation_id: string | null }) | null> {
  const result = await pg.queryObject<
    CharacterRow & { corporation_id: string | null }
  >(
    `SELECT
      character_id,
      name,
      current_ship_id,
      credits_in_megabank::bigint as credits_in_megabank,
      map_knowledge,
      player_metadata,
      first_visit,
      last_active,
      corporation_id,
      corporation_joined_at
    FROM characters
    WHERE character_id = $1`,
    [characterId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return convertBigInts(row);
}
