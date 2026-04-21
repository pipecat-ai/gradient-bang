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
  loadCorporationById,
  markCorporationMembershipLeft,
  normalizeInviteCode,
  upsertCorporationMembership,
  type CorporationRecord,
} from "../_shared/corporations.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { traced } from "../_shared/weave.ts";

class CorporationJoinError extends Error {
  status: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CorporationJoinError";
    this.status = status;
    this.details = details;
  }
}

Deno.serve(traced("corporation_join", async (req, trace) => {
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
    console.error("corporation_join.parse", err);
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
  const corpId = requireString(payload, "corp_id");
  const inviteCode = optionalString(payload, "invite_code");
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const taskId = optionalString(payload, "task_id");
  const confirm = optionalBoolean(payload, "confirm") ?? false;
  ensureActorMatches(actorCharacterId, characterId);

  trace.setInput({ characterId, corpId, requestId, confirm });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "corporation_join");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "corporation_join",
        requestId,
        detail: "Too many corporation_join requests",
        status: 429,
      });
      return errorResponse("Too many corporation requests", 429);
    }
    console.error("corporation_join.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const sHandleJoin = trace.span("handle_join", {
      characterId,
      corpId,
      confirm,
    });
    const result = await handleJoin({
      supabase,
      characterId,
      characterLabel,
      corpId,
      inviteCode,
      requestId,
      taskId,
      confirm,
    });
    sHandleJoin.end(result);
    trace.setOutput({
      request_id: requestId,
      corp_id: corpId,
      pending: result.pending ?? false,
    });
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationJoinError) {
      return errorResponse(err.message, err.status, err.details);
    }
    console.error("corporation_join.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));

async function handleJoin(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  characterLabel: string;
  corpId: string;
  inviteCode: string | null;
  requestId: string;
  taskId: string | null;
  confirm: boolean;
}): Promise<Record<string, unknown>> {
  const {
    supabase,
    characterId,
    characterLabel,
    corpId,
    inviteCode,
    requestId,
    taskId,
    confirm,
  } = params;

  // Full validation on both the pending and confirm paths. The confirm
  // round-trip re-runs everything so a stale client message cannot bypass
  // a newly-regenerated invite code, a ship bought in the gap, etc.
  const { character, corporation, oldCorp } = await validateJoin({
    supabase,
    characterId,
    corpId,
    inviteCode,
  });

  // Case: auto-leave from a different corp is required.
  if (oldCorp) {
    const oldMembers = await fetchCorporationMembers(supabase, oldCorp.corp_id);
    const isLastMember =
      oldMembers.length === 1 && oldMembers[0].character_id === characterId;
    const isOldCorpFounder = oldCorp.founder_id === characterId;
    const willDisband = isLastMember || isOldCorpFounder;

    // Block if disbanding would lose ships.
    if (willDisband) {
      const oldShips = await fetchCorporationShipSummaries(
        supabase,
        oldCorp.corp_id,
      );
      if (oldShips.length > 0) {
        throw new CorporationJoinError(
          `You own ${oldShips.length} corporation ship(s). Sell them before switching corporations.`,
          400,
          {
            ships: oldShips.map((ship) => ({
              ship_id: ship.ship_id,
              ship_type: ship.ship_type,
              name: ship.name,
              sector: ship.sector,
            })),
            old_corp_id: oldCorp.corp_id,
            old_corp_name: oldCorp.name,
          },
        );
      }
    }

    if (!confirm) {
      // Two-step confirm: emit a character-scoped pending event so ONLY
      // the joiner's client opens the leave confirmation modal. No state
      // changes. Uses corporation.leave_pending (unified with explicit
      // leave flow) with joining context so the dialog and confirm
      // handler know to complete the join after leaving.
      const source = buildEventSource("corporation_join", requestId);
      await emitCharacterEvent({
        supabase,
        characterId,
        eventType: "corporation.leave_pending",
        payload: {
          source,
          corp_id: oldCorp.corp_id,
          corp_name: oldCorp.name,
          is_founder: isOldCorpFounder,
          will_disband: willDisband,
          member_count: oldMembers.length,
          joining_corp_id: corpId,
          joining_corp_name: corporation.name,
          joining_invite_code: inviteCode ?? "",
          timestamp: new Date().toISOString(),
        },
        requestId,
        taskId,
      });
      return {
        success: true,
        pending: true,
        will_disband: willDisband,
        is_founder: isOldCorpFounder,
        member_count: oldMembers.length,
        corp_id: corpId,
        corp_name: corporation.name,
        old_corp_id: oldCorp.corp_id,
        old_corp_name: oldCorp.name,
      };
    }

    // Confirmed — execute the leave from old corp.
    const leaveTimestamp = new Date().toISOString();
    const leaveSource = buildEventSource("corporation_join", requestId);

    // If founder with other members, evict everyone before disbanding.
    if (isOldCorpFounder && !isLastMember) {
      const otherMembers = oldMembers.filter(
        (m) => m.character_id !== characterId,
      );
      const otherMemberIds = otherMembers.map((m) => m.character_id);

      for (const memberId of otherMemberIds) {
        await markCorporationMembershipLeft(
          supabase, oldCorp.corp_id, memberId, leaveTimestamp,
        );
      }
      const { error: batchUpdateError } = await supabase
        .from("characters")
        .update({
          corporation_id: null,
          corporation_joined_at: null,
          last_active: leaveTimestamp,
        })
        .in("character_id", otherMemberIds);
      if (batchUpdateError) {
        console.error("corporation_join.batch_evict", batchUpdateError);
        throw new CorporationJoinError(
          "Failed to remove old corporation members", 500,
        );
      }

      // Notify each evicted member.
      for (const memberId of otherMemberIds) {
        await emitCharacterEvent({
          supabase,
          characterId: memberId,
          eventType: "corporation.data",
          payload: { source: leaveSource, corporation: null },
          requestId,
          taskId,
        });
        await emitCharacterLeaveEvents(supabase, {
          characterId: memberId,
          source: leaveSource,
          requestId,
          taskId,
        });
      }
    }

    // Mark own membership left.
    await markCorporationMembershipLeft(
      supabase, oldCorp.corp_id, characterId, leaveTimestamp,
    );

    if (willDisband) {
      const reason = isOldCorpFounder && !isLastMember
        ? "founder_disbanded" as const
        : "last_member_joined_other" as const;
      try {
        await disbandCorporation(supabase, {
          corpId: oldCorp.corp_id,
          corporationName: oldCorp.name,
          characterId,
          reason,
          requestId,
          taskId,
          method: "corporation_join",
        });
      } catch (err) {
        console.error("corporation_join.auto_disband", err);
        throw new CorporationJoinError(
          err instanceof Error ? err.message : "Failed to disband old corporation",
          500,
        );
      }
    } else {
      // Non-founder, not last member — notify remaining members.
      const remainingOld = await fetchCorporationMembers(
        supabase,
        oldCorp.corp_id,
      );
      const departedName =
        typeof character.name === "string" && character.name.trim().length > 0
          ? character.name.trim()
          : characterId;
      await emitCorporationEvent(supabase, oldCorp.corp_id, {
        eventType: "corporation.member_left",
        payload: {
          source: leaveSource,
          corp_id: oldCorp.corp_id,
          corp_name: oldCorp.name,
          departed_member_id: departedName,
          departed_member_name: departedName,
          member_count: remainingOld.length,
          timestamp: leaveTimestamp,
        },
        requestId,
        taskId,
      });
    }
  }

  const timestamp = new Date().toISOString();
  const memberName =
    typeof character.name === "string" && character.name.trim().length > 0
      ? character.name.trim()
      : characterId;
  await upsertCorporationMembership(supabase, corpId, characterId, timestamp);

  const { error: characterUpdateError } = await supabase
    .from("characters")
    .update({
      corporation_id: corpId,
      corporation_joined_at: timestamp,
      last_active: timestamp,
    })
    .eq("character_id", characterId);
  if (characterUpdateError) {
    console.error("corporation_join.character_update", characterUpdateError);
    throw new CorporationJoinError("Failed to update character state", 500);
  }

  const members = await fetchCorporationMembers(supabase, corpId);
  const source = buildEventSource("corporation_join", requestId);
  const eventPayload = {
    source,
    corp_id: corpId,
    name: corporation.name,
    member_id: memberName, // Use display name for legacy compatibility
    member_name: memberName,
    // Canonical character id so the client can reliably distinguish
    // "you joined" vs "someone else joined your corp" without matching
    // on display name. The legacy `member_id` is a name for backward
    // compat with existing consumers.
    actor_character_id: characterId,
    member_count: members.length,
    timestamp,
  };

  await emitCorporationEvent(supabase, corpId, {
    eventType: "corporation.member_joined",
    payload: eventPayload,
    requestId,
    actorCharacterId: characterId,
    taskId,
  });

  // Emit status.update (sets corp on client, triggers map invalidation)
  // and map.local (corp-merged sectors for the local/big map).
  const ship = await loadShip(supabase, character.current_ship_id);
  const sectorId = ship.current_sector ?? null;
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
  const mapPayload = { ...mapResult, source };
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "status.update",
    payload: statusPayload,
    sectorId,
    requestId,
    corpId,
    taskId,
    shipId: ship.ship_id,
  });
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "map.local",
    payload: mapPayload,
    sectorId,
    requestId,
    corpId,
    taskId,
    shipId: ship.ship_id,
  });

  return {
    success: true,
    corp_id: corpId,
    name: corporation.name,
    member_count: members.length,
  };
}

/**
 * Run the full validation path: load character + target corp, enforce invite
 * code (with a founder-rejoin carve-out), and resolve whether an auto-leave
 * from a different corp is needed. Called at the start of both the pending
 * and confirm paths — re-running everything on confirm means a stale client
 * message can't bypass a newly-regenerated invite code or a just-bought
 * corp ship.
 */
async function validateJoin(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  corpId: string;
  inviteCode: string | null;
}): Promise<{
  character: Awaited<ReturnType<typeof loadCharacter>>;
  corporation: CorporationRecord;
  oldCorp: CorporationRecord | null;
}> {
  const { supabase, characterId, corpId, inviteCode } = params;
  const character = await loadCharacter(supabase, characterId);

  let corporation: CorporationRecord;
  try {
    corporation = await loadCorporationById(supabase, corpId);
  } catch (err) {
    if (err instanceof Error) {
      // "Corporation not found" (row missing) and "Failed to load corporation
      // data" (invalid UUID) both surface as 404 to the caller.
      if (
        err.message.includes("Corporation not found") ||
        err.message.includes("Failed to load corporation data")
      ) {
        throw new CorporationJoinError("Corporation not found", 404);
      }
    }
    throw err;
  }
  if (corporation.disbanded_at) {
    throw new CorporationJoinError("Corporation has been disbanded", 400);
  }

  // Already an active member of the target corp → no-op disallowed.
  if (character.corporation_id === corpId) {
    throw new CorporationJoinError(
      "Already a member of this corporation",
      400,
    );
  }

  // Invite code validation, with founder-rejoin carve-out. A founder trying
  // to rejoin their own (not-disbanded) corp doesn't need to provide the
  // code — they originally created it. Any other joiner must match it.
  const isFounderRejoin = corporation.founder_id === characterId;
  if (!isFounderRejoin) {
    // normalizeInviteCode tolerates speech input ("nebula cortex"), mixed
    // case, underscores, and extra whitespace — folding all separators into
    // the canonical single-dash form before comparison.
    const provided = normalizeInviteCode(inviteCode);
    const expected = normalizeInviteCode(corporation.invite_code);
    if (!provided) {
      throw new CorporationJoinError("Invite code is required", 400);
    }
    if (!expected || expected !== provided) {
      throw new CorporationJoinError("Invalid invite code", 400);
    }
  }

  let oldCorp: CorporationRecord | null = null;
  if (character.corporation_id && character.corporation_id !== corpId) {
    try {
      oldCorp = await loadCorporationById(supabase, character.corporation_id);
    } catch (err) {
      // If the old corp row is missing (shouldn't happen in practice),
      // fall through — the character_id pointer is stale and we'll just
      // overwrite it on join.
      console.error("corporation_join.old_corp_load", err);
      oldCorp = null;
    }
  }

  return { character, corporation, oldCorp };
}

/**
 * Emit status.update + map.local for a character who just lost corp
 * membership, so their client rebuilds with personal-only data.
 */
async function emitCharacterLeaveEvents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  params: {
    characterId: string;
    source: ReturnType<typeof buildEventSource>;
    requestId: string;
    taskId: string | null;
  },
): Promise<void> {
  const { characterId, source, requestId, taskId } = params;
  const char = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, char.current_ship_id);
  const sectorId = ship.current_sector ?? null;
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
    sectorId,
    requestId,
    taskId,
    shipId: ship.ship_id,
  });
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "map.local",
    payload: { ...mapResult, source },
    sectorId,
    requestId,
    taskId,
    shipId: ship.ship_id,
  });
}

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationJoinError(
      "actor_character_id must match character_id for corporation.join",
      400,
    );
  }
}
