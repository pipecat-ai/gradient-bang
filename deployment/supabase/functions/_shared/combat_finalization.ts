import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CombatEncounterState,
  CombatRoundOutcome,
  CombatantState,
} from "./combat_types.ts";
import {
  appendSalvageEntry,
  buildSalvageEntry,
  SalvageEntry,
} from "./salvage.ts";
import {
  emitSectorEnvelope,
  buildEventSource,
  recordEventWithRecipients,
} from "./events.ts";
import { computeEventRecipients } from "./visibility.ts";

interface ShipRow {
  ship_id: string;
  ship_type: string;
  ship_name: string | null;
  current_sector: number | null;
  credits: number;
  cargo_qf: number;
  cargo_ro: number;
  cargo_ns: number;
}

interface ShipDefinitionRow {
  ship_type: string;
  display_name: string;
  purchase_price: number | null;
}

/**
 * Tracks a corp ship that should be deleted AFTER combat.ended payloads are built.
 */
export interface DeferredCorpShipDeletion {
  shipId: string;
  characterId: string;
}

/**
 * Result of handling a defeated character.
 */
interface HandleDefeatedResult {
  salvage: SalvageEntry | null;
  deferredDeletion: DeferredCorpShipDeletion | null;
  shipDestroyedEvent: ShipDestroyedEventData | null;
}

/**
 * Data for ship.destroyed event emission.
 */
interface ShipDestroyedEventData {
  shipId: string;
  shipType: string;
  shipName: string | null;
  playerType: "human" | "corporation_ship";
  playerName: string;
  corpId: string | null;
  salvageCreated: boolean;
}

/**
 * Result of finalizeCombat.
 */
export interface FinalizeCombatResult {
  salvageEntries: SalvageEntry[];
  deferredDeletions: DeferredCorpShipDeletion[];
}

async function loadShip(
  supabase: SupabaseClient,
  shipId: string,
): Promise<ShipRow | null> {
  const { data, error } = await supabase
    .from<ShipRow>("ship_instances")
    .select(
      "ship_id, ship_type, ship_name, current_sector, credits, cargo_qf, cargo_ro, cargo_ns",
    )
    .eq("ship_id", shipId)
    .maybeSingle();
  if (error) {
    console.error("combat_finalization.load_ship", error);
    throw new Error("Failed to load ship state");
  }
  return data ?? null;
}

async function loadShipDefinitionMap(
  supabase: SupabaseClient,
  shipTypes: string[],
): Promise<Map<string, ShipDefinitionRow>> {
  if (!shipTypes.length) {
    return new Map();
  }
  const unique = Array.from(new Set(shipTypes));
  const { data, error } = await supabase
    .from<ShipDefinitionRow>("ship_definitions")
    .select("ship_type, display_name, purchase_price")
    .in("ship_type", unique);
  if (error) {
    console.error("combat_finalization.load_defs", error);
    throw new Error("Failed to load ship definitions");
  }
  return new Map((data ?? []).map((row) => [row.ship_type, row]));
}

async function convertShipToEscapePod(
  supabase: SupabaseClient,
  shipId: string,
): Promise<void> {
  const { error } = await supabase
    .from("ship_instances")
    .update({
      ship_type: "escape_pod",
      ship_name: "Escape Pod",
      current_fighters: 0,
      current_shields: 0,
      current_warp_power: 0,
      cargo_qf: 0,
      cargo_ro: 0,
      cargo_ns: 0,
      credits: 0,
      is_escape_pod: true,
      metadata: {
        former_ship: shipId,
      },
    })
    .eq("ship_id", shipId);
  if (error) {
    console.error("combat_finalization.escape_pod", error);
    throw new Error("Failed to convert ship to escape pod");
  }
}

function buildCargoFromShip(ship: ShipRow): Record<string, number> {
  const cargo: Record<string, number> = {};
  if (ship.cargo_qf > 0) {
    cargo.quantum_foam = ship.cargo_qf;
  }
  if (ship.cargo_ro > 0) {
    cargo.retro_organics = ship.cargo_ro;
  }
  if (ship.cargo_ns > 0) {
    cargo.neuro_symbolics = ship.cargo_ns;
  }
  return cargo;
}

async function handleDefeatedCharacter(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  participant: CombatantState,
  definition: ShipDefinitionRow | undefined,
): Promise<HandleDefeatedResult> {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  const shipId = typeof metadata.ship_id === "string" ? metadata.ship_id : null;
  const playerType = (metadata.player_type as string) ?? "human";
  const isCorpShip = playerType === "corporation_ship";
  const corpId = (metadata.corporation_id as string) ?? null;

  if (!shipId) {
    return { salvage: null, deferredDeletion: null, shipDestroyedEvent: null };
  }

  const ship = await loadShip(supabase, shipId);
  if (!ship) {
    return { salvage: null, deferredDeletion: null, shipDestroyedEvent: null };
  }

  const cargo = buildCargoFromShip(ship);
  const credits = ship.credits ?? 0;
  const scrapBase = definition?.purchase_price ?? 0;
  const scrap = Math.max(5, Math.floor(scrapBase / 1000));
  const hasSalvage = Object.keys(cargo).length > 0 || scrap > 0 || credits > 0;

  let salvage: SalvageEntry | null = null;
  if (hasSalvage) {
    salvage = buildSalvageEntry(
      { ship_name: ship.ship_name, ship_type: ship.ship_type },
      definition?.display_name ?? ship.ship_type,
      cargo,
      scrap,
      credits,
      {
        combat_id: encounter.combat_id,
        ship_type: ship.ship_type,
      },
    );
    await appendSalvageEntry(supabase, encounter.sector_id, salvage);
  }

  // Build ship.destroyed event data (always emit, regardless of salvage)
  const shipDestroyedEvent: ShipDestroyedEventData = {
    shipId,
    shipType: ship.ship_type,
    shipName: ship.ship_name,
    playerType: isCorpShip ? "corporation_ship" : "human",
    playerName: participant.name,
    corpId,
    salvageCreated: salvage !== null,
  };

  // Handle ship destruction differently for corp ships vs human ships
  if (isCorpShip) {
    // Corp ships: update ship state to reflect destruction (but don't convert to escape pod)
    // This ensures combat.ended payload shows destroyed state when loaded from DB
    await supabase
      .from("ship_instances")
      .update({
        current_fighters: 0,
        current_shields: 0,
      })
      .eq("ship_id", shipId);

    // Defer deletion until after combat.ended payloads are built
    const characterId =
      participant.owner_character_id ?? participant.combatant_id;
    return {
      salvage,
      deferredDeletion: { shipId, characterId },
      shipDestroyedEvent,
    };
  } else {
    // Human ships: convert to escape pod immediately
    await convertShipToEscapePod(supabase, shipId);
    return {
      salvage,
      deferredDeletion: null,
      shipDestroyedEvent,
    };
  }
}

async function updateGarrisonState(
  supabase: SupabaseClient,
  participant: CombatantState,
  remainingFighters: number,
): Promise<void> {
  const ownerId = participant.owner_character_id;
  if (!ownerId) {
    return;
  }
  if (remainingFighters > 0) {
    const { error } = await supabase
      .from("garrisons")
      .update({
        fighters: remainingFighters,
        updated_at: new Date().toISOString(),
      })
      .eq("sector_id", participant.metadata?.sector_id ?? null)
      .eq("owner_id", ownerId);
    if (error) {
      console.error("combat_finalization.update_garrison", error);
    }
    return;
  }
  const { error } = await supabase
    .from("garrisons")
    .delete()
    .eq("sector_id", participant.metadata?.sector_id ?? null)
    .eq("owner_id", ownerId);
  if (error) {
    console.error("combat_finalization.remove_garrison", error);
  }
}

export async function finalizeCombat(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  requestId?: string,
): Promise<FinalizeCombatResult> {
  const salvageEntries: SalvageEntry[] = [];
  const deferredDeletions: DeferredCorpShipDeletion[] = [];
  const defeated = Object.entries(outcome.fighters_remaining ?? {}).filter(
    ([pid, remaining]) => remaining <= 0,
  );
  const shipTypes = defeated
    .map(([pid]) => encounter.participants[pid])
    .filter((participant): participant is CombatantState =>
      Boolean(participant),
    )
    .map((participant) => participant.ship_type ?? "")
    .filter(Boolean);
  const definitionMap = await loadShipDefinitionMap(supabase, shipTypes);

  for (const [pid] of defeated) {
    const participant = encounter.participants[pid];
    if (!participant || participant.combatant_type !== "character") {
      if (participant?.combatant_type === "garrison") {
        await updateGarrisonState(
          supabase,
          participant,
          outcome.fighters_remaining?.[pid] ?? 0,
        );
      }
      continue;
    }

    const def = participant.ship_type
      ? definitionMap.get(participant.ship_type)
      : undefined;
    const result = await handleDefeatedCharacter(
      supabase,
      encounter,
      participant,
      def,
    );

    if (result.salvage) {
      salvageEntries.push(result.salvage);

      // Emit salvage.created event to all sector occupants
      const timestamp = new Date().toISOString();
      await emitSectorEnvelope({
        supabase,
        sectorId: encounter.sector_id,
        eventType: "salvage.created",
        payload: {
          source: buildEventSource(
            "combat.ended",
            requestId ?? `combat:${encounter.combat_id}`,
          ),
          timestamp,
          salvage_id: result.salvage.salvage_id,
          sector: { id: encounter.sector_id },
          cargo: result.salvage.cargo,
          scrap: result.salvage.scrap,
          credits: result.salvage.credits,
          from_ship_type: result.salvage.source.ship_type,
          from_ship_name: result.salvage.source.ship_name,
        },
        requestId: requestId ?? `combat:${encounter.combat_id}`,
      });
    }

    // Emit ship.destroyed event (always, regardless of salvage)
    if (result.shipDestroyedEvent) {
      await emitShipDestroyedEvent(
        supabase,
        encounter,
        result.shipDestroyedEvent,
        requestId ?? `combat:${encounter.combat_id}`,
      );
    }

    if (result.deferredDeletion) {
      deferredDeletions.push(result.deferredDeletion);
      // DON'T update participant.ship_type for corp ships - they won't become escape pods
    } else {
      // Update participant state to reflect escape pod conversion for event payload
      participant.ship_type = "escape_pod";
      participant.fighters = 0;
    }
  }

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    if (participant.combatant_type !== "garrison") {
      continue;
    }
    const remaining = outcome.fighters_remaining?.[pid] ?? participant.fighters;
    await updateGarrisonState(supabase, participant, remaining);
  }

  return { salvageEntries, deferredDeletions };
}

/**
 * Emit ship.destroyed event with sector + corp visibility.
 */
async function emitShipDestroyedEvent(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  data: ShipDestroyedEventData,
  requestId: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const payload = {
    source: buildEventSource("ship.destroyed", requestId),
    timestamp,
    ship_id: data.shipId,
    ship_type: data.shipType,
    ship_name: data.shipName,
    player_type: data.playerType,
    player_name: data.playerName,
    sector: { id: encounter.sector_id },
    combat_id: encounter.combat_id,
    salvage_created: data.salvageCreated,
  };

  // Compute recipients: sector observers + corp members (if any)
  const recipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds: data.corpId ? [data.corpId] : [],
  });

  if (recipients.length > 0) {
    await recordEventWithRecipients({
      supabase,
      eventType: "ship.destroyed",
      scope: "sector",
      payload,
      requestId,
      sectorId: encounter.sector_id,
      actorCharacterId: null, // System-originated
      recipients,
    });
  }
}

/**
 * Execute deferred corp ship deletions.
 * Call this AFTER combat.ended events have been emitted.
 */
export async function executeCorpShipDeletions(
  supabase: SupabaseClient,
  deletions: DeferredCorpShipDeletion[],
): Promise<void> {
  for (const { shipId, characterId } of deletions) {
    console.log("combat_finalization.deleting_corp_ship", {
      shipId,
      characterId,
    });

    // 1. Null out current_ship_id to break FK constraint
    const { error: unlinkError } = await supabase
      .from("characters")
      .update({ current_ship_id: null })
      .eq("character_id", characterId);
    if (unlinkError) {
      console.error("combat_finalization.unlink_ship", {
        characterId,
        error: unlinkError,
      });
    }

    // 2. Delete pseudo-character record
    const { error: charError } = await supabase
      .from("characters")
      .delete()
      .eq("character_id", characterId);
    if (charError) {
      console.error("combat_finalization.delete_character", {
        characterId,
        error: charError,
      });
    }

    // 3. Delete ship instance
    const { error: shipError } = await supabase
      .from("ship_instances")
      .delete()
      .eq("ship_id", shipId);
    if (shipError) {
      console.error("combat_finalization.delete_ship", {
        shipId,
        error: shipError,
      });
    }
  }
}
