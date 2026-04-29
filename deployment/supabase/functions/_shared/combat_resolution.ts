import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildEventSource,
  emitCharacterEvent,
  emitSectorEnvelope,
  recordBroadcastByCorp,
} from "./events.ts";
import {
  allHostilesPaid,
  anyOutstandingToll,
  buildGarrisonActions,
  type TollRegistryEntry,
} from "./combat_garrison.ts";
import { resolveRound } from "./combat_engine.ts";
import {
  ejectDestroyedFromCombat,
  emitNewlyDefeatedDestructions,
  executeCorpShipDeletions,
  finalizeCombat,
  persistRoundOutcomeToCanonicalTables,
} from "./combat_finalization.ts";
import { departSuccessfulFleers } from "./combat_flee.ts";
import {
  buildCombatEndedPayload,
  buildRoundResolvedPayload,
  buildRoundWaitingPayload,
  collectParticipantIds,
  getCorpIdsFromParticipants,
  getDestroyedOwnerIds,
} from "./combat_events.ts";
import { buildSectorSnapshot, getAdjacentSectors } from "./map.ts";
import {
  computeEventRecipients,
  dedupeRecipientSnapshots,
  type EventRecipientSnapshot,
} from "./visibility.ts";
import {
  CombatEncounterState,
  CombatRoundLog,
  CombatRoundOutcome,
  RoundActionState,
} from "./combat_types.ts";
import {
  CombatStateConflictError,
  persistCombatState,
} from "./combat_state.ts";
import { buildCorporationMap } from "./friendly.ts";

const ROUND_TIMEOUT_SECONDS = Number(
  Deno.env.get("COMBAT_ROUND_TIMEOUT") ?? "30",
);
const SHIELD_REGEN_PER_ROUND = Number(
  Deno.env.get("SHIELD_REGEN_PER_ROUND") ?? "10",
);

export function computeNextCombatDeadline(): string {
  return new Date(Date.now() + ROUND_TIMEOUT_SECONDS * 1000).toISOString();
}

export async function resolveEncounterRound(options: {
  supabase: SupabaseClient;
  encounter: CombatEncounterState;
  requestId: string;
  source?: string;
}): Promise<void> {
  const { supabase, encounter, requestId } = options;
  const sourceName = options.source ?? "combat.resolution";

  // OCC fence at exit: the final persistCombatState compares against
  // `encounter.last_updated` AS IT IS at the time of that call. Each
  // internal persist (eject's mid-round salvage capture, finalize's
  // per-defeat salvage capture) updates `encounter.last_updated` in-place
  // on success, so the fence chains forward through them. An external
  // concurrent writer (a join arriving mid-resolve, a peer combat_action)
  // bumping the row's last_updated between any of our writes is what
  // triggers CombatStateConflictError below.

  const corpMap = buildCorporationMap(encounter);
  const timeoutActions = buildTimeoutActions(encounter);
  const garrisonActions = buildGarrisonActions(encounter, corpMap);
  const combinedActions: Record<string, RoundActionState> = {
    ...encounter.pending_actions,
    ...timeoutActions,
    ...garrisonActions,
  };

  const outcome = resolveRound(encounter, combinedActions);

  console.log("combat_resolution.outcome", {
    combat_id: encounter.combat_id,
    round: encounter.round,
    end_state: outcome.end_state,
    fighters_remaining: outcome.fighters_remaining,
    destroyed: outcome.destroyed,
  });

  // A toll demand round (or any all-brace round while tolls are outstanding)
  // resolves to "stalemate" in the engine. Per-payer toll: clear the stalemate
  // so combat continues whenever any toll garrison still has unpaid hostiles —
  // the garrison will escalate to attack on the next round.
  if (outcome.end_state === "stalemate") {
    const ctx = encounter.context as Record<string, unknown> | undefined;
    const tollRegistry = ctx?.toll_registry as
      | Record<string, TollRegistryEntry>
      | undefined;
    if (tollRegistry && anyOutstandingToll(encounter, tollRegistry, corpMap)) {
      outcome.end_state = null;
    }
  }

  // Check for toll satisfaction after resolution
  if (checkTollStanddown(encounter, outcome, combinedActions)) {
    outcome.end_state = "toll_satisfied";
  }

  // Check if all remaining combatants are on the same side (friendly).
  // This handles the case where a garrison owner and their garrison are the
  // only survivors — combat should end immediately rather than continuing.
  if (!outcome.end_state) {
    if (allSurvivorsAreFriendly(encounter, outcome, corpMap)) {
      outcome.end_state = "no_hostiles";
    }
  }

  encounter.logs.push({
    round_number: outcome.round_number,
    actions: combinedActions,
    hits: outcome.hits,
    offensive_losses: outcome.offensive_losses,
    defensive_losses: outcome.defensive_losses,
    shield_loss: outcome.shield_loss,
    damage_mitigated: outcome.damage_mitigated,
    result: outcome.end_state ?? null,
    timestamp: new Date().toISOString(),
  });

  // Resolve flee destinations + mark participants BEFORE building the resolved
  // payload so consumers can tell 'fled' apart from 'destroyed' for absent
  // combatants. The actual ship_instances move happens later in
  // moveSuccessfulFleers (DB write) using the destinations resolved here.
  await resolveFleeOutcomes(supabase, encounter, outcome, combinedActions);

  const resolvedPayload = buildRoundResolvedPayload(
    encounter,
    outcome,
    combinedActions,
  );
  resolvedPayload.source = buildEventSource("combat.round_resolved", requestId);

  // Announce ship/garrison destructions for participants whose fighters
  // dropped to 0 THIS round, before we overwrite participant.fighters with
  // the post-round values. The actual cleanup (escape pod conversion,
  // garrison row deletion, salvage drops) still runs at terminal in
  // finalizeCombat — only the events fire here so clients can react in
  // real time instead of waiting for the entire encounter to end.
  await emitNewlyDefeatedDestructions(supabase, encounter, outcome, requestId);

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    participant.fighters =
      outcome.fighters_remaining?.[pid] ?? participant.fighters;
    participant.shields =
      outcome.shields_remaining?.[pid] ?? participant.shields;
  }

  // Apply between-rounds shield regen ahead of the per-round persistence
  // call so DB-sourced snapshots (corporation.data, my_status, etc.) reflect
  // the same shield value the next round_waiting payload will carry. Skipped
  // when combat is ending — there is no next round, and regen would corrupt
  // the post-loss values that buildCombatEndedPayload reports.
  if (!outcome.end_state) {
    for (const participant of Object.values(encounter.participants)) {
      if ((participant.fighters ?? 0) > 0 && !participant.is_escape_pod) {
        const currentShields = participant.shields ?? 0;
        const maxShields = participant.max_shields ?? 0;
        participant.shields = Math.min(
          currentShields + SHIELD_REGEN_PER_ROUND,
          maxShields,
        );
      }
    }
  }

  encounter.pending_actions = {};
  encounter.awaiting_resolution = false;

  // Snapshot recipients BEFORE persistRoundOutcomeToCanonicalTables flips
  // destruction_handled. This serves both the round_resolved broadcast
  // below and the personalized combat.ended emission inside finalizeCombat
  // for the terminal round: a participant who just died this round still
  // has destruction_handled=false at this point, so the default filter
  // includes them and they receive both events. Prior-round-destroyed
  // participants are already filtered out — their UI left combat via the
  // personalized combat.ended ejectDestroyedFromCombat sent at their death.
  const recipients = collectParticipantIds(encounter);

  // Flush this round's outcome to ship_instances / garrisons before
  // broadcasting combat.round_resolved. Without this, any DB-sourced snapshot
  // a client triggers in response to the round event (corporation.data,
  // status.update, my_status / my_corporation tool calls) would serve the
  // pre-combat values and clobber the fresh in-memory state.
  await persistRoundOutcomeToCanonicalTables(supabase, encounter, requestId);

  await broadcastCombatEvent({
    supabase,
    recipients,
    encounter,
    eventType: "combat.round_resolved",
    payload: resolvedPayload,
    requestId,
  });

  // Move successful fleers out of the encounter and emit their full
  // movement cascade (movement.start/complete + map updates +
  // character.moved observers + personalized combat.ended). Runs every
  // round so a fleer's ship moves and their client unsticks even when
  // combat continues for the others. Departed fleers are removed from
  // encounter.participants below so they don't ghost subsequent rounds.
  const departedFleers = await departSuccessfulFleers({
    supabase,
    encounter,
    outcome,
    requestId,
  });
  if (departedFleers.size > 0) {
    for (const [pid, participant] of Object.entries(encounter.participants)) {
      const cid = participant.owner_character_id ?? participant.combatant_id;
      if (departedFleers.has(cid)) {
        delete encounter.participants[pid];
      }
    }
  }

  // Eject any newly-destroyed character participants when combat is
  // continuing. Drops salvage onto encounter.pending_salvage_entries (NOT
  // sector_contents.salvage), runs escape-pod conversion / corp-ship
  // pseudo-character cleanup, marks destruction_handled, and emits a
  // personalized combat.ended for player ships so their UI exits combat.
  // Skipped on the terminal round — finalizeCombat handles those deaths
  // and the personalized combat.ended emission downstream.
  if (!outcome.end_state) {
    await ejectDestroyedFromCombat({
      supabase,
      encounter,
      outcome,
      requestId,
      departedFleers,
    });
  }

  if (outcome.end_state) {
    console.log("combat_resolution.ending", {
      combat_id: encounter.combat_id,
      end_state: outcome.end_state,
    });
    encounter.ended = true;
    encounter.end_state = outcome.end_state;
    encounter.deadline = null;

    const { salvageEntries, deferredDeletions } = await finalizeCombat(
      supabase,
      encounter,
      outcome,
      requestId,
    );

    console.log("combat_resolution.broadcasting_ended", {
      combat_id: encounter.combat_id,
      recipients: recipients.length,
      departed_fleers: departedFleers.size,
    });

    // Send personalized combat.ended event to each participant with their own ship data
    // NO CORP VISIBILITY for combat.ended - personalized payload would corrupt client state
    // (matches legacy pattern from previous combat callbacks)
    // Wrapped in try-catch so that deferred corp ship deletions always run even
    // if an event emission fails (the ship is already marked destroyed_at in
    // handleDefeatedCharacter, but we still need pseudo-character cleanup).
    // Successful fleers already received their personalized combat.ended via
    // departSuccessfulFleers — skip them here to avoid a duplicate emission.
    try {
      const { buildCombatEndedPayloadForViewer } =
        await import("./combat_events.ts");
      for (const recipient of recipients) {
        if (departedFleers.has(recipient)) continue;
        const personalizedPayload = await buildCombatEndedPayloadForViewer(
          supabase,
          encounter,
          outcome,
          salvageEntries,
          encounter.logs ?? [],
          recipient,
        );
        personalizedPayload.source = buildEventSource("combat.ended", requestId);
        const shipId =
          typeof personalizedPayload === "object" && personalizedPayload !== null
            ? (personalizedPayload as Record<string, unknown>)["ship"]
            : null;
        const shipIdValue =
          typeof shipId === "object" && shipId !== null
            ? (shipId as Record<string, unknown>)["ship_id"]
            : null;

        await emitCharacterEvent({
          supabase,
          characterId: recipient,
          eventType: "combat.ended",
          payload: personalizedPayload,
          sectorId: encounter.sector_id,
          requestId,
          shipId: typeof shipIdValue === "string" ? shipIdValue : undefined,
        });
      }
    } catch (err) {
      console.error("combat_resolution.combat_ended_emission", {
        combat_id: encounter.combat_id,
        error: err,
      });
    }

    await broadcastObservedCombatEndedEvent({
      supabase,
      encounter,
      outcome,
      salvageEntries,
      logs: encounter.logs ?? [],
      participantRecipients: recipients,
      departedFleers,
      requestId,
    });

    // Execute deferred corp ship deletions AFTER combat.ended events are emitted
    if (deferredDeletions.length > 0) {
      await executeCorpShipDeletions(supabase, deferredDeletions);
    }

    // Emit sector.update to all sector occupants after combat ends
    const sectorSnapshot = await buildSectorSnapshot(
      supabase,
      encounter.sector_id,
    );
    await emitSectorEnvelope({
      supabase,
      sectorId: encounter.sector_id,
      eventType: "sector.update",
      payload: {
        source: buildEventSource("combat.ended", requestId),
        ...sectorSnapshot,
      },
      requestId,
      actorCharacterId: null,
    });
  } else {
    console.log("combat_resolution.continuing", {
      combat_id: encounter.combat_id,
      next_round: outcome.round_number + 1,
    });
    encounter.round = outcome.round_number + 1;
    encounter.deadline = computeNextCombatDeadline();

    // Shield regen for the next round was already applied earlier (before
    // persistRoundOutcomeToCanonicalTables) so DB and round_waiting agree.

    const waitingPayload = buildRoundWaitingPayload(encounter);
    waitingPayload.source = buildEventSource("combat.round_waiting", requestId);

    // Recompute recipients from the current participants — fleers were
    // removed earlier in this round, and we must NOT re-target them with
    // round_waiting after they already received a personalized combat.ended.
    const continuingRecipients = collectParticipantIds(encounter);

    await broadcastCombatEvent({
      supabase,
      recipients: continuingRecipients,
      encounter,
      eventType: "combat.round_waiting",
      payload: waitingPayload,
      requestId,
    });
  }

  try {
    await persistCombatState(supabase, encounter, {
      expectedLastUpdated: encounter.last_updated,
    });
  } catch (err) {
    if (err instanceof CombatStateConflictError) {
      // A concurrent writer mutated the combat blob between this round's
      // load and write. Events fired during resolution describe a state
      // that didn't atomically commit; the next combat_tick run will
      // re-read the post-conflict state and resolve from there. Logged
      // (not re-thrown) so combat_tick's batch loop continues to the
      // next encounter.
      console.warn("combat_resolution.cas_conflict", {
        combat_id: encounter.combat_id,
        sector_id: encounter.sector_id,
        round: encounter.round,
        source: sourceName,
      });
      return;
    }
    throw err;
  }
}

/**
 * Check if all surviving (fighters > 0, not fled) combatants are on the same
 * side.  Two combatants are friendly when they share an owner_character_id or
 * belong to the same corporation.
 */
function allSurvivorsAreFriendly(
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  corps: Map<string, string | null>,
): boolean {
  const livingIds = Object.keys(outcome.fighters_remaining).filter(
    (pid) =>
      (outcome.fighters_remaining[pid] ?? 0) > 0 && !outcome.flee_results[pid],
  );

  if (livingIds.length <= 1) {
    return false; // Already handled by normal end-state logic
  }

  // Collect the effective owner for each survivor
  const owners = new Set<string>();
  for (const pid of livingIds) {
    const participant = encounter.participants[pid];
    if (!participant) continue;
    owners.add(participant.owner_character_id ?? participant.combatant_id);
  }

  // All same owner (e.g. player + their garrison)
  if (owners.size <= 1) {
    return true;
  }

  // All same corporation
  const corpIds = new Set<string>();
  for (const ownerId of owners) {
    const cid = corps.get(ownerId);
    if (!cid) return false; // Owner without a corp → can't all be same corp
    corpIds.add(cid);
  }
  return corpIds.size === 1;
}

function buildTimeoutActions(
  encounter: CombatEncounterState,
): Record<string, RoundActionState> {
  const actions: Record<string, RoundActionState> = {};
  for (const [pid, participant] of Object.entries(encounter.participants)) {
    if (participant.combatant_type === "garrison") {
      continue;
    }
    if (encounter.pending_actions[pid]) {
      continue;
    }
    if ((participant.fighters ?? 0) <= 0) {
      continue;
    }
    actions[pid] = {
      action: "brace",
      commit: 0,
      timed_out: true,
      target_id: null,
      destination_sector: null,
      submitted_at: new Date().toISOString(),
    };
  }
  return actions;
}

/**
 * Broadcast non-personalized combat events (combat.round_waiting, combat.round_resolved)
 * with corp visibility. Uses unified recipient computation.
 */
async function broadcastCombatEvent(params: {
  supabase: SupabaseClient;
  recipients: string[];
  encounter: CombatEncounterState;
  eventType: string;
  payload: Record<string, unknown>;
  requestId: string;
}): Promise<void> {
  const { supabase, recipients, encounter, eventType, payload, requestId } =
    params;

  // Extract corp IDs from all participants (including garrisons)
  const corpIds = getCorpIdsFromParticipants(encounter.participants);

  // Exclude destroyed (already-ejected) participants. Their escape pods are
  // still in the sector and would otherwise be re-added by the sector
  // visibility query — they already received their personalized combat.ended
  // and shouldn't keep getting subsequent round events.
  const destroyedOwnerIds = getDestroyedOwnerIds(encounter);

  // Compute ALL recipients: participants + sector observers + corp members (deduped)
  const allRecipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds,
    directRecipients: recipients,
    excludeCharacterIds: destroyedOwnerIds,
  });

  if (allRecipients.length === 0) {
    return;
  }

  await recordBroadcastByCorp({
    supabase,
    eventType,
    scope: "sector",
    payload,
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null,
    recipients: allRecipients,
    stakeholderCorpIds: corpIds,
  });
}

async function broadcastObservedCombatEndedEvent(params: {
  supabase: SupabaseClient;
  encounter: CombatEncounterState;
  outcome: CombatRoundOutcome;
  salvageEntries: Array<Record<string, unknown>>;
  logs: CombatRoundLog[];
  participantRecipients: string[];
  departedFleers: Set<string>;
  requestId: string;
}): Promise<void> {
  const {
    supabase,
    encounter,
    outcome,
    salvageEntries,
    logs,
    participantRecipients,
    departedFleers,
    requestId,
  } = params;

  const excluded = new Set<string>([
    ...participantRecipients,
    ...departedFleers,
  ]);
  const corpIds = getCorpIdsFromParticipants(encounter.participants);
  const corpRecipients = await computeEventRecipients({
    supabase,
    corpIds,
    excludeCharacterIds: [...excluded],
  });
  const garrisonOwnerRecipients: EventRecipientSnapshot[] = Object.values(
    encounter.participants,
  )
    .filter((participant) => participant.combatant_type === "garrison")
    .map((participant) => participant.owner_character_id)
    .filter((ownerId): ownerId is string =>
      typeof ownerId === "string" &&
      ownerId.length > 0 &&
      !excluded.has(ownerId)
    )
    .map((ownerId) => ({ characterId: ownerId, reason: "garrison_owner" }));

  const recipients = dedupeRecipientSnapshots([
    ...garrisonOwnerRecipients,
    ...corpRecipients,
  ]);
  if (recipients.length === 0) {
    return;
  }

  const payload = buildCombatEndedPayload(
    encounter,
    outcome,
    salvageEntries,
    logs,
  );
  payload.source = buildEventSource("combat.ended", requestId);
  payload.observed = true;

  // No stakeholderCorpIds for the observer-safe event: the recipient list is
  // already filtered to non-participants (and non-fleers). Partitioning by
  // stakeholder corp would tag rows with corp_id = a participant's corp, and
  // the participant's corp poll would then surface the observer-tagged event
  // alongside their own personalized combat.ended — confusing the client
  // that's already exited combat.
  await recordBroadcastByCorp({
    supabase,
    eventType: "combat.ended",
    scope: "sector",
    payload,
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null,
    recipients,
    stakeholderCorpIds: [],
  });
}

function checkTollStanddown(
  encounter: CombatEncounterState,
  _outcome: { round_number: number; end_state: string | null },
  actions: Record<string, RoundActionState>,
): boolean {
  const context = encounter.context as Record<string, unknown> | undefined;
  if (!context) {
    return false;
  }
  const tollRegistry = context.toll_registry as
    | Record<string, TollRegistryEntry>
    | undefined;
  if (!tollRegistry) {
    return false;
  }

  // Per-payer toll standdown: combat ends only when (a) at least one toll
  // garrison is in the registry, (b) every hostile of every toll garrison
  // has paid (allHostilesPaid), and (c) no participant attacked this round
  // (a paid payer attacking would invalidate the peace contract).
  const corps = buildCorporationMap(encounter);
  let sawTollGarrison = false;
  for (const [garrisonId, entry] of Object.entries(tollRegistry)) {
    const garrison = encounter.participants[garrisonId];
    if (!garrison || garrison.combatant_type !== "garrison") continue;
    sawTollGarrison = true;
    if (!allHostilesPaid(encounter, garrison, entry, corps)) {
      return false;
    }
    // Garrison itself must have braced or paid this round.
    const garrisonAction = actions[garrisonId];
    if (
      garrisonAction &&
      garrisonAction.action !== "brace" &&
      garrisonAction.action !== "pay"
    ) {
      return false;
    }
  }
  if (!sawTollGarrison) return false;

  // Every other participant must have braced or paid (no active attacks).
  for (const [pid, participantAction] of Object.entries(actions)) {
    if (pid in tollRegistry) continue;
    if (
      participantAction.action !== "brace" &&
      participantAction.action !== "pay"
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Resolve each successful fleer's destination sector and mark the participant.
 * Runs synchronously before buildRoundResolvedPayload so has_fled / fled_to_sector
 * surface on the resolved payload consumers see, not just on combat.ended.
 *
 * The actual DB move happens later in moveSuccessfulFleers, which reads
 * participant.fled_to_sector that this helper sets.
 */
async function resolveFleeOutcomes(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  actions: Record<string, RoundActionState>,
): Promise<void> {
  for (const [pid, succeeded] of Object.entries(outcome.flee_results)) {
    if (!succeeded) continue;

    const participant = encounter.participants[pid];
    if (!participant || participant.combatant_type !== "character") continue;

    let destination = actions[pid]?.destination_sector ?? null;

    // If no destination was specified, pick a random adjacent sector
    if (destination == null) {
      try {
        const adjacent = await getAdjacentSectors(supabase, encounter.sector_id);
        if (adjacent.length > 0) {
          destination = adjacent[Math.floor(Math.random() * adjacent.length)];
        }
      } catch (err) {
        console.error("combat_resolution.flee_adjacent_lookup", { pid, error: err });
      }
    }

    participant.has_fled = true;
    participant.fled_to_sector = destination;
  }
}
