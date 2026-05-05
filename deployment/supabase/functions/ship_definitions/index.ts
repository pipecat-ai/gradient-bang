/**
 * Edge Function: ship_definitions
 *
 * Returns all ship definitions from the database including types, prices,
 * and capabilities. Description text is omitted unless explicitly requested.
 */

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { emitCharacterEvent, buildEventSource } from "../_shared/events.ts";
import {
  parseJsonRequest,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(
  traced("ship_definitions", async (req, trace) => {
    if (!(await validateApiToken(req))) {
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
      console.error("ship_definitions.parse", err);
      return errorResponse("invalid JSON payload", 400);
    }

    if (payload.healthcheck === true) {
      return successResponse({ status: "ok" });
    }

    const requestId = resolveRequestId(payload);
    const characterId =
      typeof payload.character_id === "string" ? payload.character_id : null;
    const includeDescription = payload.include_description === true;

    trace.setInput({ characterId, includeDescription, requestId });

    try {
      const sQuery = trace.span("db_query_ship_definitions");
      const selectColumns = includeDescription
        ? "ship_type, display_name, cargo_holds, warp_power_capacity, turns_per_warp, shields, fighters, purchase_price, stats, description"
        : "ship_type, display_name, cargo_holds, warp_power_capacity, turns_per_warp, shields, fighters, purchase_price, stats";
      const { data, error } = await supabase
        .from("ship_definitions")
        .select(selectColumns)
        .order("purchase_price", { ascending: true });

      if (error) {
        sQuery.end({ error: error.message });
        console.error("ship_definitions.query", error);
        return errorResponse("Failed to load ship definitions", 500);
      }

      const definitions = data ?? [];
      sQuery.end({ count: definitions.length });

      if (characterId) {
        const sEmit = trace.span("emit_ship_definitions_event");
        const source = buildEventSource("ship_definitions", requestId);
        await emitCharacterEvent({
          supabase,
          characterId,
          eventType: "ship.definitions",
          payload: { source, definitions },
          requestId,
        });
        sEmit.end();
      }

      trace.setOutput({
        request_id: requestId,
        definitionCount: definitions.length,
        includeDescription,
      });
      return successResponse({ definitions });
    } catch (err) {
      console.error("ship_definitions.unhandled", err);
      return errorResponse("internal server error", 500);
    }
  }),
);
