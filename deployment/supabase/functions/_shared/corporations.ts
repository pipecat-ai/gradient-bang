import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEventWithRecipients } from "./events.ts";
import { fetchActiveTaskIdsByShip } from "./tasks.ts";
import type { ShipDefinitionRow } from "./status.ts";

export interface CorporationRecord {
  corp_id: string;
  name: string;
  founder_id: string;
  founded: string;
  invite_code: string;
  invite_code_generated: string;
  invite_code_generated_by: string | null;
}

export interface CorporationMemberSummary {
  character_id: string;
  name: string;
  joined_at: string | null;
}

export interface CorporationShipSummary {
  ship_id: string;
  ship_type: string;
  name: string;
  sector: number | null;
  owner_type: string;
  control_ready: boolean;
  credits: number;
  cargo: {
    quantum_foam: number;
    retro_organics: number;
    neuro_symbolics: number;
  };
  cargo_capacity: number;
  warp_power: number;
  warp_power_capacity: number;
  shields: number;
  max_shields: number;
  fighters: number;
  max_fighters: number;
  current_task_id: string | null;
}

export interface DestroyedCorporationShip {
  ship_id: string;
  ship_type: string;
  name: string;
  sector: number | null;
  destroyed_at: string;
}

const INVITE_BYTES = 4;

export function generateInviteCode(): string {
  const buffer = new Uint8Array(INVITE_BYTES);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function loadCorporationById(
  supabase: SupabaseClient,
  corpId: string,
): Promise<CorporationRecord> {
  const { data, error } = await supabase
    .from("corporations")
    .select(
      "corp_id, name, founder_id, founded, invite_code, invite_code_generated, invite_code_generated_by",
    )
    .eq("corp_id", corpId)
    .maybeSingle();

  if (error) {
    console.error("corporations.load", error);
    throw new Error("Failed to load corporation data");
  }
  if (!data) {
    throw new Error("Corporation not found");
  }
  return data as CorporationRecord;
}

export async function isActiveCorporationMember(
  supabase: SupabaseClient,
  corpId: string,
  characterId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("corporation_members")
    .select("character_id")
    .eq("corp_id", corpId)
    .eq("character_id", characterId)
    .is("left_at", null)
    .maybeSingle();
  if (error) {
    console.error("corporations.membership.check", error);
    throw new Error("Failed to verify corporation membership");
  }
  return Boolean(data);
}

export async function upsertCorporationMembership(
  supabase: SupabaseClient,
  corpId: string,
  characterId: string,
  joinedAt: string,
): Promise<void> {
  const { error } = await supabase.from("corporation_members").upsert(
    {
      corp_id: corpId,
      character_id: characterId,
      joined_at: joinedAt,
      left_at: null,
    },
    { onConflict: "corp_id,character_id" },
  );
  if (error) {
    console.error("corporations.membership.upsert", error);
    throw new Error("Failed to update membership");
  }
}

export async function markCorporationMembershipLeft(
  supabase: SupabaseClient,
  corpId: string,
  characterId: string,
  leftAt: string,
): Promise<void> {
  const { error } = await supabase
    .from("corporation_members")
    .update({ left_at: leftAt })
    .eq("corp_id", corpId)
    .eq("character_id", characterId);
  if (error) {
    console.error("corporations.membership.leave", error);
    throw new Error("Failed to update membership state");
  }
}

export async function fetchCorporationMembers(
  supabase: SupabaseClient,
  corpId: string,
): Promise<CorporationMemberSummary[]> {
  const membershipRows = await fetchActiveMembershipRows(supabase, corpId);
  if (!membershipRows.length) {
    return [];
  }

  const memberIds = membershipRows.map((row) => row.character_id);
  const { data: characterRows, error } = await supabase
    .from("characters")
    .select("character_id, name")
    .in("character_id", memberIds);
  if (error) {
    console.error("corporations.members.characters", error);
    throw new Error("Failed to load member profiles");
  }
  const nameMap = new Map<string, string>();
  for (const row of characterRows ?? []) {
    if (row && typeof row.character_id === "string") {
      const candidate =
        typeof row.name === "string" && row.name.trim().length > 0
          ? row.name
          : row.character_id;
      nameMap.set(row.character_id, candidate);
    }
  }

  return membershipRows.map((row) => ({
    character_id: row.character_id,
    name: nameMap.get(row.character_id) ?? row.character_id,
    joined_at: row.joined_at ?? null,
  }));
}

export async function listCorporationMemberIds(
  supabase: SupabaseClient,
  corpId: string,
): Promise<string[]> {
  const membershipRows = await fetchActiveMembershipRows(supabase, corpId);
  return membershipRows.map((row) => row.character_id);
}

export async function fetchCorporationShipSummaries(
  supabase: SupabaseClient,
  corpId: string,
): Promise<CorporationShipSummary[]> {
  const { data: shipLinks, error: linkError } = await supabase
    .from("corporation_ships")
    .select("ship_id")
    .eq("corp_id", corpId);
  if (linkError) {
    console.error("corporations.ships.list", linkError);
    throw new Error("Failed to load corporation ships");
  }
  const shipIds = (shipLinks ?? [])
    .map((row) => row?.ship_id)
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  if (!shipIds.length) {
    return [];
  }

  const { data: shipRows, error: shipError } = await supabase
    .from("ship_instances")
    .select(
      "ship_id, ship_type, ship_name, current_sector, owner_type, credits, cargo_qf, cargo_ro, cargo_ns, current_warp_power, current_shields, current_fighters",
    )
    .in("ship_id", shipIds)
    .neq("owner_type", "unowned")
    .is("destroyed_at", null);
  if (shipError) {
    console.error("corporations.ships.instances", shipError);
    throw new Error("Failed to load ship instances");
  }

  const definitionMap = await loadShipDefinitions(supabase, shipRows ?? []);
  const controlReady = await loadControlReadySet(supabase, shipIds);
  const activeTasks = await fetchActiveTaskIdsByShip(supabase, shipIds);
  const summaries: CorporationShipSummary[] = [];

  for (const row of shipRows ?? []) {
    if (!row || typeof row.ship_id !== "string") {
      continue;
    }
    const shipId = row.ship_id;
    const definition = definitionMap.get(row.ship_type ?? "") ?? null;
    const cargo = {
      quantum_foam: Number(row.cargo_qf ?? 0),
      retro_organics: Number(row.cargo_ro ?? 0),
      neuro_symbolics: Number(row.cargo_ns ?? 0),
    };
    const cargoCapacity = definition?.cargo_holds ?? 0;
    summaries.push({
      ship_id: shipId,
      ship_type: row.ship_type ?? "unknown",
      name:
        typeof row.ship_name === "string" && row.ship_name.trim().length > 0
          ? row.ship_name
          : (definition?.display_name ?? row.ship_type ?? shipId),
      sector:
        typeof row.current_sector === "number" ? row.current_sector : null,
      owner_type: row.owner_type ?? "unowned",
      control_ready: controlReady.has(shipId),
      credits: Number(row.credits ?? 0),
      cargo,
      cargo_capacity: cargoCapacity,
      warp_power: Number(
        row.current_warp_power ?? definition?.warp_power_capacity ?? 0,
      ),
      warp_power_capacity: definition?.warp_power_capacity ?? 0,
      shields: Number(row.current_shields ?? definition?.shields ?? 0),
      max_shields: definition?.shields ?? 0,
      fighters: Number(row.current_fighters ?? definition?.fighters ?? 0),
      max_fighters: definition?.fighters ?? 0,
      current_task_id: activeTasks.get(shipId) ?? null,
    });
  }

  return summaries;
}

export async function fetchDestroyedCorporationShips(
  supabase: SupabaseClient,
  corpId: string,
): Promise<DestroyedCorporationShip[]> {
  const { data: shipRows, error } = await supabase
    .from("ship_instances")
    .select("ship_id, ship_type, ship_name, current_sector, destroyed_at")
    .eq("owner_corporation_id", corpId)
    .not("destroyed_at", "is", null)
    .order("destroyed_at", { ascending: false });
  if (error) {
    console.error("corporations.ships.destroyed", error);
    throw new Error("Failed to load destroyed corporation ships");
  }

  const definitionMap = await loadShipDefinitions(supabase, shipRows ?? []);

  return (shipRows ?? [])
    .filter((row) => row && typeof row.ship_id === "string")
    .map((row) => {
      const definition = definitionMap.get(row.ship_type ?? "") ?? null;
      return {
        ship_id: row.ship_id,
        ship_type: row.ship_type ?? "unknown",
        name:
          typeof row.ship_name === "string" && row.ship_name.trim().length > 0
            ? row.ship_name
            : (definition?.display_name ?? row.ship_type ?? row.ship_id),
        sector:
          typeof row.current_sector === "number" ? row.current_sector : null,
        destroyed_at: row.destroyed_at,
      };
    });
}

export function buildCorporationPublicPayload(
  corp: CorporationRecord,
  memberCount: number,
): Record<string, unknown> {
  return {
    corp_id: corp.corp_id,
    name: corp.name,
    founded: corp.founded,
    member_count: memberCount,
  };
}

export function buildCorporationMemberPayload(
  corp: CorporationRecord,
  members: CorporationMemberSummary[],
  ships: CorporationShipSummary[],
  destroyedShips: DestroyedCorporationShip[] = [],
): Record<string, unknown> {
  return {
    ...buildCorporationPublicPayload(corp, members.length),
    founder_id: corp.founder_id,
    invite_code: corp.invite_code,
    invite_code_generated: corp.invite_code_generated,
    invite_code_generated_by: corp.invite_code_generated_by,
    members,
    ships,
    destroyed_ships: destroyedShips,
  };
}

export async function emitCorporationEvent(
  supabase: SupabaseClient,
  corpId: string,
  options: {
    eventType: string;
    payload: Record<string, unknown>;
    requestId: string;
    memberIds?: string[];
    actorCharacterId?: string | null;
    taskId?: string | null;
  },
): Promise<void> {
  let recipients = options.memberIds;
  if (!recipients) {
    try {
      recipients = await listCorporationMemberIds(supabase, corpId);
    } catch (err) {
      console.error("corporations.event.members", err);
      return;
    }
  }
  const uniqueRecipients = Array.from(
    new Set(
      (recipients ?? []).filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  );
  if (!uniqueRecipients.length) {
    return;
  }

  const eventId = await recordEventWithRecipients({
    supabase,
    eventType: options.eventType,
    scope: "corp",
    payload: options.payload,
    requestId: options.requestId,
    corpId,
    actorCharacterId: options.actorCharacterId ?? null,
    taskId: options.taskId ?? null,
    recipients: uniqueRecipients.map((characterId) => ({
      characterId,
      reason: "corp_snapshot",
    })),
  });
}

async function fetchActiveMembershipRows(
  supabase: SupabaseClient,
  corpId: string,
): Promise<Array<{ character_id: string; joined_at: string | null }>> {
  const { data, error } = await supabase
    .from("corporation_members")
    .select("character_id, joined_at, left_at")
    .eq("corp_id", corpId)
    .is("left_at", null)
    .order("joined_at", { ascending: true });
  if (error) {
    console.error("corporations.members.active", error);
    throw new Error("Failed to load corporation members");
  }
  const rows: Array<{ character_id: string; joined_at: string | null }> = [];
  for (const entry of data ?? []) {
    if (entry && typeof entry.character_id === "string") {
      rows.push({
        character_id: entry.character_id,
        joined_at: typeof entry.joined_at === "string" ? entry.joined_at : null,
      });
    }
  }
  return rows;
}

async function loadShipDefinitions(
  supabase: SupabaseClient,
  shipRows: Array<Record<string, unknown>>,
): Promise<Map<string, ShipDefinitionRow>> {
  const shipTypes = Array.from(
    new Set(
      shipRows
        .map((row) =>
          typeof row.ship_type === "string" ? row.ship_type : null,
        )
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const definitionMap = new Map<string, ShipDefinitionRow>();
  if (!shipTypes.length) {
    return definitionMap;
  }
  const { data, error } = await supabase
    .from("ship_definitions")
    .select(
      "ship_type, display_name, cargo_holds, warp_power_capacity, shields, fighters",
    )
    .in("ship_type", shipTypes);
  if (error) {
    console.error("corporations.ships.definitions", error);
    throw new Error("Failed to load ship definitions");
  }
  for (const row of data ?? []) {
    if (row && typeof row.ship_type === "string") {
      definitionMap.set(row.ship_type, row as ShipDefinitionRow);
    }
  }
  return definitionMap;
}

async function loadControlReadySet(
  supabase: SupabaseClient,
  shipIds: string[],
): Promise<Set<string>> {
  if (!shipIds.length) {
    return new Set();
  }
  const { data, error } = await supabase
    .from("characters")
    .select("character_id")
    .in("character_id", shipIds);
  if (error) {
    console.error("corporations.ships.control_ready", error);
    throw new Error("Failed to inspect ship control state");
  }
  const ready = new Set<string>();
  for (const row of data ?? []) {
    if (row && typeof row.character_id === "string") {
      ready.add(row.character_id);
    }
  }
  return ready;
}

/**
 * Get the effective corporation ID for a character.
 * Checks corporation_members first (for player characters),
 * then falls back to ship ownership (for corp-owned ships like autonomous probes).
 */
export async function getEffectiveCorporationId(
  supabase: SupabaseClient,
  characterId: string,
  shipId?: string | null,
): Promise<string | null> {
  // First check corporation_members (for player characters)
  const { data: memberData } = await supabase
    .from("corporation_members")
    .select("corp_id")
    .eq("character_id", characterId)
    .is("left_at", null)
    .maybeSingle();

  if (memberData?.corp_id) {
    return memberData.corp_id;
  }

  // If not a member and shipId provided, check ship ownership
  if (shipId) {
    const { data: shipData } = await supabase
      .from("ship_instances")
      .select("owner_corporation_id")
      .eq("ship_id", shipId)
      .maybeSingle();

    if (shipData?.owner_corporation_id) {
      return shipData.owner_corporation_id;
    }
  }

  return null;
}
