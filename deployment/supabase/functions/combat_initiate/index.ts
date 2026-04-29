import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitErrorEvent,
  buildEventSource,
  recordBroadcastByCorp,
} from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import { loadCharacter, loadShip } from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import {
  loadCharacterCombatants,
  loadCharacterNames,
  loadGarrisonCombatants,
} from "../_shared/combat_participants.ts";
import { nowIso, CombatEncounterState } from "../_shared/combat_types.ts";
import { getEffectiveCorporationId } from "../_shared/corporations.ts";
import {
  CombatStateConflictError,
  isResolvingLockHeld,
  loadCombatForSector,
  persistCombatState,
} from "../_shared/combat_state.ts";
import { loadUniverseMeta, isFedspaceSector } from "../_shared/fedspace.ts";
import {
  buildRoundWaitingPayload,
  getCorpIdsFromParticipants,
  collectParticipantIds,
} from "../_shared/combat_events.ts";
import { computeNextCombatDeadline } from "../_shared/combat_resolution.ts";
import { computeEventRecipients } from "../_shared/visibility.ts";
import { traced } from "../_shared/weave.ts";

const MIN_PARTICIPANTS = 2;

function deterministicSeed(combatId: string): number {
  const normalized =
    combatId.replace(/[^0-9a-f]/gi, "").slice(0, 12) || combatId;
  const parsed = Number.parseInt(normalized, 16);
  if (Number.isFinite(parsed)) {
    return parsed >>> 0;
  }
  return Math.floor(Math.random() * 1_000_000);
}

function generateCombatId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

Deno.serve(traced("combat_initiate", async (req, trace) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("combat_initiate.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, "character_id");
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const debug = optionalBoolean(payload, "debug") ?? false;
  const taskId = optionalString(payload, "task_id");

  trace.setInput({ requestId, characterId, actorCharacterId, adminOverride, debug, taskId });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "combat_initiate");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_initiate",
        requestId,
        detail: "Too many combat initiation requests",
        status: 429,
      });
      return errorResponse("Too many combat initiation requests", 429);
    }
    console.error("combat_initiate.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const sHandle = trace.span("handle_combat_initiate", { character_id: characterId });
    const result = await handleCombatInitiate({
      supabase,
      payload,
      characterId,
      requestId,
      actorCharacterId,
      adminOverride,
      debug,
      taskId,
    });
    sHandle.end();
    trace.setOutput({ request_id: requestId, characterId });
    return result;
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_initiate",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("combat_initiate.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    const message =
      err instanceof Error ? err.message : "combat initiate failed";
    await emitErrorEvent(supabase, {
      characterId,
      method: "combat_initiate",
      requestId,
      detail: message,
      status,
    });
    return errorResponse(message, status);
  }
}));

async function handleCombatInitiate(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  payload: Record<string, unknown>;
  characterId: string;
  requestId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
  debug: boolean;
  taskId: string | null;
}): Promise<Response> {
  const {
    supabase,
    characterId,
    requestId,
    actorCharacterId,
    adminOverride,
    debug,
    taskId,
  } = params;
  const character = await loadCharacter(supabase, characterId);
  const shipId = character.current_ship_id;
  if (!shipId) {
    throw new Error("Character has no ship assigned");
  }

  const ship = await loadShip(supabase, shipId);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  if (ship.in_hyperspace) {
    throw new Error("Character is in hyperspace and cannot initiate combat");
  }
  if (ship.current_sector === null || ship.current_sector === undefined) {
    throw new Error("Character ship missing sector");
  }
  const sectorId = ship.current_sector;
  const universeMeta = await loadUniverseMeta(supabase);
  if (await isFedspaceSector(supabase, sectorId, universeMeta)) {
    const err = new Error("Combat is disabled in Federation Space") as Error & {
      status?: number;
    };
    err.status = 400;
    throw err;
  }

  // Check initiator has fighters
  const initiatorFighters = ship.current_fighters ?? 0;
  if (initiatorFighters <= 0) {
    const err = new Error(
      "Cannot initiate combat while you have no fighters.",
    ) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const existingEncounter = await loadCombatForSector(supabase, sectorId);
  // Resolution lock — combat_tick's resolveEncounterRound stamps
  // resolving_started_at on entry under CAS and clears it at exit.
  // Mutating the encounter while that's in flight would land canonical
  // writes / events from the pre-mutation participant set followed by a
  // persist that swaps membership underneath the next-tick run. Bail
  // with 409 and let the client retry once resolution completes (or the
  // 30s TTL ages it out as crash residue).
  if (
    existingEncounter &&
    !existingEncounter.ended &&
    isResolvingLockHeld(existingEncounter)
  ) {
    const err = new Error(
      "Combat is currently resolving; retry shortly.",
    ) as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  // OCC fence — captured at load time so the CAS below detects any
  // concurrent writer. For the fresh-create case (no existing encounter)
  // we pass `null` rather than `undefined`: the cas_update_combat SQL
  // function uses `IS NOT DISTINCT FROM` so NULL expected matches a
  // currently-null `combat` column AND fails when a peer raced us to
  // create combat in this sector first.
  const expectedLastUpdated = existingEncounter
    ? existingEncounter.last_updated
    : null;
  const participantStates = await loadCharacterCombatants(supabase, sectorId);
  const ownerNames = await loadCharacterNames(
    supabase,
    participantStates.map(
      (state) => state.owner_character_id ?? state.combatant_id,
    ),
  );
  const garrisons = await loadGarrisonCombatants(
    supabase,
    sectorId,
    ownerNames,
  );

  // Get initiator's effective corporation (membership OR ship ownership for corp-owned ships)
  const initiatorCorpId = await getEffectiveCorporationId(
    supabase,
    characterId,
    shipId,
  );

  // Validate targetable opponents exist
  let hasTargetableOpponent = false;

  // Check characters
  for (const participant of participantStates) {
    if (participant.combatant_id === characterId) continue;
    if (participant.is_escape_pod) continue;
    if ((participant.fighters ?? 0) <= 0) continue;

    // Check if same corporation
    if (
      initiatorCorpId &&
      participant.metadata?.corporation_id === initiatorCorpId
    )
      continue;

    hasTargetableOpponent = true;
    break;
  }

  // Check garrisons if no character targets
  if (!hasTargetableOpponent && garrisons.length > 0) {
    // Garrison owner can be a real player OR a corp-ship pseudo-character.
    // Use `getEffectiveCorporationId` (same helper as move auto-engage) so
    // the pseudo-character case resolves via `ship_instances.owner_corporation_id`.
    // Querying `corporation_members` alone misses corp-ship garrisons and
    // lets the initiator start combat against a friendly corp ship.
    const garrisonOwnerIds = Array.from(
      new Set(
        garrisons
          .map((g) => g.state.owner_character_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const ownerCorpMap = new Map<string, string | null>();
    for (const ownerId of garrisonOwnerIds) {
      ownerCorpMap.set(
        ownerId,
        await getEffectiveCorporationId(supabase, ownerId, ownerId),
      );
    }

    for (const garrison of garrisons) {
      const ownerId = garrison.state.owner_character_id;
      if (!ownerId || ownerId === characterId) continue;
      if ((garrison.state.fighters ?? 0) <= 0) continue;

      // Check if garrison owner is in same corporation
      const ownerCorpId = ownerCorpMap.get(ownerId) ?? null;
      if (initiatorCorpId && ownerCorpId === initiatorCorpId) continue;

      hasTargetableOpponent = true;
      break;
    }
  }

  if (!hasTargetableOpponent && !debug) {
    const err = new Error(
      "No targetable opponents available to engage",
    ) as Error & { status?: number };
    err.status = 409;
    throw err;
  }

  // IDs that should be marked `just_joined` on the round_waiting we emit
  // below. Existing-encounter case = just the new initiator; fresh-encounter
  // case = every starting participant. Empty when nothing actually joined.
  const justJoinedIds = new Set<string>();

  let encounter: CombatEncounterState;
  if (existingEncounter && !existingEncounter.ended) {
    encounter = existingEncounter;
    if (!encounter.participants[characterId]) {
      const participant = participantStates.find(
        (state) => state.combatant_id === characterId,
      );
      if (!participant) {
        throw new Error("Initiator not present in sector");
      }
      // Mid-encounter joiner: stamp `joined_round` so the action-submit
      // and round-ready gates lock them out of acting in this round.
      // They brace by default and become full participants on round N+1.
      encounter.participants[participant.combatant_id] = {
        ...participant,
        joined_round: encounter.round,
      };
      justJoinedIds.add(participant.combatant_id);
    }
    if (!encounter.base_seed) {
      encounter.base_seed = deterministicSeed(encounter.combat_id);
    }
  } else {
    // Fresh encounter — initial combatants do NOT get `joined_round` set
    // (reserved for mid-encounter joiners). Their first round_waiting
    // still marks them via the explicit `justJoinedIds` set so the
    // `(joined encounter)` annotation fires once.
    const participants: Record<string, CombatantState> = {};
    for (const state of participantStates) {
      participants[state.combatant_id] = state;
      justJoinedIds.add(state.combatant_id);
    }
    for (const garrison of garrisons) {
      participants[garrison.state.combatant_id] = garrison.state;
      justJoinedIds.add(garrison.state.combatant_id);
    }
    if (Object.keys(participants).length < MIN_PARTICIPANTS && !debug) {
      const err = new Error("No opponents available to engage") as Error & {
        status?: number;
      };
      err.status = 409;
      throw err;
    }

    const combatId = generateCombatId();
    encounter = {
      combat_id: combatId,
      sector_id: sectorId,
      round: 1,
      deadline: computeNextCombatDeadline(),
      participants,
      pending_actions: {},
      logs: [],
      context: {
        initiator: characterId,
        created_at: nowIso(),
        garrison_sources: garrisons.map((g) => g.source),
      },
      awaiting_resolution: false,
      ended: false,
      end_state: null,
      base_seed: deterministicSeed(combatId),
      last_updated: nowIso(),
    };
  }

  // OCC: every persist goes through compare-and-swap so a concurrent join
  // / tick / peer action can't clobber. Existing-encounter path CASes on
  // the loaded encounter's last_updated; fresh-create path CASes on
  // `null` (cas_update_combat uses IS NOT DISTINCT FROM, so NULL expected
  // matches a currently-null `combat` column AND fails when a peer raced
  // us to create combat first). On conflict, throw 409 so the client
  // retries with fresh state.
  try {
    await persistCombatState(supabase, encounter, { expectedLastUpdated });
  } catch (err) {
    if (err instanceof CombatStateConflictError) {
      const conflictErr = new Error(
        "Combat state changed during initiation; resubmit.",
      ) as Error & { status?: number };
      conflictErr.status = 409;
      throw conflictErr;
    }
    throw err;
  }
  await emitRoundWaitingEvents(
    supabase,
    encounter,
    requestId,
    taskId,
    justJoinedIds,
  );

  return successResponse({
    success: true,
    combat_id: encounter.combat_id,
    sector_id: encounter.sector_id,
    round: encounter.round,
  });
}

async function emitRoundWaitingEvents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  encounter: CombatEncounterState,
  requestId: string,
  taskId: string | null,
  justJoinedIds?: Set<string>,
): Promise<void> {
  const payload = buildRoundWaitingPayload(encounter, { justJoinedIds });
  const source = buildEventSource("combat.round_waiting", requestId);
  payload.source = source;

  // Get direct participant IDs and corp IDs for visibility
  const directRecipients = collectParticipantIds(encounter);
  const corpIds = getCorpIdsFromParticipants(encounter.participants);

  // Compute ALL recipients: participants + sector observers + corp members (deduped)
  const allRecipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds,
    directRecipients,
  });

  if (allRecipients.length === 0) {
    return;
  }

  await recordBroadcastByCorp({
    supabase,
    eventType: "combat.round_waiting",
    scope: "sector",
    payload,
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null,
    recipients: allRecipients,
    stakeholderCorpIds: corpIds,
    taskId,
  });
}
