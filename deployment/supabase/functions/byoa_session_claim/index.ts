/**
 * Edge Function: byoa_session_claim
 *
 * Discovery endpoint the operator's `uv run byoa` process polls to learn
 * which subagent-bus channel to join. The bot's `wake_agent` writes a
 * channel onto the ship's task-lock row when delegating a task; this
 * function reads it back, gated by the operator's HS256 BYOA token.
 *
 * Auth: `Authorization: Bearer <BYOA_TOKEN>` header. The token is the
 * HS256 JWT minted by `byoa_token_mint`. The function delegates signature +
 * revocation + expiry checks to the SQL `verify_byoa_token` function (via
 * service_role) and authorizes the bound character against the ship under
 * the same private/shared rules wake_agent honors.
 *
 * Response shape:
 *   200 { channel: string|null, current_task_id, lifecycle_hint, request_id, ship_id }
 *   - `channel` is null when no session is allocated; the client sleeps
 *     `BYOA_POLL_INTERVAL_SECONDS` and re-polls.
 *   - `lifecycle_hint` reflects the server's `WAKE_TARGET` (idle_loop for
 *     dev, single_task for prod). The client uses it to decide whether
 *     to exit after a task completes.
 *
 * This function is the dev/prod-uniform half of the wake/claim pair:
 * production processes spawned by wake_agent call it once at startup;
 * dev processes call it on a polling loop. The server doesn't care which.
 */

import { validate as validateUuid } from "https://deno.land/std@0.197.0/uuid/mod.ts";

import { errorResponse, successResponse } from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

const BEARER_PREFIX = /^Bearer\s+/i;

function lifecycleHint(): "single_task" | "idle_loop" {
  return (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase() === "noop"
    ? "idle_loop"
    : "single_task";
}

function extractToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const stripped = header.replace(BEARER_PREFIX, "").trim();
  return stripped.length > 0 ? stripped : null;
}

Deno.serve(traced("byoa_session_claim", async (req, trace) => {
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
      lifecycle_hint: lifecycleHint(),
    });
  }

  const requestId = resolveRequestId(payload);

  try {
    const shipId = requireString(payload, "ship_id");
    if (!validateUuid(shipId)) {
      return errorResponse("ship_id must be a UUID", 400);
    }

    const token = extractToken(req);
    if (!token) {
      return errorResponse(
        "Authorization: Bearer <BYOA_TOKEN> header is required",
        401,
      );
    }

    // verify_byoa_token returns the bound character_id or NULL on any
    // failure (bad signature, wrong issuer, revoked, expired, mismatched
    // character). The function also touches last_used_at on success so
    // operator-facing token UIs can show recent activity.
    const { data: verifyData, error: verifyErr } = await supabase.rpc(
      "verify_byoa_token",
      { p_token: token },
    );
    if (verifyErr) {
      console.error("byoa_session_claim.verify", verifyErr);
      return errorResponse("Failed to verify token", 500);
    }
    const characterId = typeof verifyData === "string" ? verifyData : null;
    if (!characterId) {
      return errorResponse("invalid_token", 401);
    }

    const { data: shipRow, error: shipErr } = await supabase
      .from("ship_instances")
      .select(
        "ship_id, owner_type, owner_corporation_id, byoa_owner_character_id, byoa_mode, byoa_session_channel, current_task_id",
      )
      .eq("ship_id", shipId)
      .maybeSingle();
    if (shipErr) {
      console.error("byoa_session_claim.ship_lookup", shipErr);
      return errorResponse("Failed to load ship", 500);
    }
    // 404 leaks no more than a probing operator already knew if they have
    // a token. We don't worry about distinguishing "not found" from
    // "found but not yours" — both paths return the same shape downstream.
    if (!shipRow) {
      return errorResponse("ship_not_found", 404);
    }
    if (
      shipRow.owner_type !== "corporation" ||
      typeof shipRow.byoa_owner_character_id !== "string"
    ) {
      return errorResponse("not_a_byoa_ship", 400);
    }

    // Authorization mirrors byoa_bus_authorize: private ships are owner-
    // only, shared ships are open to active corp members. Refused requests
    // return 403 with no channel info — same shape as a successful "no
    // session" so a probing operator can't distinguish authz failure from
    // "task isn't allocated right now."
    const isOwner = shipRow.byoa_owner_character_id === characterId;
    let authorized = isOwner;
    if (!isOwner && shipRow.byoa_mode === "shared") {
      const { data: memberRow, error: memberErr } = await supabase
        .from("corporation_members")
        .select("character_id")
        .eq("corp_id", shipRow.owner_corporation_id)
        .eq("character_id", characterId)
        .is("left_at", null)
        .maybeSingle();
      if (memberErr) {
        console.error("byoa_session_claim.corp_member", memberErr);
        return errorResponse("Failed to verify corp membership", 500);
      }
      authorized = Boolean(memberRow);
    }
    if (!authorized) {
      return errorResponse("forbidden", 403);
    }

    const channel = typeof shipRow.byoa_session_channel === "string"
      ? shipRow.byoa_session_channel
      : null;
    const currentTaskId = typeof shipRow.current_task_id === "string"
      ? shipRow.current_task_id
      : null;

    trace.setInput({ shipId, characterId, requestId });
    trace.setOutput({
      request_id: requestId,
      has_channel: channel !== null,
    });

    return successResponse({
      request_id: requestId,
      ship_id: shipId,
      channel,
      current_task_id: currentTaskId,
      lifecycle_hint: lifecycleHint(),
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) return validationResponse;
    console.error("byoa_session_claim.error", err);
    return errorResponse(
      err instanceof Error ? err.message : "byoa_session_claim failed",
      500,
    );
  }
}));
