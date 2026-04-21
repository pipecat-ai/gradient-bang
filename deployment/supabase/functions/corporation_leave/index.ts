import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  buildEventSource,
  emitCharacterEvent,
  emitErrorEvent,
} from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { loadCharacter, loadShip } from "../_shared/status.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import { pgBuildStatusPayload, pgBuildLocalMapRegion } from "../_shared/pg_queries.ts";
import {
  disbandCorporation,
  emitCorporationEvent,
  fetchCorporationMembers,
  fetchCorporationShipSummaries,
  isActiveCorporationMember,
  loadCorporationById,
  markCorporationMembershipLeft,
} from "../_shared/corporations.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { traced } from "../_shared/weave.ts";

class CorporationLeaveError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CorporationLeaveError";
    this.status = status;
  }
}

Deno.serve(traced("corporation_leave", async (req, trace) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("corporation_leave.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const supabase = createServiceRoleClient();
  const requestId = resolveRequestId(payload);
  const rawCharacterId = requireString(payload, "character_id");
  const legacyCharacterLabel = optionalString(
    payload,
    "__legacy_character_label",
  );
  const characterLabel = legacyCharacterLabel ?? rawCharacterId;
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const actorCharacterLabel = optionalString(payload, "actor_character_id");
  const actorCharacterId = actorCharacterLabel
    ? await canonicalizeCharacterId(actorCharacterLabel)
    : null;
  const taskId = optionalString(payload, "task_id");
  const confirm = optionalBoolean(payload, "confirm") ?? false;
  ensureActorMatches(actorCharacterId, characterId);

  trace.setInput({ characterId, requestId });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "corporation_leave");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "corporation_leave",
        requestId,
        detail: "Too many corporation_leave requests",
        status: 429,
      });
      return errorResponse("Too many corporation requests", 429);
    }
    console.error("corporation_leave.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const sHandleLeave = trace.span("handle_leave", { characterId });
    const result = await handleLeave({
      supabase,
      characterId,
      characterLabel,
      requestId,
      taskId,
      confirm,
    });
    sHandleLeave.end();
    trace.setOutput({ request_id: requestId, characterId });
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationLeaveError) {
      return errorResponse(err.message, err.status);
    }
    console.error("corporation_leave.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));

async function handleLeave(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  characterLabel: string;
  requestId: string;
  taskId: string | null;
  confirm: boolean;
}): Promise<Record<string, unknown>> {
  const { supabase, characterId, characterLabel, requestId, taskId, confirm } =
    params;
  const character = await loadCharacter(supabase, characterId);
  const corpId = character.corporation_id;
  if (!corpId) {
    throw new CorporationLeaveError("Not in a corporation", 400);
  }

  const isMember = await isActiveCorporationMember(
    supabase,
    corpId,
    characterId,
  );
  if (!isMember) {
    throw new CorporationLeaveError("Not authorized for this corporation", 403);
  }

  const corporation = await loadCorporationById(supabase, corpId);
  const currentMembers = await fetchCorporationMembers(supabase, corpId);
  const isFounder = corporation.founder_id === characterId;
  const isLastMember = currentMembers.length <= 1;
  const willDisband = isLastMember || isFounder;

  // Block if leaving would disband a corp that still has ships.
  if (willDisband) {
    const corpShips = await fetchCorporationShipSummaries(supabase, corpId);
    if (corpShips.length > 0) {
      throw new CorporationLeaveError(
        `Cannot disband corporation — it still has ${corpShips.length} ship(s). Sell all corporation ships first.`,
        400,
      );
    }
  }

  // --- Phase 1: emit pending event, return without mutating ---
  if (!confirm) {
    const source = buildEventSource("corporation_leave", requestId);
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "corporation.leave_pending",
      payload: {
        source,
        corp_id: corpId,
        corp_name: corporation.name,
        is_founder: isFounder,
        will_disband: willDisband,
        member_count: currentMembers.length,
        timestamp: new Date().toISOString(),
      },
      requestId,
      taskId,
    });
    return {
      pending: true,
      corp_id: corpId,
      corp_name: corporation.name,
      is_founder: isFounder,
      will_disband: willDisband,
      member_count: currentMembers.length,
    };
  }

  // --- Phase 2: confirmed — execute the leave ---

  const timestamp = new Date().toISOString();
  const leaveSource = buildEventSource("corporation_leave", requestId);

  // If the founder is leaving (and other members exist), evict all
  // remaining members before disbanding.
  if (isFounder && !isLastMember) {
    const otherMembers = currentMembers.filter(
      (m) => m.character_id !== characterId,
    );
    const otherMemberIds = otherMembers.map((m) => m.character_id);

    // Batch-mark memberships as left.
    for (const memberId of otherMemberIds) {
      await markCorporationMembershipLeft(supabase, corpId, memberId, timestamp);
    }

    // Batch-clear corporation on all evicted characters.
    const { error: batchUpdateError } = await supabase
      .from("characters")
      .update({
        corporation_id: null,
        corporation_joined_at: null,
        last_active: timestamp,
      })
      .in("character_id", otherMemberIds);
    if (batchUpdateError) {
      console.error("corporation_leave.batch_evict", batchUpdateError);
      throw new CorporationLeaveError(
        "Failed to remove corporation members",
        500,
      );
    }

    // Notify each evicted member so their client clears corp state.
    for (const memberId of otherMemberIds) {
      await emitCharacterEvent({
        supabase,
        characterId: memberId,
        eventType: "corporation.data",
        payload: { source: leaveSource, corporation: null },
        requestId,
        taskId,
      });
    }
  }

  // Mark the leaving player's own membership and clear their corp.
  await markCorporationMembershipLeft(supabase, corpId, characterId, timestamp);

  const { error: characterUpdateError } = await supabase
    .from("characters")
    .update({
      corporation_id: null,
      corporation_joined_at: null,
      last_active: timestamp,
    })
    .eq("character_id", characterId);
  if (characterUpdateError) {
    console.error("corporation_leave.character_update", characterUpdateError);
    throw new CorporationLeaveError("Failed to update character state", 500);
  }

  // Emit corporation.data directly to the leaving user so their client
  // clears corp state and sets the map replace flag.
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "corporation.data",
    payload: { source: leaveSource, corporation: null },
    requestId,
    taskId,
  });

  // Emit status.update (clears corp on client, triggers map invalidation),
  // then map.region (consumed by setRegionalMapData which replaces stale data).
  const ship = await loadShip(supabase, character.current_ship_id);
  const leaveSectorId = ship.current_sector ?? null;
  const pgClient = await acquirePgClient();
  let statusPayload: Record<string, unknown>;
  let mapResult: Awaited<ReturnType<typeof pgBuildLocalMapRegion>>;
  try {
    [statusPayload, mapResult] = await Promise.all([
      pgBuildStatusPayload(pgClient, characterId),
      pgBuildLocalMapRegion(pgClient, {
        characterId,
        centerSector: ship.current_sector ?? 0,
        maxHops: 4,
        maxSectors: 28,
      }),
    ]);
  } finally {
    pgClient.release();
  }
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "status.update",
    payload: statusPayload,
    sectorId: leaveSectorId,
    requestId,
    taskId,
    shipId: ship.ship_id,
  });
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "map.local",
    payload: { ...mapResult, source: leaveSource },
    sectorId: leaveSectorId,
    requestId,
    taskId,
    shipId: ship.ship_id,
  });

  // Disband if this was the last member or the founder.
  if (willDisband) {
    const reason = isFounder && !isLastMember
      ? "founder_disbanded" as const
      : "last_member_left" as const;
    try {
      await disbandCorporation(supabase, {
        corpId,
        corporationName: corporation.name,
        characterId,
        reason,
        requestId,
        taskId,
        method: "corporation_leave",
      });
    } catch (err) {
      console.error("corporation_leave.disband", err);
      throw new CorporationLeaveError(
        err instanceof Error ? err.message : "Failed to disband corporation",
        500,
      );
    }
    return { success: true };
  }

  // Non-founder, corp continues — notify remaining members.
  const remainingMembers = await fetchCorporationMembers(supabase, corpId);
  const departedName =
    typeof character.name === "string" && character.name.trim().length > 0
      ? character.name.trim()
      : characterId;
  await emitCorporationEvent(supabase, corpId, {
    eventType: "corporation.member_left",
    payload: {
      source: leaveSource,
      corp_id: corpId,
      corp_name: corporation.name,
      departed_member_id: departedName,
      departed_member_name: departedName,
      member_count: remainingMembers.length,
      timestamp,
    },
    requestId,
    taskId,
  });

  return { success: true };
}

/**
 * Bake the merged personal+corp map knowledge into the character's personal
 * map_knowledge column. Must be called BEFORE corporation_id is set to null,
 * so pgLoadMapKnowledge can still access the corp knowledge. Corp-only
 * sectors are preserved with source="corp".
 */
function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationLeaveError(
      "actor_character_id must match character_id for corporation.leave",
      400,
    );
  }
}
