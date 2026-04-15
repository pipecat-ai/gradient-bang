import type { SupabaseClient } from "@supabase/supabase-js";

import type { MapKnowledge } from "./map.ts";

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

