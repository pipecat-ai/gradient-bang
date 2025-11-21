import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SALVAGE_TTL_SECONDS = Number(Deno.env.get('SALVAGE_TTL_SECONDS') ?? '900');

export interface SalvageEntry extends Record<string, unknown> {
  salvage_id: string;
  created_at: string;
  expires_at: string;
  cargo: Record<string, number>;
  scrap: number;
  credits: number;
  claimed: boolean;
  source: {
    ship_name: string | null;
    ship_type: string | null;
  };
  metadata: Record<string, unknown>;
}

export function buildSalvageEntry(
  ship: { ship_name: string | null; ship_type: string },
  displayName: string,
  cargo: Record<string, number>,
  scrap: number,
  credits: number,
  metadata: Record<string, unknown> = {},
): SalvageEntry {
  const now = new Date();
  const expires = new Date(now.getTime() + SALVAGE_TTL_SECONDS * 1000);
  return {
    salvage_id: crypto.randomUUID(),
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    cargo,
    scrap,
    credits,
    claimed: false,
    source: {
      ship_name: ship.ship_name ?? displayName,
      ship_type: ship.ship_type,
    },
    metadata,
  };
}

export async function appendSalvageEntry(
  supabase: SupabaseClient,
  sectorId: number,
  entry: SalvageEntry,
): Promise<void> {
  const { data, error } = await supabase
    .from('sector_contents')
    .select('salvage')
    .eq('sector_id', sectorId)
    .maybeSingle();
  if (error) {
    console.error('salvage.append.fetch', error);
    throw new Error('Failed to load sector salvage state');
  }
  if (!data) {
    throw new Error('Sector state unavailable');
  }
  const nowMs = Date.now();
  const existing = Array.isArray(data.salvage) ? data.salvage.filter((raw) => {
    if (!raw || typeof raw !== 'object') {
      return false;
    }
    const expiresAt = (raw as Record<string, unknown>).expires_at;
    if (typeof expiresAt !== 'string') {
      return true;
    }
    const expireStamp = Date.parse(expiresAt);
    return Number.isNaN(expireStamp) ? true : expireStamp > nowMs;
  }) : [];
  existing.push(entry);

  const { error: updateError } = await supabase
    .from('sector_contents')
    .update({ salvage: existing, updated_at: new Date().toISOString() })
    .eq('sector_id', sectorId);
  if (updateError) {
    console.error('salvage.append.update', updateError);
    throw new Error('Failed to update sector salvage');
  }
}
