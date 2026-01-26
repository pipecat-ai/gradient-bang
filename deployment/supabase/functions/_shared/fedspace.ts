import type { SupabaseClient } from "@supabase/supabase-js";

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

export function pickRandomFedspaceSector(
  meta: UniverseMeta,
  fallbackSector: number,
): number {
  const fedspaceSectors = getFedspaceSectors(meta);
  if (fedspaceSectors.length === 0) {
    return fallbackSector;
  }
  const index = Math.floor(Math.random() * fedspaceSectors.length);
  return fedspaceSectors[index] ?? fallbackSector;
}
