import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CombatEncounterState,
  CombatRoundOutcome,
  CombatantState,
  PendingCorpShipDeletion,
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
import { persistCombatState } from "./combat_state.ts";

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
}

/**
 * Result of finalizeCombat.
 */
export interface FinalizeCombatResult {
  salvageEntries: SalvageEntry[];
  deferredDeletions: DeferredCorpShipDeletion[];
}

/**
 * Eject every newly-destroyed character participant from the live combat:
 * capture their salvage onto the encounter blob (NOT dropped to the sector
 * yet), convert player ships to escape pods, run pseudo-character cleanup
 * for corp ships, mark destruction_handled, and emit a personalized
 * combat.ended for player ships so their UI exits combat.
 *
 * The participant entry STAYS in encounter.participants flagged as
 * destroyed — observers keep seeing them in subsequent round payloads with
 * the destroyed flag, so the LLM doesn't misinterpret a missing entry as
 * having fled. The defensive filters in combat_engine / combat_action /
 * collectParticipantIds make sure being-in-the-list doesn't translate into
 * being targetable or able to act.
 *
 * Skipped when combat is ending — finalize handles terminal-round deaths.
 */
export async function ejectDestroyedFromCombat(params: {
  supabase: SupabaseClient;
  encounter: CombatEncounterState;
  outcome: CombatRoundOutcome;
  requestId: string;
  departedFleers: Set<string>;
}): Promise<Set<string>> {
  const { supabase, encounter, outcome, requestId, departedFleers } = params;
  const ejected = new Set<string>();

  // Collect newly-destroyed character participants (died this round, not
  // already ejected, not a successful fleer).
  const newlyDestroyed: Array<{ pid: string; participant: CombatantState }> =
    [];
  for (const [pid, participant] of Object.entries(encounter.participants)) {
    if (participant.combatant_type !== "character") continue;
    if (participant.destruction_handled) continue;
    const remaining = outcome.fighters_remaining?.[pid] ?? participant.fighters;
    if ((remaining ?? 0) > 0) continue;
    const ownerCharId =
      participant.owner_character_id ?? participant.combatant_id;
    if (departedFleers.has(ownerCharId)) continue;
    newlyDestroyed.push({ pid, participant });
  }

  if (newlyDestroyed.length === 0) return ejected;

  // Lazy-load definitions: only needed for player-ship escape-pod conversion.
  let definitionMap: Map<string, ShipDefinitionRow> | null = null;
  const ensureDefinitionMap = async (): Promise<Map<string, ShipDefinitionRow>> => {
    if (definitionMap) return definitionMap;
    const types = ["escape_pod"];
    for (const { participant } of newlyDestroyed) {
      if (participant.ship_type) types.push(participant.ship_type);
    }
    definitionMap = await loadShipDefinitionMap(supabase, types);
    return definitionMap;
  };

  for (const { pid, participant } of newlyDestroyed) {
    try {
      const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
      const shipId =
        typeof metadata.ship_id === "string" ? metadata.ship_id : null;
      if (!shipId) {
        // Nothing we can do for a participant without a ship_id; just flag.
        participant.destruction_handled = true;
        ejected.add(pid);
        continue;
      }
      const playerType = (metadata.player_type as string) ?? "human";
      const isCorpShip = playerType === "corporation_ship";

      const def = participant.ship_type
        ? (await ensureDefinitionMap()).get(participant.ship_type)
        : undefined;

      // 1. Capture salvage onto the encounter blob (NOT dropped yet). The
      // capture is idempotent on participant.salvage_captured, so a retry
      // after the persist below skips and proceeds directly to conversion.
      const captured = await captureSalvageForDefeatedShip(
        supabase,
        encounter,
        participant,
        def,
      );

      // Persist the combat blob now so the captured salvage entry +
      // salvage_captured flag are durable before the destructive cargo-zero
      // write below. Without this, a retry between conversion and the final
      // persistCombatState at the end of resolveEncounterRound would either
      // lose the salvage entry (in-memory only) or, with stale
      // salvage_captured=false, capture again and duplicate the entry.
      if (captured) {
        await persistCombatState(supabase, encounter);
      }

      // 2. Apply destruction to canonical tables. For player ships this is
      // the escape-pod conversion. For corp ships this is a noop here (the
      // previous-PR helper persistRoundOutcomeToCanonicalTables already wrote
      // destroyed_at + zeroed fighters/shields).
      const defs = await ensureDefinitionMap();
      await applyShipDestructionToCanonicalTables(supabase, participant, defs);

      // 3. Corp ship: drain the matching entry from pending_corp_ship_deletions
      // and run executeCorpShipDeletions for just that one ship. Pseudo-character
      // and corporation_ships row removal happens here, not at end of combat.
      if (isCorpShip) {
        encounter.pending_corp_ship_deletions ??= [];
        const idx = encounter.pending_corp_ship_deletions.findIndex(
          (entry) => entry.ship_id === shipId,
        );
        if (idx >= 0) {
          const entry = encounter.pending_corp_ship_deletions[idx];
          encounter.pending_corp_ship_deletions.splice(idx, 1);
          try {
            await executeCorpShipDeletions(supabase, [
              { shipId: entry.ship_id, characterId: entry.character_id },
            ]);
          } catch (err) {
            // Re-queue so finalize gets another chance — destroyed_at is
            // already set on the ship row, so the corp-ship is filtered
            // out of active queries even if deletion fails here.
            encounter.pending_corp_ship_deletions.push(entry);
            console.error("combat_finalization.eject_corp_cleanup", {
              shipId,
              err,
            });
          }
        }
      }

      // 4. Mark destruction_handled now that all DB side-effects committed.
      participant.destruction_handled = true;

      // 5. Personalized combat.ended for player ships only — corp ships have
      // no client to notify; their corp members already get ship.destroyed
      // from emitNewlyDefeatedDestructions.
      if (!isCorpShip) {
        const characterId =
          participant.owner_character_id ?? participant.combatant_id;
        try {
          const postShip = await loadShip(supabase, shipId);
          let shipSnapshot: Record<string, unknown> | undefined;
          if (postShip) {
            const escapePodDef = (await ensureDefinitionMap()).get("escape_pod");
            const podDef = escapePodDef ?? def;
            if (podDef) {
              shipSnapshot = buildShipSnapshotForEjectedPlayer(postShip, podDef);
            }
          }
          await emitCharacterEvent({
            supabase,
            characterId,
            eventType: "combat.ended",
            payload: {
              source: buildEventSource("combat.ended", requestId),
              timestamp: new Date().toISOString(),
              combat_id: encounter.combat_id,
              sector: { id: encounter.sector_id },
              result: `${participant.name}_destroyed`,
              end: `${participant.name}_destroyed`,
              ...(shipSnapshot ? { ship: shipSnapshot } : {}),
            },
            sectorId: encounter.sector_id,
            shipId,
            requestId,
          });
        } catch (err) {
          console.error("combat_finalization.eject_combat_ended_emit", {
            shipId,
            err,
          });
        }
      }

      ejected.add(pid);
    } catch (err) {
      console.error("combat_finalization.eject_destroyed_failed", {
        pid,
        err: String(err),
      });
    }
  }

  return ejected;
}

/**
 * Build a minimal ship snapshot for the personalized combat.ended emitted to
 * an ejected (destroyed) player. Reflects the post-conversion escape-pod
 * state — cargo and credits are zero (convertShipToEscapePod nuked them),
 * fighters and shields are zero, and warp power equals the escape-pod
 * definition's full capacity (the conversion sets current_warp_power to that).
 */
function buildShipSnapshotForEjectedPlayer(
  ship: ShipRow,
  def: ShipDefinitionRow,
): Record<string, unknown> {
  return {
    ship_id: ship.ship_id,
    ship_type: ship.ship_type,
    ship_name: ship.ship_name ?? def.display_name,
    credits: 0,
    cargo: { quantum_foam: 0, retro_organics: 0, neuro_symbolics: 0 },
    warp_power: def.warp_power_capacity,
    warp_power_capacity: def.warp_power_capacity,
    shields: 0,
    fighters: 0,
    sector: ship.current_sector,
  };
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

/**
 * Capture salvage data from a freshly-defeated ship into the encounter blob.
 *
 * The ship row is loaded BEFORE any escape-pod conversion runs (cargo/credits
 * still intact). A salvage entry is built and pushed onto
 * `encounter.pending_salvage_entries`. The actual sector-level salvage drop
 * (`appendSalvageEntry` + `salvage.created` event) is deferred to
 * `dropPendingSalvageAtCombatEnd` — held until combat ends so a passer-by
 * cannot collect mid-fight.
 *
 * Returns the captured entry (or null when there's nothing to salvage).
 */
export async function captureSalvageForDefeatedShip(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  participant: CombatantState,
  definition: ShipDefinitionRow | undefined,
): Promise<SalvageEntry | null> {
  // Idempotent: skip if this participant's salvage was already pushed onto
  // pending_salvage_entries. The flag is durable on the encounter blob via
  // the persistCombatState that follows capture in the eject/finalize paths,
  // so a retry after the persist finds the flag set and won't double-capture.
  if (participant.salvage_captured) return null;

  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  const shipId = typeof metadata.ship_id === "string" ? metadata.ship_id : null;
  if (!shipId) return null;

  const ship = await loadShip(supabase, shipId);
  if (!ship) return null;

  const cargo = buildCargoFromShip(ship);
  const credits = ship.credits ?? 0;
  const scrapBase = definition?.purchase_price ?? 0;
  const scrap = Math.max(5, Math.floor(scrapBase / 1000));
  const hasSalvage = Object.keys(cargo).length > 0 || scrap > 0 || credits > 0;
  if (!hasSalvage) {
    // No salvage to capture, but still mark captured so a retry doesn't
    // re-load the ship row needlessly.
    participant.salvage_captured = true;
    return null;
  }

  const salvage = buildSalvageEntry(
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

  encounter.pending_salvage_entries ??= [];
  encounter.pending_salvage_entries.push(salvage as Record<string, unknown>);
  participant.salvage_captured = true;
  return salvage;
}

/**
 * Apply destruction to canonical tables for a defeated character participant.
 *
 * Player ship: convert to escape pod (zeros cargo / credits / fighters /
 * shields, sets ship_type='escape_pod'). Mirror the resulting ship_type +
 * is_escape_pod onto the in-memory participant so subsequent payloads
 * serialize the post-conversion state.
 *
 * Corp ship: noop on the ship_instances side (the previous-PR helper
 * `persistRoundOutcomeToCanonicalTables` already wrote `destroyed_at` and
 * enqueued the deletion). The pseudo-character / corporation_ships cleanup
 * is the caller's job — pull the entry from
 * `encounter.pending_corp_ship_deletions` and run `executeCorpShipDeletions`.
 *
 * Idempotent for player ships (a second call against an already-converted
 * ship just rewrites the same escape-pod values).
 */
export async function applyShipDestructionToCanonicalTables(
  supabase: SupabaseClient,
  participant: CombatantState,
  shipDefs: Map<string, ShipDefinitionRow>,
): Promise<void> {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  const shipId = typeof metadata.ship_id === "string" ? metadata.ship_id : null;
  if (!shipId) return;

  const playerType = (metadata.player_type as string) ?? "human";
  const isCorpShip = playerType === "corporation_ship";
  if (isCorpShip) {
    // Corp ships: destroyed_at + zero fighters/shields was already written by
    // persistRoundOutcomeToCanonicalTables. Caller drains
    // pending_corp_ship_deletions for the row-level cleanup.
    return;
  }

  // Player ship already converted in a prior round — skip the redundant DB
  // write. We mirrored the participant flag at the time of conversion.
  if (participant.is_escape_pod) return;

  await convertShipToEscapePod(supabase, shipId, shipDefs);
  participant.ship_type = "escape_pod";
  participant.is_escape_pod = true;
  participant.fighters = 0;
  participant.shields = 0;
}

/**
 * Drain `encounter.pending_salvage_entries` into `sector_contents.salvage`
 * and emit `salvage.created` for each entry. Call ONLY when combat is
 * actually ending — never mid-round.
 */
export async function dropPendingSalvageAtCombatEnd(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  requestId: string,
): Promise<SalvageEntry[]> {
  const pending = encounter.pending_salvage_entries ?? [];
  if (pending.length === 0) return [];
  const dropped: SalvageEntry[] = [];
  for (const raw of pending) {
    const entry = raw as SalvageEntry;
    try {
      await appendSalvageEntry(supabase, encounter.sector_id, entry);
      const timestamp = new Date().toISOString();
      await emitSectorEnvelope({
        supabase,
        sectorId: encounter.sector_id,
        eventType: "salvage.created",
        payload: {
          source: buildEventSource("combat.ended", requestId),
          timestamp,
          salvage_id: entry.salvage_id,
          sector: { id: encounter.sector_id },
          cargo: entry.cargo,
          scrap: entry.scrap,
          credits: entry.credits,
          from_ship_type: entry.source.ship_type,
          from_ship_name: entry.source.ship_name,
        },
        requestId,
      });
      dropped.push(entry);
    } catch (err) {
      console.error("combat_finalization.drop_pending_salvage", {
        salvage_id: entry.salvage_id,
        err,
      });
    }
  }
  encounter.pending_salvage_entries = [];
  return dropped;
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

  // Capture salvage onto the encounter (will be dropped at combat end).
  // captureSalvageForDefeatedShip is idempotent on participant.salvage_captured,
  // so prior-round-ejected participants and same-call retries both no-op.
  const salvage = await captureSalvageForDefeatedShip(
    supabase,
    encounter,
    participant,
    definition,
  );

  // Persist the combat blob now so the captured salvage entry + the
  // salvage_captured flag are durable before applyShipDestructionToCanonicalTables
  // zeroes the cargo. Without this, a crash here would leave the ship
  // converted (cargo gone) but no salvage entry persisted — and on retry
  // the (now-zero-cargo) ship would yield nothing to capture.
  if (salvage) {
    await persistCombatState(supabase, encounter);
  }

  const shipDestroyedEvent: ShipDestroyedEventData = {
    shipId,
    shipType: ship.ship_type,
    shipName: ship.ship_name,
    playerType: isCorpShip ? "corporation_ship" : "human",
    playerName: participant.name,
    ownerCharacterId:
      participant.owner_character_id ?? participant.combatant_id,
    corpId,
  };

  // Apply destruction to canonical tables (idempotent for both branches).
  await applyShipDestructionToCanonicalTables(supabase, participant, shipDefs);

  if (isCorpShip) {
    if (!participant.destruction_handled) {
      const characterId =
        participant.owner_character_id ?? participant.combatant_id;
      participant.destruction_handled = true;
      return {
        salvage,
        deferredDeletion: { shipId, characterId },
        shipDestroyedEvent,
      };
    }
    return {
      salvage,
      deferredDeletion: null,
      shipDestroyedEvent,
    };
  }

  participant.destruction_handled = true;
  return {
    salvage,
    deferredDeletion: null,
    shipDestroyedEvent,
  };
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

/**
 * Persist this round's outcome to the canonical tables (ship_instances,
 * garrisons) so that DB-sourced reads (corporation.data, status.update,
 * my_status / my_corporation tool replies, etc.) reflect the live combat
 * state instead of pre-combat values.
 *
 * Call from resolveEncounterRound AFTER applying the in-memory update to
 * encounter.participants and BEFORE broadcasting combat.round_resolved, so
 * that any client snapshot triggered in response to the round event sees
 * the same numbers the event carried.
 *
 * Idempotency: writes for survivors are safe to re-apply (same value);
 * writes for newly defeated participants are guarded by `destruction_handled`
 * so finalizeCombat can skip them on the terminal round. Escape pod
 * conversion for defeated player ships is intentionally NOT done here —
 * it nukes cargo, and salvage in finalizeCombat needs cargo intact.
 */
export async function persistRoundOutcomeToCanonicalTables(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  requestId: string,
): Promise<void> {
  encounter.pending_corp_ship_deletions ??= [];

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    // Read from the live participant state, not outcome. The caller has
    // already applied this round's losses AND any between-round shield regen
    // to encounter.participants — so participant.shields is the next-round-
    // start value that round_waiting will broadcast. Using outcome here would
    // persist the pre-regen value and disagree with the encounter blob.
    const remaining = participant.fighters ?? 0;
    const remainingShields = participant.shields ?? 0;

    if (participant.combatant_type === "garrison") {
      if (participant.destruction_handled) continue;
      await updateGarrisonState(
        supabase,
        encounter,
        participant,
        remaining,
        requestId,
      );
      // Garrisons have no separate eject path — once
      // updateGarrisonState handles the row delete + map.update, mark them
      // destroyed-handled so subsequent rounds (and finalize) don't redo it.
      if (remaining <= 0) {
        participant.destruction_handled = true;
      }
      continue;
    }

    if (participant.combatant_type !== "character") continue;
    if (participant.destruction_handled) continue;

    const shipId =
      typeof participant.metadata?.ship_id === "string"
        ? (participant.metadata.ship_id as string)
        : null;
    if (!shipId) continue;

    if (remaining > 0) {
      // Survivor: write live values so external snapshots agree with the
      // round_resolved payload.
      const { error } = await supabase
        .from("ship_instances")
        .update({
          current_fighters: remaining,
          current_shields: remainingShields,
        })
        .eq("ship_id", shipId);
      if (error) {
        console.error("combat_finalization.persist_round_survivor", {
          shipId,
          error,
        });
      }
      continue;
    }

    // Newly defeated this round.
    const playerType =
      typeof participant.metadata?.player_type === "string"
        ? (participant.metadata.player_type as string)
        : "human";
    const isCorpShip = playerType === "corporation_ship";

    if (isCorpShip) {
      const { error } = await supabase
        .from("ship_instances")
        .update({
          current_fighters: 0,
          current_shields: 0,
          destroyed_at: new Date().toISOString(),
        })
        .eq("ship_id", shipId);
      if (error) {
        console.error("combat_finalization.persist_round_corp_destroyed", {
          shipId,
          error,
        });
        continue;
      }
      const characterId =
        participant.owner_character_id ?? participant.combatant_id;
      const alreadyPending = encounter.pending_corp_ship_deletions.some(
        (entry) => entry.ship_id === shipId,
      );
      if (!alreadyPending) {
        encounter.pending_corp_ship_deletions.push({
          ship_id: shipId,
          character_id: characterId,
        });
      }
    } else {
      // Player ship: zero fighters/shields so my_status reads are honest.
      // Escape pod conversion (cargo zero, ship_type swap) and the
      // destruction_handled flag flip happen later in
      // ejectDestroyedFromCombat (mid-round) or finalizeCombat (terminal).
      const { error } = await supabase
        .from("ship_instances")
        .update({
          current_fighters: 0,
          current_shields: 0,
        })
        .eq("ship_id", shipId);
      if (error) {
        console.error("combat_finalization.persist_round_player_destroyed", {
          shipId,
          error,
        });
        continue;
      }
    }
    // Note: destruction_handled is intentionally NOT set here. The eject
    // helper (mid-round) and finalizeCombat (terminal) own that lifecycle
    // step — they need to see the participant unflagged so they can run
    // salvage capture / escape-pod conversion / corp-ship cleanup against
    // it. persistRoundOutcomeToCanonicalTables only commits the canonical-
    // table writes that should be visible to external snapshot readers.
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
 * for mid-round emission. Salvage is dropped only when combat ends, via a
 * separate salvage.created event — clients track salvage existence through
 * that event, not a field on ship.destroyed.
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
  // Tasks are actor-private for human-owned ships — emitting with corpId
  // would tag the row corp-visible and surface task.cancel to corpmates.
  // Corp ships are inherently corp-visible, so keep the corpId in that case
  // so the corp poll picks it up.
  const corpScopedCorpId =
    data.playerType === "corporation_ship" ? data.corpId ?? undefined : undefined;
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
      corpId: corpScopedCorpId,
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
  // Seed with deletions queued by mid-round persistence (corp ships destroyed
  // in earlier rounds). handleDefeatedCharacter dedupes when adding any fresh
  // deletions detected on the terminal round.
  const pendingFromEncounter: PendingCorpShipDeletion[] =
    encounter.pending_corp_ship_deletions ?? [];
  const deferredDeletions: DeferredCorpShipDeletion[] = pendingFromEncounter.map(
    (entry) => ({ shipId: entry.ship_id, characterId: entry.character_id }),
  );
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
  // mid-round via emitNewlyDefeatedDestructions. Destruction side-effects
  // (escape-pod conversion, garrison row deletion, corp-ship destroyed_at)
  // for non-terminal-round deaths already ran in ejectDestroyedFromCombat.
  // finalize only does the work for terminal-round-just-died participants.
  for (const [pid] of defeated) {
    const participant = encounter.participants[pid];
    if (!participant || participant.combatant_type !== "character") {
      if (
        participant?.combatant_type === "garrison" &&
        !participant.destruction_handled
      ) {
        await updateGarrisonState(
          supabase,
          encounter,
          participant,
          outcome.fighters_remaining?.[pid] ?? 0,
          requestId ?? `combat:${encounter.combat_id}`,
        );
        participant.destruction_handled = true;
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

    // Salvage capture for this participant has been pushed onto
    // encounter.pending_salvage_entries by handleDefeatedCharacter (when
    // not already destruction_handled). The actual sector drop +
    // salvage.created emission happens once at the end of finalize via
    // dropPendingSalvageAtCombatEnd — never per-defeated mid-round.

    if (result.deferredDeletion) {
      const alreadyQueued = deferredDeletions.some(
        (entry) => entry.shipId === result.deferredDeletion!.shipId,
      );
      if (!alreadyQueued) {
        deferredDeletions.push(result.deferredDeletion);
      }
      // DON'T update participant.ship_type for corp ships - they won't become escape pods
    } else {
      // Update participant state to reflect escape pod conversion for event payload
      participant.ship_type = "escape_pod";
      participant.fighters = 0;
    }
  }

  // Drain salvage captured this round AND in any prior rounds where players
  // / corp ships died via ejectDestroyedFromCombat. This is the only place
  // sector_contents.salvage gets the new entries — guaranteeing a passer-by
  // can't loot mid-fight.
  const droppedSalvage = await dropPendingSalvageAtCombatEnd(
    supabase,
    encounter,
    requestId ?? `combat:${encounter.combat_id}`,
  );
  salvageEntries.push(...droppedSalvage);

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
