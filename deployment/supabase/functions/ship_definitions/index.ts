/**
 * Edge Function: ship_definitions
 *
 * Returns all ship definitions from the database including types, prices,
 * and capabilities.
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

Deno.serve(async (req: Request): Promise<Response> => {
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
    console.error("ship_definitions.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: "ok" });
  }

  const requestId = resolveRequestId(payload);
  const characterId =
    typeof payload.character_id === "string" ? payload.character_id : null;

  try {
    const { data, error } = await supabase
      .from("ship_definitions")
      .select(
        "ship_type, display_name, cargo_holds, warp_power_capacity, turns_per_warp, shields, fighters, purchase_price, stats",
      )
      .order("purchase_price", { ascending: true });

    if (error) {
      console.error("ship_definitions.query", error);
      return errorResponse("Failed to load ship definitions", 500);
    }

    const definitions = data ?? [];

    if (characterId) {
      const source = buildEventSource("ship_definitions", requestId);
      await emitCharacterEvent({
        supabase,
        characterId,
        eventType: "ship.definitions",
        payload: { source, definitions },
        requestId,
      });
    }

    return successResponse({ definitions });
  } catch (err) {
    console.error("ship_definitions.unhandled", err);
    return errorResponse("internal server error", 500);
  }
});
