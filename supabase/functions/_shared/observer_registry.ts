import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface CacheEntry {
  channels: string[];
  expiresAt: number;
}

const OBSERVER_CACHE_TTL_MS = Number(Deno.env.get('SUPABASE_OBSERVER_CACHE_TTL_MS') ?? '30000');
const observerCache = new Map<number, CacheEntry>();

function normalizeChannels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : null))
      .filter((entry): entry is string => Boolean(entry));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

export async function getObserverChannels(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<string[]> {
  const cached = observerCache.get(sectorId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.channels;
  }

  const { data, error } = await supabase
    .from('sector_contents')
    .select('observer_channels')
    .eq('sector_id', sectorId)
    .maybeSingle();
  if (error) {
    console.error('observer_registry.load', { sectorId, error });
    observerCache.set(sectorId, { channels: [], expiresAt: now + OBSERVER_CACHE_TTL_MS });
    return [];
  }

  const channels = normalizeChannels(data?.observer_channels);
  observerCache.set(sectorId, { channels, expiresAt: now + OBSERVER_CACHE_TTL_MS });
  return channels;
}
