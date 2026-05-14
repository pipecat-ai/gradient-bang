import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  type AuthContext,
  authenticate,
  authErrorResponse,
  canActOnCharacter,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { buildEventSource, emitCharacterEvent } from "../_shared/events.ts";
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(traced("task_cancel", async (req, trace) => {
  let auth: AuthContext;
  try {
    auth = await authenticate(req);
  } catch (err) {
    return authErrorResponse(err);
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) return response;
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterId = requireString(payload, "character_id");
    const taskId = requireString(payload, "task_id");
    const forceFlag = payload.force === true;

    if (!(await canActOnCharacter(auth, characterId, supabase))) {
      return errorResponse("forbidden", 403);
    }

    trace.setInput({ characterId, taskId, requestId, force: forceFlag });

    const sQueryTask = trace.span("query_task");
    let query = supabase
      .from("events")
      .select(
        "id, character_id, actor_character_id, task_id, task_id_prefix, ship_id",
      )
      .eq("event_type", "task.start")
      .order("timestamp", { ascending: false });

    const isShortId = taskId.length <= 12;
    if (isShortId) {
      query = query.ilike("task_id_prefix", `${taskId}%`);
    } else {
      query = query.eq("task_id", taskId);
    }

    const { data: taskStartEvents, error: queryError } = await query.limit(
      isShortId ? 2 : 1,
    );
    sQueryTask.end();

    if (queryError) {
      console.error("task_cancel.query_error", queryError);
      return errorResponse("Failed to validate task ownership", 500);
    }

    if (!taskStartEvents || taskStartEvents.length === 0) {
      return errorResponse(`Task ${taskId} not found`, 404);
    }

    if (isShortId && taskStartEvents.length > 1) {
      console.warn("task_cancel.short_id_ambiguous_latest_wins", {
        task_id_prefix: taskId,
        match_count: taskStartEvents.length,
      });
    }

    const taskRow = taskStartEvents[0];
    const taskOwnerCharacterId = taskRow.character_id as string | null;
    const actorCharacterId = taskRow.actor_character_id as string | null;
    const fullTaskId = taskRow.task_id as string | null;
    // Fall back to character_id for corp ships (where ship_id == pseudo-char).
    const taskShipId = (taskRow.ship_id as string | null) ??
      taskOwnerCharacterId;

    if (!taskOwnerCharacterId || !fullTaskId || !taskShipId) {
      return errorResponse("Invalid task metadata", 500);
    }

    // Determine if this is a corp ship task by checking ship_instances.
    const sAuthCheck = trace.span("authorization_check");
    let taskCorpId: string | null = null;
    const { data: shipData, error: shipError } = await supabase
      .from("ship_instances")
      .select(
        "owner_type, owner_corporation_id, byoa_owner_character_id",
      )
      .eq("ship_id", taskOwnerCharacterId)
      .maybeSingle();

    if (shipError) {
      sAuthCheck.end();
      console.error("task_cancel.ship_lookup_error", shipError);
      return errorResponse("Failed to validate task ownership", 500);
    }

    if (shipData?.owner_type === "corporation") {
      taskCorpId = shipData.owner_corporation_id ?? null;
    }

    // Resolve requester corporation
    const { data: membership } = await supabase
      .from("corporation_members")
      .select("corp_id")
      .eq("character_id", characterId)
      .is("left_at", null)
      .maybeSingle();

    const requesterCorpId = membership?.corp_id ?? null;

    const isRequesterOwner = characterId === taskOwnerCharacterId;
    const isRequesterActor = actorCharacterId
      ? characterId === actorCharacterId
      : false;
    const isCorpShipTask = Boolean(taskCorpId);
    const isSameCorp = Boolean(
      taskCorpId && requesterCorpId && taskCorpId === requesterCorpId,
    );

    // BYOA restricts cancel to the owner (or task actor) in normal mode.
    // force=true lets any corp member override the BYOA-owner-only check so
    // a corpmate can emit a cancel event even when the owner is unreachable.
    const byoaOwnerId = typeof shipData?.byoa_owner_character_id === "string"
      ? (shipData.byoa_owner_character_id as string)
      : null;
    const isByoaShip = Boolean(byoaOwnerId);
    const isRequesterByoaOwner = Boolean(
      byoaOwnerId && characterId === byoaOwnerId,
    );

    // Authorization rules:
    // - Task owner or actor can cancel their own tasks (normal mode)
    // - Any corp member can cancel corp ship tasks (normal mode), UNLESS
    //   the ship is BYOA — then only the BYOA owner (or task actor) may cancel
    // - force=true: requester must be a corp member of a corp ship; bypasses
    //   the BYOA owner-only check so a corpmate can emit a cancel event for
    //   a BYOA-owned ship when the owner is unreachable.
    if (forceFlag) {
      if (!(isCorpShipTask && isSameCorp)) {
        sAuthCheck.end();
        return errorResponse(
          "force=true is only allowed for corp members on corp ships",
          403,
        );
      }
    } else if (isByoaShip) {
      if (!(isRequesterByoaOwner || isRequesterActor)) {
        sAuthCheck.end();
        return new Response(
          JSON.stringify({
            error: "byoa_private_not_owner",
            ship_id: taskShipId,
            byoa_owner_character_id_prefix: byoaOwnerId!
              .replace(/-/g, "")
              .slice(0, 12),
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    } else if (
      !(isRequesterOwner || isRequesterActor || (isCorpShipTask && isSameCorp))
    ) {
      sAuthCheck.end();
      return errorResponse(
        "You do not have permission to cancel this task",
        403,
      );
    }
    sAuthCheck.end();

    const cancelTaskId = fullTaskId;
    const cancelOwnerCharacterId = taskOwnerCharacterId;

    // Task events are actor-private — see task_lifecycle for the full
    // rationale. The cancel event goes to the task owner directly; if a
    // corpmate triggered the cancel, they do NOT get a copy in their UI.
    // Anyone who cares can query task history or corporation_info.
    const sEmit = trace.span("emit_event");
    await emitCharacterEvent({
      supabase,
      characterId: cancelOwnerCharacterId,
      eventType: "task.cancel",
      payload: {
        source: buildEventSource("task_cancel", requestId),
        task_id: cancelTaskId,
        cancelled_by: characterId,
        ship_id: taskShipId,
        task_scope: isCorpShipTask ? "corp_ship" : "player_ship",
        ...(forceFlag ? { force: true } : {}),
      },
      senderId: characterId,
      actorCharacterId: characterId,
      requestId,
      taskId: cancelTaskId,
      recipientReason: "task_owner",
      scope: "self",
      corpId: taskCorpId ?? undefined,
    });
    sEmit.end();

    trace.setOutput({ request_id: requestId, task_id: cancelTaskId });
    return successResponse({
      request_id: requestId,
      task_id: cancelTaskId,
      message: "Cancel event emitted",
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) return validationResponse;
    console.error("task_cancel.error", err);
    return errorResponse(
      err instanceof Error ? err.message : "task cancel failed",
      500,
    );
  }
}));
