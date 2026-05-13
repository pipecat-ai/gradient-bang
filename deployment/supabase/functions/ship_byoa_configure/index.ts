/**
 * Edge Function: ship_byoa_configure
 *
 * Configures BYOA (Bring-Your-Own-Agent) state on a corporation ship.
 * Two actions:
 *
 *   - claim: set byoa_owner_character_id = self, byoa_mode = private
 *   - clear: set byoa_owner_character_id = NULL, byoa_mode = 'private' (default)
 *
 * Rules:
 *   - Caller must be a corp member of the ship's corp
 *   - Self-only claim: a member can only claim BYOA for themselves
 *   - clear is allowed by the current owner; non-owners cannot clear
 *     (a future stale-owner recovery path may relax this)
 *   - Refuses to claim/clear while the ship appears to have an active task
 *     (derived from recent task.start events without a matching task.finish/
 *     task.cancel). Best-effort UX guard, not an atomic mutex.
 *   - Only corporation-owned ships can have BYOA configured
 */

import { validate as validateUuid } from "https://deno.land/std@0.197.0/uuid/mod.ts";

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
import { emitCorporationEvent } from "../_shared/corporations.ts";
import {
  optionalString,
  parseJsonRequest,
  RequestValidationError,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { fetchActiveTaskIdsByShip } from "../_shared/tasks.ts";
import { traced } from "../_shared/weave.ts";

type ByoaAction = "claim" | "clear";
type ByoaMode = "private";

const VALID_ACTIONS: readonly ByoaAction[] = ["claim", "clear"];
const VALID_MODES: readonly ByoaMode[] = ["private"];

Deno.serve(traced("ship_byoa_configure", async (req, trace) => {
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
    const shipId = requireString(payload, "ship_id");
    const actionRaw = requireString(payload, "action");
    const modeRaw = optionalString(payload, "mode");

    if (!(await canActOnCharacter(auth, characterId, supabase))) {
      return errorResponse("forbidden", 403);
    }

    if (!validateUuid(shipId)) {
      throw new RequestValidationError("ship_id must be a UUID", 400);
    }
    if (!VALID_ACTIONS.includes(actionRaw as ByoaAction)) {
      throw new RequestValidationError(
        `action must be one of ${VALID_ACTIONS.join(", ")}`,
        400,
      );
    }
    const action = actionRaw as ByoaAction;

    let mode: ByoaMode | null = null;
    if (modeRaw !== null && modeRaw !== undefined) {
      if (!VALID_MODES.includes(modeRaw as ByoaMode)) {
        throw new RequestValidationError(
          `mode must be one of ${VALID_MODES.join(", ")}`,
          400,
        );
      }
      mode = modeRaw as ByoaMode;
    }

    if (action === "claim" && mode === null) {
      // Default new BYOA claims to private — the more conservative choice.
      mode = "private";
    }
    trace.setInput({ characterId, shipId, action, mode, requestId });

    // Load ship + current BYOA state.
    const { data: shipRow, error: shipErr } = await supabase
      .from("ship_instances")
      .select(
        "ship_id, ship_name, owner_type, owner_corporation_id, byoa_owner_character_id, byoa_mode",
      )
      .eq("ship_id", shipId)
      .maybeSingle();

    if (shipErr) {
      console.error("ship_byoa_configure.ship_lookup", shipErr);
      return errorResponse("Failed to load ship", 500);
    }
    if (!shipRow) {
      return errorResponse("ship_not_found", 404);
    }
    if (shipRow.owner_type !== "corporation") {
      return errorResponse(
        "BYOA can only be configured on corporation ships",
        400,
      );
    }
    const corpId = shipRow.owner_corporation_id as string | null;
    if (!corpId) {
      return errorResponse("Corp ship has no owning corporation", 500);
    }

    // Membership check — caller must be a member of the ship's corp.
    const { data: membership, error: memErr } = await supabase
      .from("corporation_members")
      .select("corp_id")
      .eq("character_id", characterId)
      .eq("corp_id", corpId)
      .is("left_at", null)
      .maybeSingle();
    if (memErr) {
      console.error("ship_byoa_configure.member_lookup", memErr);
      return errorResponse("Failed to verify corp membership", 500);
    }
    if (!membership) {
      return errorResponse(
        "Only corp members can configure BYOA on this ship",
        403,
      );
    }

    // Best-effort active-task guard — no BYOA changes while a task appears
    // to be in flight on this ship. Toggling ownership mid-task would create
    // ambiguity about who's running the active task. Inferred from recent
    // task.start events without a matching task.finish/task.cancel; not an
    // atomic mutex.
    const activeTasks = await fetchActiveTaskIdsByShip(supabase, [shipId]);
    const activeTaskId = activeTasks.get(shipId) ?? null;
    if (activeTaskId !== null) {
      return new Response(
        JSON.stringify({
          error: "ship_busy",
          ship_id: shipId,
          current_task_id: activeTaskId,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const currentOwner = typeof shipRow.byoa_owner_character_id === "string"
      ? (shipRow.byoa_owner_character_id as string)
      : null;
    const currentMode: ByoaMode = "private";

    // Action-specific authorization + state transition.
    let nextOwner: string | null;
    let nextMode: ByoaMode;

    if (action === "claim") {
      // Self-only claim: you can only claim for yourself.
      if (currentOwner && currentOwner !== characterId) {
        return errorResponse(
          "BYOA already claimed by another corp member",
          409,
        );
      }
      nextOwner = characterId;
      nextMode = mode ?? "private";
    } else {
      // clear
      if (!currentOwner) {
        // Already cleared — idempotent success.
        return successResponse({
          request_id: requestId,
          ship_id: shipId,
          byoa_owner_character_id: null,
          byoa_mode: "private",
          changed: false,
        });
      }
      if (currentOwner !== characterId) {
        return errorResponse(
          "Only the current BYOA owner can clear BYOA",
          403,
        );
      }
      nextOwner = null;
      nextMode = "private";
    }

    const changed = currentOwner !== nextOwner || currentMode !== nextMode;

    if (changed) {
      const updatePayload = {
        byoa_owner_character_id: nextOwner,
        byoa_mode: nextMode,
      };
      const baseUpdate = supabase
        .from("ship_instances")
        .update(updatePayload)
        .eq("ship_id", shipId)
        .eq("owner_type", "corporation")
        .eq("owner_corporation_id", corpId)
        .eq("byoa_mode", currentMode);

      const { data: updatedRow, error: updateErr } = currentOwner
        ? await baseUpdate
          .eq("byoa_owner_character_id", currentOwner)
          .select("ship_id")
          .maybeSingle()
        : await baseUpdate
          .is("byoa_owner_character_id", null)
          .select("ship_id")
          .maybeSingle();

      if (updateErr) {
        console.error("ship_byoa_configure.update_error", updateErr);
        return errorResponse("Failed to update BYOA configuration", 500);
      }
      if (!updatedRow) {
        return errorResponse("BYOA configuration changed; retry", 409);
      }
    }

    // Emit a corp-scoped event so all corp members see the BYOA state change.
    const eventPayload: Record<string, unknown> = {
      source: buildEventSource("ship_byoa_configure", requestId),
      ship_id: shipId,
      ship_name: shipRow.ship_name ?? null,
      corp_id: corpId,
      action,
      byoa_owner_character_id: nextOwner,
      byoa_mode: nextMode,
      changed,
      actor_character_id: characterId,
    };

    if (changed) {
      await emitCorporationEvent(supabase, corpId, {
        eventType: "ship.byoa_configured",
        payload: eventPayload,
        requestId,
        actorCharacterId: characterId,
      });
    } else {
      // No-op claim/clear — still tell the caller things are consistent
      // but don't fan out a corp-wide event for nothing.
      await emitCharacterEvent({
        supabase,
        characterId,
        eventType: "ship.byoa_configured",
        payload: eventPayload,
        requestId,
        actorCharacterId: characterId,
      });
    }

    trace.setOutput({
      request_id: requestId,
      ship_id: shipId,
      action,
      changed,
    });
    return successResponse({
      request_id: requestId,
      ship_id: shipId,
      byoa_owner_character_id: nextOwner,
      byoa_mode: nextMode,
      changed,
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) return validationResponse;
    console.error("ship_byoa_configure.error", err);
    return errorResponse(
      err instanceof Error ? err.message : "ship byoa configure failed",
      500,
    );
  }
}));
