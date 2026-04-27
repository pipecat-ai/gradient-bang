import type { SupabaseClient } from "@supabase/supabase-js";

import { buildEventSource, emitCharacterEvent } from "./events.ts";
import { emitMovementObservers } from "./movement.ts";
import {
  buildLocalMapRegion,
  buildSectorSnapshot,
  markSectorVisited,
} from "./map.ts";
import {
  loadCharacter,
  loadShip,
  loadShipDefinition,
  type ShipDefinitionRow,
  type ShipRow,
} from "./status.ts";
import { checkGarrisonAutoEngage } from "./garrison_combat.ts";
import {
  CombatantState,
  CombatEncounterState,
  CombatRoundOutcome,
} from "./combat_types.ts";

const MAX_LOCAL_MAP_HOPS = 3;
const MAX_LOCAL_MAP_NODES = 50;

/**
 * Move every successful fleer out of the encounter and emit the full
 * arrival cascade — movement.start, character.moved (depart), the
 * ship_instances.current_sector update, sector visit marking,
 * movement.complete, map.local, character.moved (arrive), a personalized
 * combat.ended, and a garrison auto-engage check at the destination.
 *
 * This runs unconditionally after every round resolves (not only when
 * combat ends) so a fleer is moved + unstuck on the client even when
 * combat continues for the others. Returns the set of character_ids that
 * successfully departed; the caller uses it to suppress duplicate
 * combat.ended emissions on the terminal-round path.
 */
export async function departSuccessfulFleers(params: {
  supabase: SupabaseClient;
  encounter: CombatEncounterState;
  outcome: CombatRoundOutcome;
  requestId: string;
}): Promise<Set<string>> {
  const { supabase, encounter, outcome, requestId } = params;
  const departed = new Set<string>();

  for (const [pid, succeeded] of Object.entries(outcome.flee_results)) {
    if (!succeeded) continue;
    const participant = encounter.participants[pid];
    if (!participant || participant.combatant_type !== "character") continue;

    const destination = participant.fled_to_sector;
    if (typeof destination !== "number") continue;

    try {
      const characterId = await departOne({
        supabase,
        encounter,
        participant,
        destination,
        requestId,
      });
      if (characterId) departed.add(characterId);
    } catch (err) {
      console.error("combat_flee.depart_failed", { pid, err });
    }
  }

  return departed;
}

async function departOne(params: {
  supabase: SupabaseClient;
  encounter: CombatEncounterState;
  participant: CombatantState;
  destination: number;
  requestId: string;
}): Promise<string | null> {
  const { supabase, encounter, participant, destination, requestId } = params;
  const characterId =
    participant.owner_character_id ?? participant.combatant_id;
  const source = buildEventSource("combat.flee", requestId);
  const originSector = encounter.sector_id;

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  const shipDefinition = await loadShipDefinition(supabase, ship.ship_type);

  const playerType =
    ship.owner_type === "corporation" ? "corporation_ship" : "human";

  const observerMetadata = {
    characterId,
    characterName: character.name,
    shipId: ship.ship_id,
    shipName: ship.ship_name ?? shipDefinition.display_name,
    shipType: ship.ship_type,
    corpId: character.corporation_id,
    playerType,
  };

  // Destination snapshot used by movement.start AND mark-visited / map.local.
  const destSnapshot = await buildSectorSnapshot(
    supabase,
    destination,
    characterId,
  );

  // 1. movement.start to fleer (no hyperspace delay — flee is instant).
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "movement.start",
    payload: {
      source,
      sector: destSnapshot,
      hyperspace_time: 0,
      player: { id: characterId, name: character.name },
      move_type: "flee",
    },
    sectorId: originSector,
    shipId: ship.ship_id,
    requestId,
  });

  // 2. character.moved depart at origin (sector + garrison observers).
  await emitMovementObservers({
    supabase,
    sectorId: originSector,
    metadata: observerMetadata,
    movement: "depart",
    source,
    requestId,
    moveType: "flee",
  });

  // 3. Persist the sector change.
  const { error: shipError } = await supabase
    .from("ship_instances")
    .update({ current_sector: destination })
    .eq("ship_id", ship.ship_id);
  if (shipError) {
    console.error("combat_flee.update_ship_sector", {
      ship_id: ship.ship_id,
      destination,
      error: shipError,
    });
    return null;
  }
  ship.current_sector = destination;

  // 4. Mark sector visited (personal knowledge only — corp ships are rare
  // fleers and corp-knowledge merging is an existing limitation of the
  // SupabaseClient-based markSectorVisited helper).
  const { firstVisit, knowledge } = await markSectorVisited(supabase, {
    characterId,
    sectorId: destination,
    sectorSnapshot: destSnapshot,
  });

  // 5. movement.complete to fleer with player + ship snapshots.
  const shipSnapshot = buildShipSnapshot(ship, shipDefinition);
  const playerSnapshot = {
    id: characterId,
    name: character.name,
    player_type: playerType,
  };
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "movement.complete",
    payload: {
      source,
      player: playerSnapshot,
      ship: shipSnapshot,
      sector: destSnapshot,
      first_visit: firstVisit,
      move_type: "flee",
    },
    sectorId: destination,
    shipId: ship.ship_id,
    requestId,
  });

  // 6. map.local for the destination sector.
  const mapRegion = await buildLocalMapRegion(supabase, {
    characterId,
    centerSector: destination,
    mapKnowledge: knowledge,
    maxHops: MAX_LOCAL_MAP_HOPS,
    maxSectors: MAX_LOCAL_MAP_NODES,
  });
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "map.local",
    payload: { ...(mapRegion as Record<string, unknown>), source },
    sectorId: destination,
    shipId: ship.ship_id,
    requestId,
  });

  // 7. character.moved arrive at destination.
  await emitMovementObservers({
    supabase,
    sectorId: destination,
    metadata: observerMetadata,
    movement: "arrive",
    source,
    requestId,
    moveType: "flee",
  });

  // 8. Personalized combat.ended so the fleer's client unsticks from
  // combat state immediately, even when combat continues for others.
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "combat.ended",
    payload: {
      source: buildEventSource("combat.ended", requestId),
      timestamp: new Date().toISOString(),
      combat_id: encounter.combat_id,
      sector: { id: originSector },
      result: `${participant.name}_fled`,
      end: `${participant.name}_fled`,
      ship: shipSnapshot,
    },
    sectorId: originSector,
    shipId: ship.ship_id,
    requestId,
  });

  // 9. Garrison auto-engage at destination — fleeing into a hostile
  // garrison sector should still pull the player into a new combat,
  // mirroring regular movement.
  try {
    await checkGarrisonAutoEngage({
      supabase,
      characterId,
      sectorId: destination,
      requestId,
      character,
      ship,
    });
  } catch (err) {
    console.error("combat_flee.auto_engage_failed", { destination, err });
  }

  return characterId;
}

function buildShipSnapshot(
  ship: ShipRow,
  def: ShipDefinitionRow,
): Record<string, unknown> {
  const cargo = {
    quantum_foam: ship.cargo_qf ?? 0,
    retro_organics: ship.cargo_ro ?? 0,
    neuro_symbolics: ship.cargo_ns ?? 0,
  };
  const cargoUsed =
    cargo.quantum_foam + cargo.retro_organics + cargo.neuro_symbolics;
  return {
    ship_id: ship.ship_id,
    ship_type: ship.ship_type,
    ship_name: ship.ship_name ?? def.display_name,
    owner_type: ship.owner_type === "character" ? "personal" : ship.owner_type,
    owner_corporation_id: ship.owner_corporation_id,
    credits: ship.credits ?? 0,
    cargo,
    cargo_capacity: def.cargo_holds,
    empty_holds: Math.max(def.cargo_holds - cargoUsed, 0),
    warp_power: ship.current_warp_power ?? def.warp_power_capacity,
    warp_power_capacity: def.warp_power_capacity,
    turns_per_warp: def.turns_per_warp,
    shields: ship.current_shields ?? def.shields,
    max_shields: def.shields,
    fighters: ship.current_fighters ?? def.fighters,
    max_fighters: def.fighters,
    sector: ship.current_sector,
  };
}
