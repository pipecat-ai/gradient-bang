import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { buildEventSource, emitCharacterEvent } from "../_shared/events.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  resolveRequestId,
  respondWithError,
  RequestValidationError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

/**
 * Task lifecycle event emitter.
 *
 * This edge function emits task.start and task.finish events for TaskAgent executions.
 * These events enable querying historical tasks and their associated events.
 *
 * Events emitted:
 * - task.start: When a task begins, includes task description
 * - task.finish: When a task completes, includes summary/result
 */
Deno.serve(traced("task_lifecycle", async (req, trace) => {
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
    console.error("task_lifecycle.parse", err);
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
    const eventType = requireString(payload, "event_type");

    trace.setInput({ characterId, taskId, eventType, requestId });

    const taskDescription = optionalString(payload, "task_description");
    const taskSummary = optionalString(payload, "task_summary");
    const taskStatusRaw = optionalString(payload, "task_status");
    const actorCharacterIdRaw = optionalString(payload, "actor_character_id");
    const actorCharacterNameRaw = optionalString(
      payload,
      "actor_character_name",
    );
    const taskScopeRaw = optionalString(payload, "task_scope");
    const shipIdRaw = optionalString(payload, "ship_id");
    const shipNameRaw = optionalString(payload, "ship_name");
    const shipTypeRaw = optionalString(payload, "ship_type");

    // Validate event_type
    if (!["start", "finish"].includes(eventType)) {
      return errorResponse("event_type must be 'start' or 'finish'", 400);
    }

    const eventName = eventType === "start" ? "task.start" : "task.finish";

    // Build event payload
    const eventPayload: Record<string, unknown> = {
      source: buildEventSource("task_lifecycle", requestId),
      task_id: taskId,
      event_type: eventType,
    };

    const actorCharacterId = actorCharacterIdRaw ?? characterId;
    eventPayload.actor_character_id = actorCharacterId;

    const sLoadState = trace.span("load_state");
    if (actorCharacterNameRaw) {
      eventPayload.actor_character_name = actorCharacterNameRaw;
    } else {
      // Load actor name (best-effort)
      const { data: actorRow } = await supabase
        .from("characters")
        .select("name")
        .eq("character_id", actorCharacterId)
        .maybeSingle();
      if (actorRow?.name) {
        eventPayload.actor_character_name = actorRow.name;
      }
    }

    // Parse and validate the raw ship_id input.
    // We strip brackets and lowercase, then treat any hex string ≥6 chars
    // as a prefix to match against ship_id (full UUIDs are just long prefixes).
    const rawLookup = shipIdRaw?.trim().replace(/[\[\]]/g, "").replace(/-/g, "") || null;
    const lookupId = rawLookup?.toLowerCase() || null;

    if (lookupId && (lookupId.length < 6 || !/^[0-9a-f]+$/i.test(lookupId))) {
      throw new RequestValidationError(
        "ship_id must be a UUID or 6+ character hex prefix",
        400,
      );
    }

    // Fetch corp membership (needed for ship access and event visibility).
    const { data: membership } = await supabase
      .from("corporation_members")
      .select("corp_id")
      .eq("character_id", characterId)
      .is("left_at", null)
      .maybeSingle();
    const playerCorpId: string | null = membership?.corp_id ?? null;

    // Also check if characterId is itself a corp pseudo-character (ship_id == characterId).
    let pseudoCharCorpId: string | null = null;
    if (!playerCorpId) {
      const { data: shipData } = await supabase
        .from("ship_instances")
        .select("owner_type, owner_corporation_id")
        .eq("ship_id", characterId)
        .maybeSingle();
      if (shipData?.owner_type === "corporation") {
        pseudoCharCorpId = shipData.owner_corporation_id as string ?? null;
      }
    }

    // Single query: fetch ALL ships this player can control.
    // This includes their personal ship (owner_character_id = characterId)
    // and all corp ships (owner_corporation_id = playerCorpId).
    const orClauses = [`owner_character_id.eq.${characterId}`];
    const effectiveCorpId = playerCorpId ?? pseudoCharCorpId ?? null;
    if (effectiveCorpId) {
      orClauses.push(`owner_corporation_id.eq.${effectiveCorpId}`);
    }
    const { data: accessibleShips, error: shipLookupError } = await supabase
      .from("ship_instances")
      .select(
        "ship_id, ship_name, ship_type, owner_type, owner_character_id, owner_corporation_id",
      )
      .or(orClauses.join(","));

    if (shipLookupError) {
      console.error("task_lifecycle.ship_lookup", shipLookupError);
      throw new Error("Failed to look up ship");
    }

    const ships = accessibleShips ?? [];

    // Resolve the target ship from the accessible list.
    let shipRow: Record<string, unknown> | null = null;

    if (!lookupId) {
      // No ship_id provided: default to the player's personal ship,
      // or the corp ship whose pseudo-character IS the characterId.
      shipRow = ships.find(
        (s) => s.owner_character_id === characterId || s.ship_id === characterId,
      ) ?? null;
    } else {
      // Match by ship_id prefix (full UUIDs are just 32-char prefixes).
      // Also check owner_character_id for the case where the agent passes
      // the player's character ID instead of their ship ID.
      const stripDashes = (v: string) => v.replace(/-/g, "").toLowerCase();
      const matches = ships.filter((s) => {
        const sid = stripDashes(s.ship_id as string);
        const oid = s.owner_character_id ? stripDashes(s.owner_character_id as string) : null;
        return sid.startsWith(lookupId) || oid?.startsWith(lookupId);
      });
      if (matches.length > 1) {
        throw new RequestValidationError(
          "Ship id prefix is ambiguous; use full ship_id",
          409,
        );
      }
      shipRow = matches[0] ?? null;
      if (!shipRow) {
        throw new RequestValidationError("Ship not found", 404);
      }
    }

    const shipId: string | null = (shipRow?.ship_id as string) ?? null;
    const shipName: string | null =
      shipNameRaw ?? (shipRow?.ship_name as string) ?? null;
    const shipType: string | null =
      shipTypeRaw ?? (shipRow?.ship_type as string) ?? null;
    let taskScope: "player_ship" | "corp_ship" =
      taskScopeRaw === "corp_ship" ? "corp_ship" : "player_ship";

    if (shipRow?.owner_type === "corporation") {
      taskScope = "corp_ship";
    }
    sLoadState.end();

    eventPayload.task_scope = taskScope;
    if (shipId) eventPayload.ship_id = shipId;
    if (shipName) eventPayload.ship_name = shipName;
    if (shipType) eventPayload.ship_type = shipType;

    if (eventType === "start" && taskDescription) {
      eventPayload.task_description = taskDescription;
    }

    if (eventType === "finish") {
      const taskStatus = taskStatusRaw ?? "completed";
      eventPayload.task_status = taskStatus;
      if (taskSummary) {
        eventPayload.task_summary = taskSummary;
      }
    }

    // Task events are actor-private. Whether the ship is personal or
    // corp-owned, only the acting character sees task lifecycle updates in
    // their UI and LLM context. Cross-member awareness of ship busyness is
    // enforced synchronously at start_task time (the server rejects an
    // attempt to start a second task on a ship whose current_task_id is
    // already set) — not by fanning out task events to corpmates.
    const sEmit = trace.span("emit_event");
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: eventName,
      payload: eventPayload,
      senderId: characterId,
      actorCharacterId: actorCharacterId ?? undefined,
      requestId,
      taskId,
      shipId: shipId ?? undefined,
      corpId: taskScope === "corp_ship" ? (effectiveCorpId ?? undefined) : undefined,
      recipientReason: "task_owner",
      scope: "self",
    });
    sEmit.end();

    trace.setOutput({ request_id: requestId, task_id: taskId, event_type: eventType });
    return successResponse({
      request_id: requestId,
      task_id: taskId,
      event_type: eventType,
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error("task_lifecycle.error", err);
    const detail =
      err instanceof Error ? err.message : "task lifecycle event failed";
    return errorResponse(detail, 500);
  }
}));

