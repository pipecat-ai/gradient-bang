/**
 * Edge Function: wake_agent
 *
 * Called by the bot's VoiceAgent when delegating a task to a BYOA ship.
 * Two things happen here, both server-side:
 *
 *   1. Allocation: record the bot's subagent-bus channel on the ship's
 *      task-lock row (`ship_instances.byoa_session_channel`). The BYOA's
 *      claim endpoint reads this back to tell the operator's process which
 *      channel to join — that's the discovery rendezvous.
 *
 *   2. Spawn dispatch: based on `WAKE_TARGET` env, optionally trigger a
 *      remote process spawn (Vercel Sandbox, Lambda, etc.) so a sleeping
 *      operator process boots in time to claim. `noop` is the dev default —
 *      the operator already has `uv run byoa` running and polling.
 *
 * Authorization: same `authenticate(req)` + `canActOnCharacter(auth, ship_id)`
 * as every other bot-side endpoint. Channel format is validated server-side
 * to keep a misconfigured bot from writing a garbage value the BYOA can't
 * sanely consume.
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

// Mirrors the upstream PgmqBus channel sanitizer: identifier-shaped, max 30
// chars. Pre-validating server-side keeps a buggy bot from poisoning the
// row with whitespace, dots, or an oversize value that pgmq queue names
// can't host.
const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,29}$/;

function lifecycleHint(): "single_task" | "idle_loop" {
  return (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase() === "noop"
    ? "idle_loop"
    : "single_task";
}

async function dispatchSpawn(
  shipId: string,
  channel: string,
  requestId: string,
): Promise<{ target: string; status: string }> {
  const target = (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase();
  if (target === "noop") {
    console.log(
      "wake_agent.spawn.noop",
      JSON.stringify({ request_id: requestId, ship_id: shipId, channel }),
    );
    return { target, status: "noop" };
  }
  // Spawn implementations for `vercel` / `lambda` land in follow-up work.
  // For now they fall through to a logged no-op so an operator misreading
  // the env var doesn't get a 500 — they get a visible warning in logs and
  // the dev claim flow still works for them.
  console.warn(
    "wake_agent.spawn.unimplemented",
    JSON.stringify({
      request_id: requestId,
      ship_id: shipId,
      channel,
      target,
    }),
  );
  return { target, status: "unimplemented" };
}

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
      wake_target: (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase(),
    });
  }

  const requestId = resolveRequestId(payload);

  try {
    const shipId = requireString(payload, "ship_id");
    const characterId = requireString(payload, "character_id");
    const channel = requireString(payload, "channel");
    const taskId = optionalString(payload, "task_id");

    if (!validateUuid(shipId)) {
      return errorResponse("ship_id must be a UUID", 400);
    }
    if (!CHANNEL_PATTERN.test(channel)) {
      return errorResponse(
        "channel must match /^[A-Za-z_][A-Za-z0-9_]{0,29}$/",
        400,
      );
    }
    if (taskId !== undefined && !validateUuid(taskId)) {
      return errorResponse("task_id must be a UUID", 400);
    }

    if (!(await canActOnCharacter(auth, shipId, supabase))) {
      return errorResponse("forbidden", 403);
    }

    const { data: shipRow, error: shipErr } = await supabase
      .from("ship_instances")
      .select(
        "ship_id, byoa_owner_character_id, current_task_id, byoa_session_channel",
      )
      .eq("ship_id", shipId)
      .maybeSingle();
    if (shipErr) {
      console.error("wake_agent.ship_lookup", shipErr);
      return errorResponse("Failed to load ship", 500);
    }
    if (!shipRow) {
      return errorResponse("ship_not_found", 404);
    }
    if (typeof shipRow.byoa_owner_character_id !== "string") {
      return errorResponse("not_a_byoa_ship", 400);
    }

    // Allocate the session channel. The atomic guard is `current_task_id`:
    // we only stamp the channel when the task-lock row still names the
    // task the bot claims to be running. If the lock was stolen between
    // acquire and wake, ROWCOUNT is 0 and we refuse to allocate — the bot
    // surfaces the wake timeout and another caller can try.
    let updateQuery = supabase
      .from("ship_instances")
      .update({
        byoa_session_channel: channel,
        byoa_session_allocated_at: new Date().toISOString(),
      })
      .eq("ship_id", shipId);
    if (taskId !== undefined) {
      updateQuery = updateQuery.eq("current_task_id", taskId);
    } else {
      updateQuery = updateQuery.not("current_task_id", "is", null);
    }
    const { data: updated, error: updateErr } = await updateQuery.select(
      "ship_id, current_task_id, byoa_session_channel",
    );
    if (updateErr) {
      console.error("wake_agent.allocate", updateErr);
      return errorResponse("Failed to allocate session channel", 500);
    }
    if (!updated || updated.length === 0) {
      // Either the lock isn't held by this task, or the row vanished.
      // Returning 409 lets the bot distinguish this from auth/validation
      // failures and trigger its existing wake-timeout watchdog cleanly.
      return errorResponse("lock_not_held", 409);
    }

    const spawn = await dispatchSpawn(shipId, channel, requestId);

    trace.setInput({
      shipId,
      characterId,
      taskId: taskId ?? null,
      channel,
      requestId,
    });
    trace.setOutput({
      request_id: requestId,
      status: spawn.status,
      target: spawn.target,
    });
    console.log(
      "wake_agent.allocated",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        task_id: taskId ?? null,
        channel,
        spawn_target: spawn.target,
        spawn_status: spawn.status,
        lifecycle_hint: lifecycleHint(),
      }),
    );

    return successResponse({
      request_id: requestId,
      ship_id: shipId,
      channel,
      spawn_target: spawn.target,
      spawn_status: spawn.status,
      lifecycle_hint: lifecycleHint(),
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
