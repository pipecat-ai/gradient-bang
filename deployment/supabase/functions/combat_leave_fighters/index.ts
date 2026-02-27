import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { acquirePg, releasePg } from "../_shared/pg.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  emitSectorEnvelope,
  buildEventSource,
  recordEventWithRecipients,
} from "../_shared/events.ts";
import { buildSectorSnapshot, buildSectorGarrisonMapUpdate } from "../_shared/map.ts";
import {
  pgLoadCharacter,
  pgLoadShip,
  pgEnforceRateLimit,
  pgEnsureActorAuthorization,
  pgComputeCorpMemberRecipients,
  RateLimitError,
  ActorAuthorizationError,
} from "../_shared/pg_queries.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import {
  loadCharacterCombatants,
  loadCharacterNames,
  loadGarrisonCombatants,
} from "../_shared/combat_participants.ts";
import {
  nowIso,
  type CombatEncounterState,
  type CombatantState,
} from "../_shared/combat_types.ts";
import { getEffectiveCorporationId } from "../_shared/corporations.ts";
import {
  loadCombatForSector,
  persistCombatState,
} from "../_shared/combat_state.ts";
import {
  buildRoundWaitingPayload,
  getCorpIdsFromParticipants,
  collectParticipantIds,
} from "../_shared/combat_events.ts";
import { computeNextCombatDeadline } from "../_shared/combat_resolution.ts";
import { computeEventRecipients } from "../_shared/visibility.ts";
import { loadUniverseMeta, isFedspaceSector } from "../_shared/fedspace.ts";
import { runLeaveFightersTransaction } from "../_shared/garrison_transactions.ts";

Deno.serve(async (req: Request): Promise<Response> => {
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
    console.error("combat_leave_fighters.parse", err);
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
  const sector = optionalNumber(payload, "sector");
  const quantity = optionalNumber(payload, "quantity");
  const mode = (optionalString(payload, "mode") ?? "offensive").toLowerCase();
  const tollAmount = optionalNumber(payload, "toll_amount") ?? 0;
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  if (sector === null || sector === undefined) {
    return errorResponse("sector is required", 400);
  }
  if (quantity === null || quantity === undefined) {
    return errorResponse("quantity is required", 400);
  }

  const pg = await acquirePg();
  try {
    // Rate limiting via PG
    try {
      await pgEnforceRateLimit(pg, characterId, "combat_leave_fighters");
    } catch (err) {
      if (err instanceof RateLimitError) {
        await emitErrorEvent(supabase, {
          characterId,
          method: "combat_leave_fighters",
          requestId,
          detail: "Too many requests",
          status: 429,
        });
        return errorResponse("Too many requests", 429);
      }
      console.error("combat_leave_fighters.rate_limit", err);
      return errorResponse("rate limit error", 500);
    }

    return await handleCombatLeaveFighters({
      pg,
      supabase,
      requestId,
      characterId,
      sector,
      quantity,
      mode,
      tollAmount,
      actorCharacterId,
      adminOverride,
      taskId,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_leave_fighters",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("combat_leave_fighters.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    await emitErrorEvent(supabase, {
      characterId,
      method: "combat_leave_fighters",
      requestId,
      detail: err instanceof Error ? err.message : "leave fighters failed",
      status,
    });
    return errorResponse("leave fighters error", status);
  } finally {
    releasePg(pg);
  }
});

async function handleCombatLeaveFighters(params: {
  pg: Client;
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  sector: number;
  quantity: number;
  mode: string;
  tollAmount: number;
  actorCharacterId: string | null;
  adminOverride: boolean;
  taskId: string | null;
}): Promise<Response> {
  const {
    pg,
    supabase,
    requestId,
    characterId,
    sector,
    quantity,
    mode,
    tollAmount,
    actorCharacterId,
    adminOverride,
    taskId,
  } = params;

  // Validate quantity
  if (quantity <= 0) {
    const err = new Error("Quantity must be positive") as Error & {
      status?: number;
    };
    err.status = 400;
    throw err;
  }

  // Validate mode
  if (!["offensive", "defensive", "toll"].includes(mode)) {
    const err = new Error("Invalid garrison mode") as Error & {
      status?: number;
    };
    err.status = 400;
    throw err;
  }

  // Normalize toll amount
  let effectiveTollAmount = tollAmount;
  if (mode !== "toll") {
    effectiveTollAmount = 0;
  }

  // Load character and ship via PG
  const character = await pgLoadCharacter(pg, characterId);
  const ship = await pgLoadShip(pg, character.current_ship_id);

  // Actor authorization via PG
  await pgEnsureActorAuthorization(pg, {
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  // Verify character is in the correct sector
  if (ship.current_sector !== sector) {
    console.log(
      `combat_leave_fighters.sector_mismatch char=${characterId} ship_sector=${ship.current_sector} requested=${sector}`,
    );
    const err = new Error(
      `Character in sector ${ship.current_sector}, not requested sector ${sector}`,
    ) as Error & { status?: number };
    err.status = 409;
    throw err;
  }

  const universeMeta = await loadUniverseMeta(supabase);
  if (await isFedspaceSector(supabase, sector, universeMeta)) {
    const err = new Error(
      "Garrisons cannot be deployed in Federation Space",
    ) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const { newShipFighters, garrison: updatedGarrison } =
    await runLeaveFightersTransaction(pg, {
      sectorId: sector,
      characterId,
      shipId: ship.ship_id,
      quantity,
      mode,
      tollAmount: effectiveTollAmount,
    });

  // Build garrison payload for events
  const garrisonPayload = {
    owner_name: character.name, // Human-readable name, not UUID
    fighters: updatedGarrison.fighters,
    fighter_loss: null,
    mode: updatedGarrison.mode,
    toll_amount: updatedGarrison.toll_amount,
    deployed_at: updatedGarrison.deployed_at,
    is_friendly: true, // Garrison is always friendly to its owner
  };

  // Emit garrison.deployed event to character
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "garrison.deployed",
    payload: {
      source: buildEventSource("combat.leave_fighters", requestId),
      sector: { id: sector },
      garrison: garrisonPayload,
      fighters_remaining: newShipFighters,
    },
    senderId: characterId,
    sectorId: sector,
    requestId,
    taskId,
    shipId: ship.ship_id,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  // Emit sector.update to all sector occupants with full sector snapshot
  const sectorSnapshot = await buildSectorSnapshot(supabase, sector);
  await emitSectorEnvelope({
    supabase,
    sectorId: sector,
    eventType: "sector.update",
    payload: {
      source: buildEventSource("combat.leave_fighters", requestId),
      ...sectorSnapshot,
    },
    requestId,
    actorCharacterId: characterId,
  });

  // Emit map.update so the garrison appears on discovered maps
  const mapUpdatePayload = await buildSectorGarrisonMapUpdate(supabase, sector);
  const mapCorpRecipients = character.corporation_id
    ? await pgComputeCorpMemberRecipients(pg, [character.corporation_id], [characterId])
    : [];
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "map.update",
    payload: {
      source: buildEventSource("combat.leave_fighters", requestId),
      ...mapUpdatePayload,
    } as Record<string, unknown>,
    sectorId: sector,
    requestId,
    taskId,
    corpId: character.corporation_id,
    additionalRecipients: mapCorpRecipients,
  });

  // If mode is 'offensive', auto-initiate combat with sector occupants
  if (mode === "offensive") {
    await autoInitiateCombatIfOffensive({
      supabase,
      characterId,
      shipId: ship.ship_id,
      sector,
      requestId,
      garrisonFighters: updatedGarrison.fighters,
    });
  }

  return successResponse({ success: true });
}

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

async function autoInitiateCombatIfOffensive(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  shipId: string;
  sector: number;
  requestId: string;
  garrisonFighters: number;
}): Promise<void> {
  const { supabase, characterId, shipId, sector, requestId, garrisonFighters } =
    params;

  // Load all character combatants in the sector
  const participantStates = await loadCharacterCombatants(supabase, sector);

  // Get garrison owner's effective corporation (membership OR ship ownership for corp-owned ships)
  const ownerCorpId = await getEffectiveCorporationId(
    supabase,
    characterId,
    shipId,
  );

  // Find targetable opponents (exclude self, corp members, escape pods, no-fighter ships)
  const opponents = participantStates.filter((participant) => {
    if (participant.combatant_id === characterId) return false;
    if (participant.is_escape_pod) return false;
    if ((participant.fighters ?? 0) <= 0) return false;

    // Check if same corporation
    if (ownerCorpId && participant.metadata?.corporation_id === ownerCorpId)
      return false;

    return true;
  });

  // No opponents to fight
  if (opponents.length === 0) {
    return;
  }

  // Check if combat already exists in this sector
  const existingEncounter = await loadCombatForSector(supabase, sector);
  if (existingEncounter && !existingEncounter.ended) {
    // Combat already ongoing, don't create a new one
    return;
  }

  // Load character names for garrison display
  const ownerNames = await loadCharacterNames(
    supabase,
    participantStates.map(
      (state) => state.owner_character_id ?? state.combatant_id,
    ),
  );

  // Load all garrisons (including the one just deployed)
  const garrisons = await loadGarrisonCombatants(supabase, sector, ownerNames);

  // Build participants map
  const participants: Record<string, CombatantState> = {};
  for (const state of participantStates) {
    participants[state.combatant_id] = state;
  }
  for (const garrison of garrisons) {
    participants[garrison.state.combatant_id] = garrison.state;
  }

  // Must have at least 2 participants
  if (Object.keys(participants).length < 2) {
    return;
  }

  // Create new combat encounter
  const combatId = generateCombatId();
  const encounter: CombatEncounterState = {
    combat_id: combatId,
    sector_id: sector,
    round: 1,
    deadline: computeNextCombatDeadline(),
    participants,
    pending_actions: {},
    logs: [],
    context: {
      initiator: characterId,
      created_at: nowIso(),
      garrison_sources: garrisons.map((g) => g.source),
      reason: "garrison_deploy_auto",
    },
    awaiting_resolution: false,
    ended: false,
    end_state: null,
    base_seed: deterministicSeed(combatId),
    last_updated: nowIso(),
  };

  // Persist combat state
  await persistCombatState(supabase, encounter);

  // Emit combat.round_waiting events to all participants
  await emitRoundWaitingEvents(supabase, encounter, requestId, characterId);
}

async function emitRoundWaitingEvents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  encounter: CombatEncounterState,
  requestId: string,
  senderId: string | null,
): Promise<void> {
  const payload = buildRoundWaitingPayload(encounter);
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

  // Single emission to all unique recipients
  await recordEventWithRecipients({
    supabase,
    eventType: "combat.round_waiting",
    scope: "sector",
    payload,
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null, // System-originated
    recipients: allRecipients,
  });
}
