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

// Channel format: 'gb_' + 32 hex chars (UUID-128). The bot allocates this
// per session and forwards it here. The public.bus_* SQL wrappers enforce
// the same shape server-side; this regex catches malformed values before
// they reach the spawn path.
const CHANNEL_PATTERN = /^gb_[0-9a-f]{32}$/;

// Channels are bus capabilities — log a short prefix as a correlation id
// and keep the rest out of logs. Leaks the first 32 random bits of the
// UUID and keeps the remaining ~90 bits of entropy private.
function channelHash(channel: string): string {
  const m = /^gb_([0-9a-f]{8})/.exec(channel);
  return m ? m[1] : "anon";
}

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
  byoaOwnerCharacterId: string,
): Record<string, string> {
  return {
    BYOA_CHANNEL: channel,
    BYOA_SHIP_ID: shipId,
    BYOA_CHARACTER_ID: byoaOwnerCharacterId,
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
  byoaOwnerCharacterId: string,
  shipWakeUrl: string | null,
  shipWakeSecret: string | null,
): Promise<SpawnResult> {
  const target = "http";
  // Per-ship URL wins; fall back to DEFAULT_BYOA_SOURCE_URL for ships that
  // haven't been configured yet (typical only in local dev).
  const wakeUrl = (
    shipWakeUrl ?? Deno.env.get("DEFAULT_BYOA_SOURCE_URL") ?? ""
  ).trim();
  // Per-ship secret only. No env-var fallback — a single shared secret
  // across all operators would mean any leak compromises every BYOA.
  // Each ship's secret is set via ship_byoa_configure and stored encrypted.
  const wakeSecret = (shipWakeSecret ?? "").trim();

  if (!wakeUrl) {
    console.error(
      "wake_agent.spawn.http.missing_wake_url",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel_hash: channelHash(channel),
      }),
    );
    return { target, status: "missing_wake_url" };
  }
  if (!wakeSecret) {
    console.error(
      "wake_agent.spawn.http.missing_wake_secret",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel_hash: channelHash(channel),
      }),
    );
    return { target, status: "missing_wake_secret" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(wakeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${wakeSecret}`,
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
          byoaOwnerCharacterId,
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
          channel_hash: channelHash(channel),
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
        channel_hash: channelHash(channel),
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
        channel_hash: channelHash(channel),
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
  byoaOwnerCharacterId: string,
  shipWakeUrl: string | null,
  shipWakeSecret: string | null,
): Promise<SpawnResult> {
  const target = (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase();
  if (target === "noop") {
    console.log(
      "wake_agent.spawn.noop",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel_hash: channelHash(channel),
      }),
    );
    return { target, status: "noop" };
  }
  const byoaBusDatabaseUrl = (Deno.env.get("BYOA_BUS_DATABASE_URL") ?? "")
    .trim();
  if (!byoaBusDatabaseUrl) {
    console.error(
      "wake_agent.spawn.missing_byoa_bus_database_url",
      JSON.stringify({
        request_id: requestId,
        ship_id: shipId,
        channel_hash: channelHash(channel),
      }),
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
      byoaOwnerCharacterId,
      shipWakeUrl,
      shipWakeSecret,
    );
  }

  console.warn(
    "wake_agent.spawn.unknown_target",
    JSON.stringify({
      request_id: requestId,
      ship_id: shipId,
      channel_hash: channelHash(channel),
      target,
    }),
  );
  return { target, status: "unknown_target" };
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
      wake_target: (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase(),
      byoa_bus_database_url_present: Boolean(
        (Deno.env.get("BYOA_BUS_DATABASE_URL") ?? "").trim(),
      ),
      default_byoa_source_url_present: Boolean(
        (Deno.env.get("DEFAULT_BYOA_SOURCE_URL") ?? "").trim(),
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
        "channel must match /^gb_[0-9a-f]{32}$/",
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

    // Pull the per-ship wake URL + decrypted bearer in a single SECURITY
    // DEFINER call. The operator_secret never leaves the function body.
    // get_ship_byoa_wake_config returns TABLE(...), which the rpc client
    // surfaces as an array; the first row is what we want.
    let shipWakeUrl: string | null = null;
    let shipWakeSecret: string | null = null;
    if (taskId !== null) {
      const { data: wakeCfg, error: wakeCfgErr } = await supabase
        .rpc("get_ship_byoa_wake_config", { p_ship_id: shipId });
      if (wakeCfgErr) {
        console.error("wake_agent.wake_config_lookup", wakeCfgErr);
        return errorResponse("Failed to load BYOA wake config", 500);
      }
      const row = Array.isArray(wakeCfg) ? wakeCfg[0] : wakeCfg;
      shipWakeUrl = typeof row?.source_url === "string" ? row.source_url : null;
      shipWakeSecret = typeof row?.wake_secret === "string"
        ? row.wake_secret
        : null;
    }

    // Channel is supplied by the bot per session and validated against the
    // CHANNEL_PATTERN above; the public.bus_* SQL wrappers re-verify it on
    // every bus op via the bus_peers registry, so no DB-side pre-auth is
    // needed here.
    const spawn = taskId !== null
      ? await dispatchSpawn(
        shipId,
        channel,
        taskId,
        requestId,
        shipRow.byoa_owner_character_id,
        shipWakeUrl,
        shipWakeSecret,
      )
      : {
        target: (Deno.env.get("WAKE_TARGET") ?? "noop").toLowerCase(),
        status: "registered",
      };

    const channelH = channelHash(channel);
    trace.setInput({
      shipId,
      characterId: characterId ?? null,
      taskId: taskId ?? null,
      channel_hash: channelH,
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
          channel_hash: channelH,
          spawn_target: spawn.target,
          spawn_status: spawn.status,
        }),
      );
      return errorResponse("wake_spawn_failed", spawnFailureStatusCode(spawn), {
        request_id: requestId,
        ship_id: shipId,
        channel_hash: channelH,
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
        channel_hash: channelH,
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
