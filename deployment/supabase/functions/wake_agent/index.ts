/**
 * Edge Function: wake_agent
 *
 * Stub wake endpoint for BYOA ships. The bot calls this when
 * BYOA_WAKE_ENABLED=true before publishing a task on the bus, so a sleeping
 * BYOA agent (e.g. running in Vercel Sandbox / Lambda) can cold-start in time
 * to drain the queue.
 *
 * Phase 3.1: returns `{success: true, status: "stub"}` after logging the wake
 * intent. Future versions add a `WAKE_TARGET=vercel|lambda|noop` env switch
 * and per-character routing config. Operators never author the wake
 * mechanism; it lives entirely server-side.
 *
 * Auth: standard `authenticate(req)` + `canActOnCharacter(auth, ship_id)` —
 * same pattern as every other player-acting endpoint the bot calls.
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
import {
  optionalString,
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(traced("wake_agent", async (req, trace) => {
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
    const shipId = requireString(payload, "ship_id");
    const characterId = requireString(payload, "character_id");
    const taskId = optionalString(payload, "task_id");

    if (!validateUuid(shipId)) {
      return errorResponse("ship_id must be a UUID", 400);
    }

    // The caller acts as the ship pseudo-character (same auth model as
    // move/start_task etc.). canActOnCharacter binds the bot's credentials
    // to this specific ship.
    if (!(await canActOnCharacter(auth, shipId, supabase))) {
      return errorResponse("forbidden", 403);
    }

    const { data: shipRow, error: shipErr } = await supabase
      .from("ship_instances")
      .select("ship_id, byoa_owner_character_id")
      .eq("ship_id", shipId)
      .maybeSingle();
    if (shipErr) {
      console.error("wake_agent.ship_lookup", shipErr);
      return errorResponse("Failed to load ship", 500);
    }
    if (!shipRow) {
      return errorResponse("ship_not_found", 404);
    }
    // Wake is only meaningful for BYOA ships. Non-BYOA ships are run by
    // the bot's own task agent and need no wake.
    if (typeof shipRow.byoa_owner_character_id !== "string") {
      return errorResponse("not_a_byoa_ship", 400);
    }

    trace.setInput({ shipId, characterId, taskId, requestId });
    console.log(
      "wake_agent.stub",
      JSON.stringify({
        ship_id: shipId,
        character_id: characterId,
        task_id: taskId ?? null,
        owner: shipRow.byoa_owner_character_id,
      }),
    );

    trace.setOutput({ request_id: requestId, status: "stub" });
    return successResponse({
      request_id: requestId,
      ship_id: shipId,
      status: "stub",
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) return validationResponse;
    console.error("wake_agent.error", err);
    return errorResponse(
      err instanceof Error ? err.message : "wake_agent failed",
      500,
    );
  }
}));
