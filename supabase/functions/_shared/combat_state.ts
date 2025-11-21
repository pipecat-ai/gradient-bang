import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import {
  CombatEncounterState,
  CombatantState,
  nowIso,
  RoundActionState,
} from './combat_types.ts';

interface SectorCombatRow {
  sector_id: number;
  combat: unknown;
}

export function deserializeCombat(raw: unknown): CombatEncounterState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const combatId = typeof data.combat_id === 'string' ? data.combat_id : null;
  const sectorId = typeof data.sector_id === 'number' ? data.sector_id : null;
  if (!combatId || sectorId === null) {
    return null;
  }
  return {
    combat_id: combatId,
    sector_id: sectorId,
    round: typeof data.round === 'number' ? data.round : 1,
    deadline: typeof data.deadline === 'string' ? data.deadline : null,
    participants: (data.participants as Record<string, CombatantState>) ?? {},
    pending_actions: (data.pending_actions as Record<string, RoundActionState>) ?? {},
    logs: Array.isArray(data.logs) ? (data.logs as never[]) : [],
    context: (data.context as Record<string, unknown>) ?? {},
    awaiting_resolution: Boolean(data.awaiting_resolution),
    ended: Boolean(data.ended),
    end_state: typeof data.end_state === 'string' ? data.end_state : null,
    base_seed: typeof data.base_seed === 'number' ? data.base_seed : Math.floor(Math.random() * 1_000_000),
    last_updated: typeof data.last_updated === 'string' ? data.last_updated : nowIso(),
  };
}

function serializeCombat(encounter: CombatEncounterState): Record<string, unknown> {
  return {
    combat_id: encounter.combat_id,
    sector_id: encounter.sector_id,
    round: encounter.round,
    deadline: encounter.deadline,
    participants: encounter.participants,
    pending_actions: encounter.pending_actions,
    logs: encounter.logs,
    context: encounter.context,
    awaiting_resolution: encounter.awaiting_resolution,
    ended: encounter.ended,
    end_state: encounter.end_state,
    base_seed: encounter.base_seed,
    last_updated: nowIso(),
  };
}

export async function loadCombatForSector(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<CombatEncounterState | null> {
  const { data, error } = await supabase
    .from<SectorCombatRow>('sector_contents')
    .select('sector_id, combat')
    .eq('sector_id', sectorId)
    .maybeSingle();
  if (error) {
    console.error('combat_state.load_sector', error);
    throw new Error('Failed to load sector combat state');
  }
  if (!data || !data.combat) {
    return null;
  }
  return deserializeCombat({
    ...(data.combat as Record<string, unknown>),
    sector_id: data.sector_id,
  });
}

export async function loadCombatById(
  supabase: SupabaseClient,
  combatId: string,
): Promise<CombatEncounterState | null> {
  const { data, error } = await supabase
    .from<SectorCombatRow>('sector_contents')
    .select('sector_id, combat')
    .not('combat', 'is', null)
    .eq('combat->>combat_id', combatId)
    .maybeSingle();
  if (error) {
    console.error('combat_state.load_id', error);
    throw new Error('Failed to load combat encounter');
  }
  if (!data || !data.combat) {
    return null;
  }
  return deserializeCombat({
    ...(data.combat as Record<string, unknown>),
    sector_id: data.sector_id,
  });
}

export async function persistCombatState(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
): Promise<void> {
  const payload = serializeCombat(encounter);
  const { error } = await supabase
    .from('sector_contents')
    .update({
      combat: payload,
      updated_at: nowIso(),
    })
    .eq('sector_id', encounter.sector_id);
  if (error) {
    console.error('combat_state.persist', error);
    throw new Error('Failed to persist combat state');
  }
}

export async function clearCombatState(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<void> {
  const { error } = await supabase
    .from('sector_contents')
    .update({
      combat: null,
      updated_at: nowIso(),
    })
    .eq('sector_id', sectorId);
  if (error) {
    console.error('combat_state.clear', error);
    throw new Error('Failed to clear combat state');
  }
}

export function ensureEncounterDefaults(encounter: CombatEncounterState): CombatEncounterState {
  encounter.participants ??= {};
  encounter.pending_actions ??= {};
  encounter.logs ??= [];
  encounter.context ??= {};
  return encounter;
}

export async function listDueCombats(
  supabase: SupabaseClient,
  nowIsoString: string,
  limit = 20,
): Promise<CombatEncounterState[]> {
  const { data, error } = await supabase
    .from<SectorCombatRow>('sector_contents')
    .select('sector_id, combat')
    .not('combat', 'is', null)
    .not('combat->>deadline', 'is', null)
    .lte('combat->>deadline', nowIsoString)
    .or('combat->>ended.is.null,combat->>ended.eq.false')
    .limit(limit);
  if (error) {
    console.error('combat_state.list_due', error);
    throw new Error('Failed to fetch due combat encounters');
  }
  const encounters: CombatEncounterState[] = [];
  for (const row of data ?? []) {
    const encounter = deserializeCombat({
      ...(row.combat as Record<string, unknown>),
      sector_id: row.sector_id,
    });
    if (encounter) {
      encounters.push(encounter);
    }
  }
  return encounters;
}
