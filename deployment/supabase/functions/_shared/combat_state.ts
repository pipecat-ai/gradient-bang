import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CombatEncounterState,
  CombatantState,
  nowIso,
  PendingCorpShipDeletion,
  RoundActionState,
} from "./combat_types.ts";

interface SectorCombatRow {
  sector_id: number;
  combat: unknown;
}

export function deserializeCombat(raw: unknown): CombatEncounterState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const combatId = typeof data.combat_id === "string" ? data.combat_id : null;
  const sectorId = typeof data.sector_id === "number" ? data.sector_id : null;
  if (!combatId || sectorId === null) {
    return null;
  }
  return {
    combat_id: combatId,
    sector_id: sectorId,
    round: typeof data.round === "number" ? data.round : 1,
    deadline: typeof data.deadline === "string" ? data.deadline : null,
    participants: (data.participants as Record<string, CombatantState>) ?? {},
    pending_actions:
      (data.pending_actions as Record<string, RoundActionState>) ?? {},
    logs: Array.isArray(data.logs) ? (data.logs as never[]) : [],
    context: (data.context as Record<string, unknown>) ?? {},
    awaiting_resolution: Boolean(data.awaiting_resolution),
    ended: Boolean(data.ended),
    end_state: typeof data.end_state === "string" ? data.end_state : null,
    base_seed:
      typeof data.base_seed === "number"
        ? data.base_seed
        : Math.floor(Math.random() * 1_000_000),
    last_updated:
      typeof data.last_updated === "string" ? data.last_updated : nowIso(),
    pending_corp_ship_deletions: Array.isArray(data.pending_corp_ship_deletions)
      ? (data.pending_corp_ship_deletions as PendingCorpShipDeletion[])
      : [],
    pending_salvage_entries: Array.isArray(data.pending_salvage_entries)
      ? (data.pending_salvage_entries as Array<Record<string, unknown>>)
      : [],
  };
}

function serializeCombat(
  encounter: CombatEncounterState,
  lastUpdated: string,
): Record<string, unknown> {
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
    last_updated: lastUpdated,
    pending_corp_ship_deletions: encounter.pending_corp_ship_deletions ?? [],
    pending_salvage_entries: encounter.pending_salvage_entries ?? [],
  };
}

export async function loadCombatForSector(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<CombatEncounterState | null> {
  const { data, error } = await supabase
    .from<SectorCombatRow>("sector_contents")
    .select("sector_id, combat")
    .eq("sector_id", sectorId)
    .maybeSingle();
  if (error) {
    console.error("combat_state.load_sector", error);
    throw new Error("Failed to load sector combat state");
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
    .from<SectorCombatRow>("sector_contents")
    .select("sector_id, combat")
    .not("combat", "is", null)
    .eq("combat->>combat_id", combatId)
    .maybeSingle();
  if (error) {
    console.error("combat_state.load_id", error);
    throw new Error("Failed to load combat encounter");
  }
  if (!data || !data.combat) {
    return null;
  }
  return deserializeCombat({
    ...(data.combat as Record<string, unknown>),
    sector_id: data.sector_id,
  });
}

/**
 * Thrown by `persistCombatState` when an OCC compare-and-swap fails. The
 * caller's load-modify-write was racing against a concurrent writer; the
 * caller should re-load the encounter and re-evaluate.
 */
export class CombatStateConflictError extends Error {
  constructor(sectorId: number) {
    super(
      `Concurrent write conflict on sector_contents.combat (sector_id=${sectorId})`,
    );
    this.name = "CombatStateConflictError";
  }
}

export async function persistCombatState(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  options?: { expectedLastUpdated?: string | null },
): Promise<void> {
  const newLastUpdated = nowIso();
  const payload = serializeCombat(encounter, newLastUpdated);
  const expected = options?.expectedLastUpdated;

  // Plain write path — used during the fresh-encounter creation flow and
  // any RMW that doesn't need cross-writer protection. Combat tick and
  // mid-encounter join paths pass `expectedLastUpdated` to take the OCC
  // path below.
  if (expected === undefined) {
    const { error } = await supabase
      .from("sector_contents")
      .update({
        combat: payload,
        updated_at: newLastUpdated,
      })
      .eq("sector_id", encounter.sector_id);
    if (error) {
      console.error("combat_state.persist", error);
      throw new Error("Failed to persist combat state");
    }
    encounter.last_updated = newLastUpdated;
    return;
  }

  // OCC path — cas_update_combat returns true when the row's current
  // last_updated matches `expected`, false otherwise. Migration:
  // 20260429000000_combat_state_cas.sql.
  const { data, error } = await supabase.rpc("cas_update_combat", {
    p_sector_id: encounter.sector_id,
    p_expected_last_updated: expected,
    p_new_combat: payload,
  });
  if (error) {
    console.error("combat_state.persist.cas", error);
    throw new Error("Failed to persist combat state");
  }
  if (data !== true) {
    throw new CombatStateConflictError(encounter.sector_id);
  }
  // After a successful CAS, mirror the new last_updated back onto the
  // in-memory encounter. Subsequent persist() calls in the same logical
  // operation (eject's mid-round persist, finalize's per-defeat persist,
  // and the final persist at the end of resolveEncounterRound) can then
  // pass `encounter.last_updated` as their next CAS fence and compose
  // correctly.
  encounter.last_updated = newLastUpdated;
}

export async function clearCombatState(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<void> {
  const { error } = await supabase
    .from("sector_contents")
    .update({
      combat: null,
      updated_at: nowIso(),
    })
    .eq("sector_id", sectorId);
  if (error) {
    console.error("combat_state.clear", error);
    throw new Error("Failed to clear combat state");
  }
}

export function ensureEncounterDefaults(
  encounter: CombatEncounterState,
): CombatEncounterState {
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
    .from<SectorCombatRow>("sector_contents")
    .select("sector_id, combat")
    .not("combat", "is", null)
    .not("combat->>deadline", "is", null)
    .lte("combat->>deadline", nowIsoString)
    .or("combat->>ended.is.null,combat->>ended.eq.false")
    .limit(limit);
  if (error) {
    console.error("combat_state.list_due", error);
    throw new Error("Failed to fetch due combat encounters");
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
