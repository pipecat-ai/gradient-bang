import type { SupabaseClient } from "@supabase/supabase-js";

import {
  emitCharacterEvent,
  emitSectorEnvelope,
  buildEventSource,
  recordEventWithRecipients,
} from "./events.ts";
import { buildGarrisonActions } from "./combat_garrison.ts";
import { resolveRound } from "./combat_engine.ts";
import {
  finalizeCombat,
  executeCorpShipDeletions,
} from "./combat_finalization.ts";
import {
  buildRoundResolvedPayload,
  buildRoundWaitingPayload,
  getCorpIdsFromParticipants,
  collectParticipantIds,
} from "./combat_events.ts";
import { buildSectorSnapshot, getAdjacentSectors } from "./map.ts";
import { computeEventRecipients } from "./visibility.ts";
import {
  CombatEncounterState,
  CombatRoundOutcome,
  RoundActionState,
  CombatantState,
} from "./combat_types.ts";
import { persistCombatState } from "./combat_state.ts";

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

  const resolvedPayload = buildRoundResolvedPayload(
    encounter,
    outcome,
    combinedActions,
  );
  resolvedPayload.source = buildEventSource("combat.round_resolved", requestId);

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    participant.fighters =
      outcome.fighters_remaining?.[pid] ?? participant.fighters;
    participant.shields =
      outcome.shields_remaining?.[pid] ?? participant.shields;
  }

  encounter.pending_actions = {};
  encounter.awaiting_resolution = false;

  const recipients = collectParticipantIds(encounter);

  await broadcastCombatEvent({
    supabase,
    recipients,
    encounter,
    eventType: "combat.round_resolved",
    payload: resolvedPayload,
    requestId,
  });

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

    // Move successful fleers to their destination sector
    await moveSuccessfulFleers(supabase, encounter, outcome, combinedActions);

    console.log("combat_resolution.broadcasting_ended", {
      combat_id: encounter.combat_id,
      recipients: recipients.length,
    });

    // Send personalized combat.ended event to each participant with their own ship data
    // NO CORP VISIBILITY for combat.ended - personalized payload would corrupt client state
    // (matches legacy pattern from previous combat callbacks)
    // Wrapped in try-catch so that deferred corp ship deletions always run even
    // if an event emission fails (the ship is already marked destroyed_at in
    // handleDefeatedCharacter, but we still need pseudo-character cleanup).
    try {
      const { buildCombatEndedPayloadForViewer } =
        await import("./combat_events.ts");
      for (const recipient of recipients) {
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

    // Recharge shields between rounds
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

    const waitingPayload = buildRoundWaitingPayload(encounter);
    waitingPayload.source = buildEventSource("combat.round_waiting", requestId);

    await broadcastCombatEvent({
      supabase,
      recipients,
      encounter,
      eventType: "combat.round_waiting",
      payload: waitingPayload,
      requestId,
    });
  }

  await persistCombatState(supabase, encounter);
}

function buildCorporationMap(
  encounter: CombatEncounterState,
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const participant of Object.values(encounter.participants)) {
    if (participant.combatant_type === "character") {
      const metadata = participant.metadata as
        | Record<string, unknown>
        | undefined;
      const corpId =
        typeof metadata?.corporation_id === "string"
          ? metadata.corporation_id
          : null;
      const key = participant.owner_character_id ?? participant.combatant_id;
      map.set(key, corpId);
    }
    // Also add garrison owner's corp ID so garrisons don't target corpmates
    if (
      participant.combatant_type === "garrison" &&
      participant.owner_character_id
    ) {
      const metadata = participant.metadata as
        | Record<string, unknown>
        | undefined;
      const ownerCorpId =
        typeof metadata?.owner_corporation_id === "string"
          ? metadata.owner_corporation_id
          : null;
      map.set(participant.owner_character_id, ownerCorpId);
    }
  }
  return map;
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

  // Compute ALL recipients: participants + sector observers + corp members (deduped)
  const allRecipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds,
    directRecipients: recipients,
  });

  if (allRecipients.length === 0) {
    return;
  }

  // Single emission to all unique recipients
  await recordEventWithRecipients({
    supabase,
    eventType,
    scope: "sector",
    payload,
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null, // System-originated
    recipients: allRecipients,
  });
}

function checkTollStanddown(
  encounter: CombatEncounterState,
  outcome: { round_number: number; end_state: string | null },
  actions: Record<string, RoundActionState>,
): boolean {
  // Check if there's a toll registry in the context
  const context = encounter.context as Record<string, unknown> | undefined;
  if (!context) {
    return false;
  }
  const tollRegistry = context.toll_registry as
    | Record<string, unknown>
    | undefined;
  if (!tollRegistry) {
    return false;
  }

  // Check each garrison to see if toll was paid this round
  for (const [garrisonId, entryRaw] of Object.entries(tollRegistry)) {
    const entry = entryRaw as Record<string, unknown>;
    if (!entry.paid) {
      continue;
    }
    const paidRound = entry.paid_round as number | undefined;
    // Use outcome.round_number instead of encounter.round
    if (paidRound !== outcome.round_number) {
      continue;
    }

    // Check if garrison braced or paid
    const garrisonAction = actions[garrisonId];
    if (
      garrisonAction &&
      garrisonAction.action !== "brace" &&
      garrisonAction.action !== "pay"
    ) {
      continue;
    }

    // Check if all other participants braced or paid
    let othersBraced = true;
    for (const [pid, participantAction] of Object.entries(actions)) {
      if (pid === garrisonId) {
        continue;
      }
      if (
        participantAction.action !== "brace" &&
        participantAction.action !== "pay"
      ) {
        othersBraced = false;
        break;
      }
    }

    if (othersBraced) {
      return true;
    }
  }

  return false;
}

/**
 * Move ships of players who successfully fled to their chosen destination sector.
 * Called after finalizeCombat but before combat.ended events so the personalized
 * payload reflects the new sector.
 */
async function moveSuccessfulFleers(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  actions: Record<string, RoundActionState>,
): Promise<void> {
  for (const [pid, succeeded] of Object.entries(outcome.flee_results)) {
    if (!succeeded) continue;

    const participant = encounter.participants[pid];
    if (!participant || participant.combatant_type !== "character") continue;

    const shipId = (participant.metadata as Record<string, unknown>)?.ship_id;
    if (typeof shipId !== "string") continue;

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

    if (destination == null) continue;

    const { error } = await supabase
      .from("ship_instances")
      .update({ current_sector: destination })
      .eq("ship_id", shipId);

    if (error) {
      console.error("combat_resolution.move_fleer", { pid, shipId, destination, error });
    } else {
      console.log("combat_resolution.fleer_moved", { pid, shipId, destination });
    }
  }
}
