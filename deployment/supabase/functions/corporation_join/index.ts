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
import { loadCharacter } from "../_shared/status.ts";
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

    if (isLastMember) {
      // Refuse upfront if the old corp still owns ships — user must sell
      // them via sell_ship before switching. No pending event; we want a
      // clear error the LLM can relay, not a modal.
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

      if (!confirm) {
        // Two-step confirm: emit a character-scoped pending event so ONLY
        // the joiner's client opens the "this will disband your corp"
        // modal. No state changes.
        const source = buildEventSource("corporation_join", requestId);
        await emitCharacterEvent({
          supabase,
          characterId,
          eventType: "corporation.join_pending",
          payload: {
            source,
            corp_id: corpId,
            corp_name: corporation.name,
            invite_code: inviteCode ?? "",
            old_corp_id: oldCorp.corp_id,
            old_corp_name: oldCorp.name,
            will_disband: true,
            timestamp: new Date().toISOString(),
          },
          requestId,
          taskId,
        });
        return {
          success: true,
          pending: true,
          will_disband: true,
          corp_id: corpId,
          corp_name: corporation.name,
          old_corp_id: oldCorp.corp_id,
          old_corp_name: oldCorp.name,
        };
      }

      // Confirmed: disband the old corp (shared helper performs the full
      // cascade: release any residual ships, emit disbanded, soft-delete).
      await markCorporationMembershipLeft(
        supabase,
        oldCorp.corp_id,
        characterId,
        new Date().toISOString(),
      );
      try {
        await disbandCorporation(supabase, {
          corpId: oldCorp.corp_id,
          corporationName: oldCorp.name,
          characterId,
          reason: "last_member_joined_other",
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
      // Not last member — silent auto-leave, no confirmation needed. The
      // old corp continues with the remaining members.
      const leaveTimestamp = new Date().toISOString();
      await markCorporationMembershipLeft(
        supabase,
        oldCorp.corp_id,
        characterId,
        leaveTimestamp,
      );
      const remainingOld = await fetchCorporationMembers(
        supabase,
        oldCorp.corp_id,
      );
      const departedName =
        typeof character.name === "string" && character.name.trim().length > 0
          ? character.name.trim()
          : characterId;
      const source = buildEventSource("corporation_join", requestId);
      await emitCorporationEvent(supabase, oldCorp.corp_id, {
        eventType: "corporation.member_left",
        payload: {
          source,
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

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationJoinError(
      "actor_character_id must match character_id for corporation.join",
      400,
    );
  }
}
