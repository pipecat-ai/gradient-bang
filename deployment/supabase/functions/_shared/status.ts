import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildSectorSnapshot,
  MapKnowledge,
  normalizeMapKnowledge,
  loadMapKnowledge,
} from "./map.ts";

export interface CharacterRow {
  character_id: string;
  name: string;
  current_ship_id: string;
  credits_in_megabank: number;
  map_knowledge: unknown;
  player_metadata: Record<string, unknown> | null;
  first_visit: string;
  last_active: string;
  corporation_id: string | null;
  corporation_joined_at: string | null;
}

export interface ShipRow {
  ship_id: string;
  owner_id: string | null;
  owner_type: "character" | "corporation" | "unowned";
  owner_character_id: string | null;
  owner_corporation_id: string | null;
  acquired: string | null;
  became_unowned: string | null;
  former_owner_name: string | null;
  ship_type: string;
  ship_name: string | null;
  current_sector: number;
  hyperspace_destination: number | null;
  hyperspace_eta: string | null;
  in_hyperspace: boolean;
  credits: number;
  cargo_qf: number;
  cargo_ro: number;
  cargo_ns: number;
  current_warp_power: number;
  current_shields: number;
  current_fighters: number;
}

export interface ShipDefinitionRow {
  ship_type: string;
  display_name: string;
  cargo_holds: number;
  warp_power_capacity: number;
  turns_per_warp: number;
  shields: number;
  fighters: number;
  purchase_price: number;
}

let cachedUniverseSize: number | null = null;
const CORPORATION_CACHE_TTL_MS = 60_000;
const corporationCache = new Map<
  string,
  { summary: CorporationSummary; expiresAt: number }
>();

interface CorporationSummary {
  corp_id: string;
  name: string;
  member_count: number;
}

async function loadUniverseSize(supabase: SupabaseClient): Promise<number> {
  if (cachedUniverseSize !== null) {
    return cachedUniverseSize;
  }
  const { data, error } = await supabase
    .from("universe_config")
    .select("sector_count")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to load universe_config: ${error.message}`);
  }
  cachedUniverseSize = data?.sector_count ?? 0;
  return cachedUniverseSize;
}

async function loadCorporationSummary(
  supabase: SupabaseClient,
  corpId: string,
): Promise<CorporationSummary | null> {
  if (!corpId) {
    return null;
  }
  const cached = corporationCache.get(corpId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }

  const { data: corpRow, error: corpError } = await supabase
    .from("corporations")
    .select("corp_id, name")
    .eq("corp_id", corpId)
    .maybeSingle();
  if (corpError) {
    console.error("status.corporation.load", corpError);
    return null;
  }
  if (!corpRow) {
    return null;
  }

  const { count, error: memberError } = await supabase
    .from("corporation_members")
    .select("character_id", { count: "exact", head: true })
    .eq("corp_id", corpId);
  if (memberError) {
    console.error("status.corporation.members", memberError);
  }

  const summary: CorporationSummary = {
    corp_id: corpRow.corp_id,
    name: corpRow.name,
    member_count: count ?? 0,
  };
  corporationCache.set(corpId, {
    summary,
    expiresAt: Date.now() + CORPORATION_CACHE_TTL_MS,
  });
  return summary;
}

export async function loadCharacter(
  supabase: SupabaseClient,
  characterId: string,
): Promise<CharacterRow> {
  const { data, error } = await supabase
    .from("characters")
    .select(
      `character_id, name, current_ship_id, credits_in_megabank, map_knowledge, player_metadata, first_visit, last_active,
       corporation_id, corporation_joined_at`,
    )
    .eq("character_id", characterId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `failed to load character ${characterId}: ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(`character ${characterId} not found`);
  }
  if (!data.current_ship_id) {
    throw new Error(`character ${characterId} does not have an assigned ship`);
  }
  return data as CharacterRow;
}

export async function loadShip(
  supabase: SupabaseClient,
  shipId: string,
): Promise<ShipRow> {
  const { data, error } = await supabase
    .from("ship_instances")
    .select(
      `ship_id, owner_id, owner_type, owner_character_id, owner_corporation_id, acquired, became_unowned, former_owner_name,
       ship_type, ship_name, current_sector, hyperspace_destination, hyperspace_eta, in_hyperspace, credits, cargo_qf, cargo_ro, cargo_ns, current_warp_power, current_shields, current_fighters`,
    )
    .eq("ship_id", shipId)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to load ship ${shipId}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`ship ${shipId} not found`);
  }
  return data as ShipRow;
}

export async function loadShipDefinition(
  supabase: SupabaseClient,
  shipType: string,
): Promise<ShipDefinitionRow> {
  const { data, error } = await supabase
    .from("ship_definitions")
    .select(
      "ship_type, display_name, cargo_holds, warp_power_capacity, turns_per_warp, shields, fighters, purchase_price",
    )
    .eq("ship_type", shipType)
    .maybeSingle();
  if (error) {
    throw new Error(
      `failed to load ship definition ${shipType}: ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(`ship definition ${shipType} missing`);
  }
  return data as ShipDefinitionRow;
}

export function resolvePlayerType(
  metadata: Record<string, unknown> | null | undefined,
): string {
  if (metadata && typeof metadata === "object") {
    const candidate = metadata["player_type"];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }
  return "human";
}

export function resolveScope(
  shipOwnerType: string | null | undefined,
  playerType: string | null | undefined,
): "player" | "corporation" {
  if (shipOwnerType === "corporation" || playerType === "corporation_ship") {
    return "corporation";
  }
  return "player";
}

export function buildPlayerSnapshot(
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

export function buildPublicPlayerSnapshotFromStatus(
  statusPayload: Record<string, unknown>,
): Record<string, unknown> {
  const player = (statusPayload["player"] ?? {}) as Record<string, unknown>;
  const ship = (statusPayload["ship"] ?? {}) as Record<string, unknown>;

  const displayName =
    typeof player["name"] === "string" ? (player["name"] as string) : null;
  const canonicalId =
    typeof player["id"] === "string" ? (player["id"] as string) : null;
  const playerId = displayName ?? canonicalId;

  const shipType =
    typeof ship["ship_type"] === "string"
      ? (ship["ship_type"] as string)
      : null;
  const shipName =
    (typeof ship["ship_name"] === "string"
      ? (ship["ship_name"] as string)
      : null) ??
    (typeof ship["display_name"] === "string"
      ? (ship["display_name"] as string)
      : null) ??
    shipType;
  const shipId =
    typeof ship["ship_id"] === "string" ? (ship["ship_id"] as string) : null;

  return {
    created_at: player["created_at"] ?? null,
    id: playerId,
    name: displayName ?? canonicalId,
    player_type: player["player_type"] ?? "human",
    corporation: Object.prototype.hasOwnProperty.call(player, "corporation")
      ? player["corporation"]
      : null,
    ship: {
      ship_id: shipId,
      ship_type: shipType,
      ship_name: shipName,
    },
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

export async function buildStatusPayload(
  supabase: SupabaseClient,
  characterId: string,
): Promise<Record<string, unknown>> {
  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  const definition = await loadShipDefinition(supabase, ship.ship_type);
  // Load merged knowledge (with source field set on each entry)
  const knowledge = await loadMapKnowledge(supabase, characterId);
  const universeSize = await loadUniverseSize(supabase);
  const playerType = resolvePlayerType(character.player_metadata);
  const player = buildPlayerSnapshot(
    character,
    playerType,
    knowledge,
    universeSize,
  );
  const shipSnapshot = buildShipSnapshot(ship, definition);
  const sectorSnapshot = await buildSectorSnapshot(
    supabase,
    ship.current_sector ?? 0,
    characterId,
  );

  let corporationPayload: Record<string, unknown> | null = null;
  if (character.corporation_id) {
    const summary = await loadCorporationSummary(
      supabase,
      character.corporation_id,
    );
    if (summary) {
      corporationPayload = {
        ...summary,
        joined_at: character.corporation_joined_at,
      };
    }
  }

  return {
    player,
    ship: shipSnapshot,
    sector: sectorSnapshot,
    corporation: corporationPayload,
  };
}
