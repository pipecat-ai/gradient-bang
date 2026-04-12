import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdjacentSectors, fetchAllAdjacencies } from "./map.ts";

export interface UniverseMeta {
  mega_port_sectors?: number[] | null;
  mega_port_sector?: number | null;
  fedspace_sectors?: number[] | null;
  fedspace_region_name?: string | null;
}

const META_CACHE_TTL_MS = 30_000;
let cachedMeta: UniverseMeta | null = null;
let cachedMetaExpiresAt = 0;

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

export async function loadUniverseMeta(
  supabase: SupabaseClient,
): Promise<UniverseMeta> {
  if (cachedMeta && cachedMetaExpiresAt > Date.now()) {
    return cachedMeta;
  }

  const { data, error } = await supabase
    .from("universe_config")
    .select("meta")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.error("fedspace.meta.load", error);
    cachedMeta = {};
    cachedMetaExpiresAt = Date.now() + META_CACHE_TTL_MS;
    return cachedMeta;
  }

  cachedMeta = (data?.meta ?? {}) as UniverseMeta;
  cachedMetaExpiresAt = Date.now() + META_CACHE_TTL_MS;
  return cachedMeta;
}

export function getMegaPortSectors(meta: UniverseMeta): number[] {
  const list = normalizeSectorList(meta.mega_port_sectors);
  if (list.length > 0) {
    return list;
  }
  return normalizeSectorList(meta.mega_port_sector);
}

export function getFedspaceSectors(meta: UniverseMeta): number[] {
  return normalizeSectorList(meta.fedspace_sectors);
}

export function isMegaPortSector(meta: UniverseMeta, sectorId: number): boolean {
  const megaPorts = getMegaPortSectors(meta);
  if (megaPorts.length > 0) {
    return megaPorts.includes(sectorId);
  }
  // Fallback for legacy data that lacks meta lists.
  return sectorId === 0;
}

export async function isFedspaceSector(
  supabase: SupabaseClient,
  sectorId: number,
  meta?: UniverseMeta,
): Promise<boolean> {
  const resolvedMeta = meta ?? (await loadUniverseMeta(supabase));
  const fedspaceSectors = getFedspaceSectors(resolvedMeta);
  if (fedspaceSectors.length > 0) {
    return fedspaceSectors.includes(sectorId);
  }

  const regionName =
    typeof resolvedMeta.fedspace_region_name === "string" &&
      resolvedMeta.fedspace_region_name.trim()
      ? resolvedMeta.fedspace_region_name.trim()
      : "Federation Space";

  const { data, error } = await supabase
    .from("universe_structure")
    .select("region")
    .eq("sector_id", sectorId)
    .maybeSingle();
  if (error) {
    console.error("fedspace.region.lookup", error);
    return false;
  }
  return data?.region === regionName;
}

export async function isAdjacentToFedspace(
  supabase: SupabaseClient,
  sectorId: number,
  meta?: UniverseMeta,
): Promise<boolean> {
  const neighbors = await getAdjacentSectors(supabase, sectorId);
  for (const neighbor of neighbors) {
    if (await isFedspaceSector(supabase, neighbor, meta)) {
      return true;
    }
  }
  return false;
}

export function pickRandomFedspaceSector(
  meta: UniverseMeta,
  fallbackSector: number,
): number {
  const fedspaceSectors = getFedspaceSectors(meta);
  if (fedspaceSectors.length === 0) {
    return fallbackSector;
  }

  // Exclude mega port sectors so new players must discover them via quests.
  const megaSet = new Set(getMegaPortSectors(meta));
  const candidates = fedspaceSectors.filter((s) => !megaSet.has(s));

  if (candidates.length === 0) {
    return fallbackSector;
  }
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index] ?? fallbackSector;
}

const CHARACTER_SPAWN_MP_DISTANCE = Math.max(
  2,
  Number(Deno.env.get("CHARACTER_SPAWN_MP_DISTANCE") ?? "8") || 8,
);
const CHARACTER_SPAWN_MP_DISTANCE_MIN = 2;

/**
 * Multi-source BFS: compute shortest distance from every reachable sector
 * to the nearest source sector.
 */
function computeDistancesFromSectors(
  adjacency: Map<number, number[]>,
  sources: number[],
): Map<number, number> {
  const distances = new Map<number, number>();
  const queue: number[] = [];
  for (const s of sources) {
    if (adjacency.has(s)) {
      distances.set(s, 0);
      queue.push(s);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const dist = distances.get(current)!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!distances.has(neighbor)) {
        distances.set(neighbor, dist + 1);
        queue.push(neighbor);
      }
    }
  }
  return distances;
}

/**
 * Resolve the full set of fedspace sector IDs, handling the region-based
 * fallback when no explicit fedspace_sectors list is configured.
 */
async function resolveFedspaceSectorSet(
  supabase: SupabaseClient,
  meta: UniverseMeta,
): Promise<Set<number>> {
  const explicit = getFedspaceSectors(meta);
  if (explicit.length > 0) {
    return new Set(explicit);
  }

  const regionName =
    typeof meta.fedspace_region_name === "string" &&
      meta.fedspace_region_name.trim()
      ? meta.fedspace_region_name.trim()
      : "Federation Space";

  const { data, error } = await supabase
    .from("universe_structure")
    .select("sector_id")
    .eq("region", regionName);

  if (error || !data) {
    console.error("fedspace.resolveFedspaceSectorSet", error);
    return new Set();
  }
  return new Set(data.map((r: { sector_id: number }) => r.sector_id));
}

/**
 * Pick a spawn sector for a new character at a controlled graph distance
 * from the nearest mega port, within Federation Space.
 *
 * Tries the configured distance first, then decrements down to a minimum
 * of 2 hops. Falls back to any random fedspace sector if no distance-based
 * candidate is found.
 */
export async function pickSpawnSector(
  supabase: SupabaseClient,
  meta?: UniverseMeta,
): Promise<number> {
  const resolvedMeta = meta ?? (await loadUniverseMeta(supabase));
  const megaPorts = getMegaPortSectors(resolvedMeta);

  if (megaPorts.length === 0) {
    console.warn("pickSpawnSector: no mega ports configured, using random fedspace sector");
    return pickRandomFedspaceSector(resolvedMeta, 0);
  }

  const fedspaceSet = await resolveFedspaceSectorSet(supabase, resolvedMeta);
  if (fedspaceSet.size === 0) {
    console.warn("pickSpawnSector: no fedspace sectors found, using fallback sector 0");
    return 0;
  }

  const megaSet = new Set(megaPorts);
  const adjacency = await fetchAllAdjacencies();
  const distances = computeDistancesFromSectors(adjacency, megaPorts);

  for (
    let dist = CHARACTER_SPAWN_MP_DISTANCE;
    dist >= CHARACTER_SPAWN_MP_DISTANCE_MIN;
    dist--
  ) {
    const candidates: number[] = [];
    for (const [sector, d] of distances) {
      if (d === dist && fedspaceSet.has(sector) && !megaSet.has(sector)) {
        candidates.push(sector);
      }
    }
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)]!;
    }
  }

  console.warn("pickSpawnSector: no sector found at any valid distance, using random fedspace sector");
  return pickRandomFedspaceSector(resolvedMeta, 0);
}
