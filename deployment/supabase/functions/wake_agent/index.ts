/**
 * Edge Function: wake_agent
 *
 * Called by the bot's VoiceAgent for BYOA task wake.
 *
 *   1. Channel handoff: the voice agent owns the per-session subagent-bus
 *      channel and includes it in this request.
 *
 *   2. Spawn dispatch: based on `WAKE_TARGET` env, optionally trigger a
 *      process spawn with BYOA_CHANNEL, BYOA_SHIP_ID, and
 *      BYOA_BUS_DATABASE_URL. Local dev uses the generic `http` target against
 *      `uv run byoa serve`; future production sandbox targets use the same
 *      runtime env payload.
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

type SpawnResult = {
  target: string;
  status: string;
};

function spawnFailureStatusCode(spawn: SpawnResult): number {
  if (spawn.target === "http" && spawn.status === "timeout") return 504;
  if (spawn.status.startsWith("missing_")) return 500;
  if (spawn.status === "unimplemented") return 501;
  return 502;
}

function byoaRuntimeEnv(
  shipId: string,
  channel: string,
  taskId: string,
  requestId: string,
  byoaBusDatabaseUrl: string,
): Record<string, string> {
  return {
    BYOA_CHANNEL: channel,
    BYOA_SHIP_ID: shipId,
    BYOA_BUS_DATABASE_URL: byoaBusDatabaseUrl,
    BYOA_TASK_ID: taskId,
    BYOA_WAKE_REQUEST_ID: requestId,
  };
}

async function dispatchHttpSpawn(
  shipId: string,
  channel: string,
  taskId: string,
  requestId: string,
  byoaBusDatabaseUrl: string,
): Promise<SpawnResult> {
  const target = "http";
  const wakeUrl = (Deno.env.get("BYOA_WAKE_URL") ?? "").trim();
  const edgeApiToken = (Deno.env.get("EDGE_API_TOKEN") ?? "").trim();

  if (!wakeUrl) {
    console.error(
      "wake_agent.spawn.http.missing_byoa_wake_url",
      JSON.stringify({ request_id: requestId, ship_id: shipId, channel }),
    );
    return { target, status: "missing_byoa_wake_url" };
  }
  if (!edgeApiToken) {
    console.error(
      "wake_agent.spawn.http.missing_edge_api_token",
      JSON.stringify({ request_id: requestId, ship_id: shipId, channel }),
    );
    return { target, status: "missing_edge_api_token" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(wakeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${edgeApiToken}`,
      },
      body: JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel,
        task_id: taskId,
        env: byoaRuntimeEnv(
          shipId,
          channel,
          taskId,
          requestId,
          byoaBusDatabaseUrl,
        ),
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      console.log(
        "wake_agent.spawn.http.accepted",
        JSON.stringify({
          request_id: requestId,
          ship_id: shipId,
          channel,
          status: response.status,
        }),
      );
      return { target, status: "accepted" };
    }

    const body = await response.text().catch(() => "");
    console.error(
      "wake_agent.spawn.http.failed",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel,
        status: response.status,
        body: body.slice(0, 500),
      }),
    );
    return { target, status: `http_${response.status}` };
  } catch (err) {
    const status = err instanceof DOMException && err.name === "AbortError"
      ? "timeout"
      : "request_failed";
    console.error(
      "wake_agent.spawn.http.error",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel,
        status,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { target, status };
  } finally {
    clearTimeout(timeout);
  }
}

async function dispatchSpawn(
  shipId: string,
  channel: string,
  taskId: string,
  requestId: string,
): Promise<SpawnResult> {
  const target = (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase();
  if (target === "noop") {
    console.log(
      "wake_agent.spawn.noop",
      JSON.stringify({ request_id: requestId, ship_id: shipId, channel }),
    );
    return { target, status: "noop" };
  }
  const byoaBusDatabaseUrl = (Deno.env.get("BYOA_BUS_DATABASE_URL") ?? "")
    .trim();
  if (!byoaBusDatabaseUrl) {
    console.error(
      "wake_agent.spawn.missing_byoa_bus_database_url",
      JSON.stringify({ request_id: requestId, ship_id: shipId, channel }),
    );
    return { target, status: "missing_byoa_bus_database_url" };
  }
  if (target === "http") {
    return await dispatchHttpSpawn(
      shipId,
      channel,
      taskId,
      requestId,
      byoaBusDatabaseUrl,
    );
  }

  if (target !== "vercel_sandbox") {
    console.warn(
      "wake_agent.spawn.unknown_target",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel,
        target,
      }),
    );
    return { target, status: "unknown_target" };
  }

  // Spawn implementation for `vercel_sandbox` lands in follow-up work.
  // For now they fall through to a logged no-op so an operator misreading
  // the env var doesn't get a 500 — they get a visible warning in logs.
  console.warn(
    "wake_agent.spawn.unimplemented",
    JSON.stringify({
      request_id: requestId,
      ship_id: shipId,
      channel,
      target,
      env: byoaRuntimeEnv(
        shipId,
        channel,
        taskId,
        requestId,
        "<set>",
      ),
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
      byoa_bus_database_url_present: Boolean(
        (Deno.env.get("BYOA_BUS_DATABASE_URL") ?? "").trim(),
      ),
      byoa_wake_url_present: Boolean(
        (Deno.env.get("BYOA_WAKE_URL") ?? "").trim(),
      ),
    });
  }

  const requestId = resolveRequestId(payload);

  try {
    const shipId = requireString(payload, "ship_id");
    // character_id is optional and informational only. canActOnCharacter()
    // resolves authz against shipId; the BYOA owner is read from the
    // ship row server-side. We accept it for logging but never require it
    // — the bot's supabase client canonicalizes character_id to a full
    // UUID and the truncated BYOA-owner prefix the bot might be tempted
    // to send would fail that canonicalization.
    const characterId = optionalString(payload, "character_id");
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
    if (taskId !== null && !validateUuid(taskId)) {
      return errorResponse("task_id must be a UUID", 400);
    }

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
    if (typeof shipRow.byoa_owner_character_id !== "string") {
      return errorResponse("not_a_byoa_ship", 400);
    }

    // No DB-side channel allocation needed: byoa_bus_authorize verifies the
    // caller's BYOA token against the ship's byoa_owner_character_id directly,
    // not against a stored channel binding. The channel is passed straight to
    // the spawn dispatcher.
    const spawn = taskId !== null
      ? await dispatchSpawn(shipId, channel, taskId, requestId)
      : {
        target: (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase(),
        status: "registered",
      };

    trace.setInput({
      shipId,
      characterId: characterId ?? null,
      taskId: taskId ?? null,
      channel,
      requestId,
    });
    trace.setOutput({
      request_id: requestId,
      status: spawn.status,
      target: spawn.target,
    });

    if (
      taskId !== null && spawn.target === "http" && spawn.status !== "accepted"
    ) {
      console.error(
        "wake_agent.spawn.rejected",
        JSON.stringify({
          request_id: requestId,
          ship_id: shipId,
          task_id: taskId,
          channel,
          spawn_target: spawn.target,
          spawn_status: spawn.status,
        }),
      );
      return errorResponse("wake_spawn_failed", spawnFailureStatusCode(spawn), {
        request_id: requestId,
        ship_id: shipId,
        channel,
        spawn_target: spawn.target,
        spawn_status: spawn.status,
        lifecycle_hint: lifecycleHint(),
      });
    }

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
