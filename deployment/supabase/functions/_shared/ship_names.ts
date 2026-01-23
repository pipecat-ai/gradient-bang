import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type ShipNameLookupMatch = {
  ship_id: string;
  ship_name: string | null;
  ship_type: string | null;
};

export type ShipNameLookupResult =
  | { status: 'match'; ship: ShipNameLookupMatch }
  | { status: 'ambiguous'; base_name: string; candidates: string[]; total_matches: number }
  | { status: 'none' };

export type ShipNameLookupErrorStage = 'exact' | 'suffix';

export type ShipNameLookupError = Error & { stage: ShipNameLookupErrorStage; cause?: unknown };

export async function resolveShipByNameWithSuffixFallback(
  supabase: SupabaseClient,
  shipName: string,
): Promise<ShipNameLookupResult> {
  const candidates = shipNameCandidates(shipName);
  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from('ship_instances')
      .select('ship_id, ship_name, ship_type')
      .eq('ship_name', candidate)
      .maybeSingle();

    if (error) {
      throw buildLookupError('exact', error);
    }
    if (data && typeof data.ship_id === 'string') {
      return {
        status: 'match',
        ship: {
          ship_id: data.ship_id,
          ship_name: data.ship_name ?? null,
          ship_type: data.ship_type ?? null,
        },
      };
    }
  }

  const baseNameRaw = normalizeShipName(shipName.trim()).trim();
  if (!baseNameRaw) {
    return { status: 'none' };
  }

  const { data: suffixMatches, error: suffixError } = await supabase
    .from('ship_instances')
    .select('ship_id, ship_name, ship_type')
    .ilike('ship_name', `${escapeLikePattern(baseNameRaw)} [%]`);

  if (suffixError) {
    throw buildLookupError('suffix', suffixError);
  }

  const suffixRegex = buildShipNameSuffixRegex(baseNameRaw);
  const matches = (suffixMatches ?? []).filter(
    (row) => typeof row.ship_name === 'string' && suffixRegex.test(row.ship_name),
  );

  if (matches.length > 1) {
    const candidateNames = Array.from(
      new Set(
        matches
          .map((row) => row.ship_name)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0),
      ),
    );
    return {
      status: 'ambiguous',
      base_name: baseNameRaw,
      candidates: candidateNames,
      total_matches: matches.length,
    };
  }

  if (matches.length === 1) {
    const match = matches[0];
    if (typeof match.ship_id !== 'string') {
      return { status: 'none' };
    }
    return {
      status: 'match',
      ship: {
        ship_id: match.ship_id,
        ship_name: match.ship_name ?? null,
        ship_type: match.ship_type ?? null,
      },
    };
  }

  return { status: 'none' };
}

function buildLookupError(stage: ShipNameLookupErrorStage, cause: unknown): ShipNameLookupError {
  const err = new Error('ship_name_lookup_failed') as ShipNameLookupError;
  err.stage = stage;
  (err as { cause?: unknown }).cause = cause;
  return err;
}

function shipNameCandidates(value: string): string[] {
  const trimmed = value.trim();
  const normalized = normalizeShipName(trimmed);
  if (normalized !== trimmed) {
    return [trimmed, normalized];
  }
  return [trimmed];
}

function normalizeShipName(value: string): string {
  const match = value.match(/^(.*)\s\[[0-9a-f]{6,8}(?:-[0-9]+)?\]$/i);
  if (match) {
    return match[1].trim();
  }
  return value;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildShipNameSuffixRegex(baseName: string): RegExp {
  return new RegExp(`^${escapeRegExp(baseName)}\\s\\[[0-9a-f]{6,8}(?:-[0-9]+)?\\]$`, 'i');
}
