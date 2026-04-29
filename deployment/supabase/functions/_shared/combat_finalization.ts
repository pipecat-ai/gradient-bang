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
  emitCharacterEvent,
  buildEventSource,
  recordBroadcastByCorp,
} from "./events.ts";
import { computeEventRecipients } from "./visibility.ts";
import { buildSectorGarrisonMapUpdate } from "./map.ts";
import { getCorpIdsFromParticipants } from "./combat_events.ts";
import { fetchActiveTaskIdsByShip } from "./tasks.ts";

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
  warp_power_capacity: number;
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
  ownerCharacterId: string;
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
    .select("ship_type, display_name, purchase_price, warp_power_capacity")
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
  shipDefs: Map<string, ShipDefinitionRow>,
): Promise<void> {
  const escapePodDef = shipDefs.get("escape_pod");
  const warpPower = escapePodDef?.warp_power_capacity ?? 800;

  const { error } = await supabase
    .from("ship_instances")
    .update({
      ship_type: "escape_pod",
      ship_name: "Escape Pod",
      current_fighters: 0,
      current_shields: 0,
      current_warp_power: warpPower,
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
  shipDefs: Map<string, ShipDefinitionRow>,
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
    ownerCharacterId:
      participant.owner_character_id ?? participant.combatant_id,
    corpId,
    salvageCreated: salvage !== null,
  };

  // Handle ship destruction differently for corp ships vs human ships
  if (isCorpShip) {
    // Corp ships: mark as destroyed immediately (not converted to escape pod).
    // We set destroyed_at here so the ship is removed from active queries even
    // if the deferred pseudo-character cleanup in executeCorpShipDeletions fails
    // (e.g. due to an error during combat.ended event emission).
    await supabase
      .from("ship_instances")
      .update({
        current_fighters: 0,
        current_shields: 0,
        destroyed_at: new Date().toISOString(),
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
    await convertShipToEscapePod(supabase, shipId, shipDefs);
    return {
      salvage,
      deferredDeletion: null,
      shipDestroyedEvent,
    };
  }
}

async function updateGarrisonState(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  participant: CombatantState,
  remainingFighters: number,
  requestId: string,
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
  // garrison.destroyed already fired in emitNewlyDefeatedDestructions when
  // this garrison's fighters first hit 0 (mid-round). Don't re-announce —
  // just do the row deletion and the post-delete map.update so the
  // garrison disappears from observers' map data.
  const { error } = await supabase
    .from("garrisons")
    .delete()
    .eq("sector_id", participant.metadata?.sector_id ?? null)
    .eq("owner_id", ownerId);
  if (error) {
    console.error("combat_finalization.remove_garrison", error);
  }
  // After the row is gone, emit a map.update so the garrison disappears
  // from the owner's (and corp-mates') map view. Mirrors the pattern used
  // by combat_disband_garrison / combat_collect_fighters when a garrison
  // is removed. Done post-delete so buildSectorGarrisonMapUpdate captures
  // the absence (garrison: null). Wrapped to ensure a map.update failure
  // can never abort combat resolution — the rest of the cascade
  // (round_resolved / combat.ended / ship.destroyed) must still fire.
  try {
    await emitGarrisonRemovedMapUpdate(
      supabase,
      encounter,
      participant,
      requestId,
    );
  } catch (err) {
    console.error("combat_finalization.garrison_map_update.failed", err);
  }
}

async function emitGarrisonRemovedMapUpdate(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  participant: CombatantState,
  requestId: string,
): Promise<void> {
  const ownerCharacterId =
    typeof participant.owner_character_id === "string"
      ? participant.owner_character_id
      : null;

  const mapUpdatePayload = await buildSectorGarrisonMapUpdate(
    supabase,
    encounter.sector_id,
  );

  // Broaden recipients beyond the garrison's own corp: every combat
  // stakeholder (the attacker who just destroyed it, plus any other
  // participating ships/garrisons by corp) and any sector observer
  // needs the map to drop the garrison icon. Without this the
  // attacker's UI keeps painting a phantom garrison until the next
  // sector load.
  const stakeholderCorpIds = getCorpIdsFromParticipants(
    encounter.participants,
  );
  const directRecipients = ownerCharacterId ? [ownerCharacterId] : [];
  const recipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds: stakeholderCorpIds,
    directRecipients,
  });
  if (recipients.length === 0) return;

  await recordBroadcastByCorp({
    supabase,
    eventType: "map.update",
    scope: "sector",
    payload: {
      source: buildEventSource("combat.garrison_destroyed", requestId),
      ...(mapUpdatePayload as Record<string, unknown>),
    },
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null,
    recipients,
    stakeholderCorpIds,
  });
}

export async function emitGarrisonDestroyedEvent(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  participant: CombatantState,
  requestId: string,
): Promise<void> {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  const ownerCharacterId =
    participant.owner_character_id ?? participant.combatant_id;
  const ownerCorpId =
    typeof metadata.owner_corporation_id === "string"
      ? metadata.owner_corporation_id
      : null;
  const ownerName =
    typeof metadata.owner_name === "string" ? metadata.owner_name : ownerCharacterId;
  const mode = typeof metadata.mode === "string" ? metadata.mode : "offensive";
  const timestamp = new Date().toISOString();
  const payload = {
    source: buildEventSource("garrison.destroyed", requestId),
    timestamp,
    combat_id: encounter.combat_id,
    combatant_id: participant.combatant_id,
    garrison_id: participant.combatant_id,
    owner_character_id: ownerCharacterId,
    owner_corp_id: ownerCorpId,
    owner_name: ownerName,
    sector: { id: encounter.sector_id },
    mode,
  };

  const stakeholderCorpIds = ownerCorpId ? [ownerCorpId] : [];
  const recipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds: stakeholderCorpIds,
    directRecipients: [ownerCharacterId],
  });

  if (recipients.length > 0) {
    await recordBroadcastByCorp({
      supabase,
      eventType: "garrison.destroyed",
      scope: "sector",
      payload,
      requestId,
      sectorId: encounter.sector_id,
      actorCharacterId: null,
      recipients,
      stakeholderCorpIds,
    });
  }
}

/**
 * Build a ship.destroyed event payload from the in-memory participant state,
 * for mid-round emission. salvage_created defaults to false because salvage
 * isn't dropped until terminal cleanup runs in finalizeCombat — a separate
 * salvage.created event will fire then if applicable.
 */
function buildMidCombatShipDestroyedData(
  participant: CombatantState,
): ShipDestroyedEventData | null {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  const shipId = typeof metadata.ship_id === "string"
    ? metadata.ship_id
    : null;
  if (!shipId) return null;
  const playerType: "human" | "corporation_ship" =
    metadata.player_type === "corporation_ship" ? "corporation_ship" : "human";
  return {
    shipId,
    shipType:
      participant.ship_type ??
      (typeof metadata.ship_type === "string" ? metadata.ship_type : "unknown"),
    shipName:
      typeof metadata.ship_name === "string" ? metadata.ship_name : null,
    playerType,
    playerName: participant.name,
    ownerCharacterId:
      participant.owner_character_id ?? participant.combatant_id,
    corpId:
      typeof metadata.corporation_id === "string"
        ? metadata.corporation_id
        : null,
    salvageCreated: false,
  };
}

/**
 * Emit ship.destroyed / garrison.destroyed for any participant whose fighters
 * dropped to 0 this round. Called at the top of every resolveEncounterRound
 * pass, including the terminal one — so by the time finalizeCombat runs the
 * cleanup, every defeated participant has already had its destruction
 * announced. finalizeCombat therefore does NOT re-emit these events; it
 * only handles the underlying cleanup (escape pod conversion, garrison row
 * deletion, salvage drop) and the corresponding salvage.created event.
 */
export async function emitNewlyDefeatedDestructions(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  requestId: string,
): Promise<void> {
  const fightersRemaining = outcome.fighters_remaining ?? {};
  const newlyDefeated: string[] = [];
  for (const [pid, remaining] of Object.entries(fightersRemaining)) {
    const remainingNum = Number(remaining);
    if (!Number.isFinite(remainingNum) || remainingNum > 0) continue;
    const previousFighters = encounter.participants[pid]?.fighters ?? 0;
    if (previousFighters <= 0) continue; // already dead before this round
    newlyDefeated.push(pid);
  }
  if (newlyDefeated.length === 0) return;

  // Batch lookup: any active task running on a ship that's about to be
  // destroyed needs to be cancelled, otherwise the TaskAgent keeps stepping
  // a non-existent ship. Done before the per-pid loop so a single events
  // query covers every defeated ship in this round.
  const newlyDefeatedShipIds: string[] = [];
  for (const pid of newlyDefeated) {
    const participant = encounter.participants[pid];
    if (participant?.combatant_type !== "character") continue;
    const shipId = (participant.metadata as Record<string, unknown> | undefined)
      ?.ship_id;
    if (typeof shipId === "string" && shipId) {
      newlyDefeatedShipIds.push(shipId);
    }
  }
  let activeTasksByShip: Map<string, string | null> = new Map();
  if (newlyDefeatedShipIds.length > 0) {
    try {
      activeTasksByShip = await fetchActiveTaskIdsByShip(
        supabase,
        newlyDefeatedShipIds,
      );
    } catch (err) {
      console.error("combat_finalization.fetch_active_tasks.failed", err);
    }
  }

  for (const pid of newlyDefeated) {
    const participant = encounter.participants[pid];
    if (!participant) continue;
    try {
      if (participant.combatant_type === "garrison") {
        await emitGarrisonDestroyedEvent(
          supabase,
          encounter,
          participant,
          requestId,
        );
      } else if (participant.combatant_type === "character") {
        const data = buildMidCombatShipDestroyedData(participant);
        if (data) {
          await emitShipDestroyedEvent(supabase, encounter, data, requestId);
          await cancelTaskOnDestroyedShip(
            supabase,
            data,
            activeTasksByShip.get(data.shipId) ?? null,
            requestId,
          );
        }
      }
    } catch (err) {
      console.error("combat_finalization.mid_round_destruction.failed", {
        pid,
        err: String(err),
      });
    }
  }
}

/**
 * If the destroyed ship has an active task, emit task.cancel so its
 * TaskAgent stops stepping. Failures are logged but never thrown — combat
 * resolution must not abort because a cancel emission failed.
 */
async function cancelTaskOnDestroyedShip(
  supabase: SupabaseClient,
  data: ShipDestroyedEventData,
  activeTaskId: string | null,
  requestId: string,
): Promise<void> {
  if (!activeTaskId) return;
  try {
    await emitCharacterEvent({
      supabase,
      characterId: data.ownerCharacterId,
      eventType: "task.cancel",
      payload: {
        source: buildEventSource("combat.ship_destroyed", requestId),
        task_id: activeTaskId,
        cancelled_by: null,
      },
      requestId,
      taskId: activeTaskId,
      recipientReason: "task_owner",
      scope: "self",
      corpId: data.corpId ?? undefined,
    });
  } catch (err) {
    console.error("combat_finalization.task_cancel.failed", {
      ship_id: data.shipId,
      task_id: activeTaskId,
      err: String(err),
    });
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
  // Include escape_pod so we can look up its warp_power_capacity
  if (!shipTypes.includes("escape_pod")) {
    shipTypes.push("escape_pod");
  }
  const definitionMap = await loadShipDefinitionMap(supabase, shipTypes);

  // Destruction events (ship.destroyed / garrison.destroyed) already fired
  // mid-round via emitNewlyDefeatedDestructions in resolveEncounterRound,
  // including for participants that died THIS terminal round. finalizeCombat
  // therefore handles only the cleanup side — escape pod conversion,
  // garrison row deletion, salvage drop, and the salvage.created event.
  for (const [pid] of defeated) {
    const participant = encounter.participants[pid];
    if (!participant || participant.combatant_type !== "character") {
      if (participant?.combatant_type === "garrison") {
        await updateGarrisonState(
          supabase,
          encounter,
          participant,
          outcome.fighters_remaining?.[pid] ?? 0,
          requestId ?? `combat:${encounter.combat_id}`,
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
      definitionMap,
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

    // ship.destroyed already fired in emitNewlyDefeatedDestructions when
    // this ship's fighters first hit 0 (mid-round). The result struct is
    // still consumed below for deferredDeletion / escape-pod bookkeeping.

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
    if (participant.combatant_type === "garrison") {
      const remaining = outcome.fighters_remaining?.[pid] ?? participant.fighters;
      // Defeated garrisons (remaining <= 0) are handled in the defeated
      // loop above — running updateGarrisonState a second time would
      // emit garrison.destroyed twice. Only update survivors here.
      if (remaining <= 0) continue;
      await updateGarrisonState(
        supabase,
        encounter,
        participant,
        remaining,
        requestId ?? `combat:${encounter.combat_id}`,
      );
      continue;
    }

    // Persist surviving character ships' fighters/shields to ship_instances
    if (participant.combatant_type === "character") {
      const remainingFighters = outcome.fighters_remaining?.[pid];
      if (remainingFighters === undefined || remainingFighters <= 0) {
        // Defeated ships are already handled above (escape pod conversion)
        continue;
      }
      const shipId = participant.metadata?.ship_id as string | undefined;
      if (!shipId) continue;
      const remainingShields = outcome.shields_remaining?.[pid] ?? participant.shields;
      const { error } = await supabase
        .from("ship_instances")
        .update({
          current_fighters: remainingFighters,
          current_shields: remainingShields,
        })
        .eq("ship_id", shipId);
      if (error) {
        console.error("combat_finalization.update_surviving_ship", { shipId, error });
      }
    }
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
    owner_character_id: data.ownerCharacterId,
    corp_id: data.corpId,
  };

  const stakeholderCorpIds = data.corpId ? [data.corpId] : [];
  const recipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds: stakeholderCorpIds,
  });

  if (recipients.length > 0) {
    await recordBroadcastByCorp({
      supabase,
      eventType: "ship.destroyed",
      scope: "sector",
      payload,
      requestId,
      sectorId: encounter.sector_id,
      actorCharacterId: null,
      recipients,
      stakeholderCorpIds,
    });
  }
}

/**
 * Execute deferred corp ship cleanup.
 * Call this AFTER combat.ended events have been emitted.
 *
 * Soft-deletes the ship (sets destroyed_at) rather than hard-deleting,
 * because events and port_transactions have FK references to ship_id
 * with NO ACTION constraints that block deletion.
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

    // 3. Soft-delete ship instance (preserves current_sector for destruction history)
    const { error: shipError } = await supabase
      .from("ship_instances")
      .update({ destroyed_at: new Date().toISOString() })
      .eq("ship_id", shipId);
    if (shipError) {
      console.error("combat_finalization.soft_delete_ship", {
        shipId,
        error: shipError,
      });
    }

    // 4. Remove from corporation_ships so it no longer appears in active ship lists
    const { error: corpShipError } = await supabase
      .from("corporation_ships")
      .delete()
      .eq("ship_id", shipId);
    if (corpShipError) {
      console.error("combat_finalization.remove_corp_ship", {
        shipId,
        error: corpShipError,
      });
    }
  }
}
