import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { listDueCombats } from "../_shared/combat_state.ts";
import { resolveEncounterRound } from "../_shared/combat_resolution.ts";
import { parseJsonRequest, respondWithError } from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

const MAX_BATCH = Number(Deno.env.get("COMBAT_TICK_BATCH_SIZE") ?? "20");

Deno.serve(traced("combat_tick", async (req, trace) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown> = {};
  if (req.headers.get("content-length")) {
    try {
      payload = await parseJsonRequest(req);
    } catch (err) {
      const response = respondWithError(err);
      if (response) {
        return response;
      }
      console.error("combat_tick.parse", err);
      return errorResponse("invalid JSON payload", 400);
    }
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }
  const nowIso = new Date().toISOString();

  trace.setInput({ timestamp: nowIso });

  try {
    const sListDue = trace.span("list_due_combats");
    const encounters = await listDueCombats(supabase, nowIso, MAX_BATCH);
    sListDue.end({ count: encounters.length });

    let resolved = 0;
    for (const encounter of encounters) {
      const sResolve = trace.span("resolve_round", { combat_id: encounter.combat_id });
      try {
        await resolveEncounterRound({
          supabase,
          encounter,
          requestId: `combat.tick:${encounter.combat_id}:${Date.now()}`,
          source: "combat.tick",
        });
        resolved += 1;
        sResolve.end({ success: true });
      } catch (err) {
        sResolve.end({ error: String(err) });
        console.error("combat_tick.resolve_failed", {
          combat_id: encounter.combat_id,
          error: err,
        });
      }
    }

    trace.setOutput({ checked: encounters.length, resolved });
    return successResponse({
      status: "ok",
      checked: encounters.length,
      resolved,
      timestamp: nowIso,
    });
  } catch (err) {
    console.error("combat_tick.error", err);
    return errorResponse("combat tick error", 500);
  }
}));
