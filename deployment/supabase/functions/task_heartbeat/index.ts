import {
  authenticate,
  authErrorResponse,
  errorResponse,
  successResponse,
  type AuthContext,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  parseJsonRequest,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

/**
 * Bulk heartbeat for ship-task locks.
 *
 * Request body:
 *   { locks: [{ ship_id: string, task_id: string }, ...] }
 *
 * The (ship_id, task_id) pair is the auth boundary — the underlying RPC
 * only updates rows where the pair matches the currently-held lock, so an
 * attacker cannot refresh someone else's lock. Mismatched pairs (lock was
 * released, stolen, or never held) are silently no-op.
 *
 * Response:
 *   { request_id, refreshed: <count> }
 */
Deno.serve(traced("task_heartbeat", async (req, trace) => {
  let auth: AuthContext;
  try {
    auth = await authenticate(req);
  } catch (err) {
    return authErrorResponse(err);
  }
  void auth;

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

  const locksRaw = payload.locks;
  if (!Array.isArray(locksRaw)) {
    return errorResponse("locks must be an array", 400);
  }

  const pairs: Array<{ ship_id: string; task_id: string }> = [];
  for (const entry of locksRaw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).ship_id === "string" &&
      typeof (entry as Record<string, unknown>).task_id === "string"
    ) {
      pairs.push({
        ship_id: (entry as Record<string, unknown>).ship_id as string,
        task_id: (entry as Record<string, unknown>).task_id as string,
      });
    }
  }

  trace.setInput({ requestId, pair_count: pairs.length });

  if (!pairs.length) {
    return successResponse({ request_id: requestId, refreshed: 0 });
  }

  const sRefresh = trace.span("refresh");
  const { data, error } = await supabase.rpc("refresh_ship_task_heartbeats", {
    pairs,
  });
  sRefresh.end();

  if (error) {
    console.error("task_heartbeat.rpc_error", error);
    return errorResponse("Failed to refresh heartbeats", 500);
  }

  const refreshed =
    typeof (data as Record<string, unknown> | null)?.refreshed === "number"
      ? ((data as Record<string, unknown>).refreshed as number)
      : 0;

  trace.setOutput({ request_id: requestId, refreshed });
  return successResponse({ request_id: requestId, refreshed });
}));
