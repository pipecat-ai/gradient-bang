import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import { emitCharacterEvent, buildEventSource } from "../_shared/events.ts";
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { loadCharacter } from "../_shared/status.ts";
import {
  buildCorporationMemberPayload,
  fetchCorporationMembers,
  fetchCorporationShipSummaries,
  fetchDestroyedCorporationShips,
  loadCorporationById,
} from "../_shared/corporations.ts";
import { traced } from "../_shared/weave.ts";

class MyCorporationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MyCorporationError";
    this.status = status;
  }
}

Deno.serve(traced("my_corporation", async (req, trace) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("my_corporation.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const supabase = createServiceRoleClient();
  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, "character_id");

  trace.setInput({ characterId, requestId });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "my_corporation");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      return errorResponse("Too many corporation requests", 429);
    }
    console.error("my_corporation.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const sLoadCorp = trace.span("load_my_corporation", { characterId });
    const result = await loadMyCorporation({ supabase, characterId });
    sLoadCorp.end(result);

    // Emit corporation.data event so the client receives the data via WebSocket
    const sEmitEvent = trace.span("emit_event", { eventType: "corporation.data" });
    const source = buildEventSource("my_corporation", requestId);
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "corporation.data",
      payload: { source, ...result },
      requestId,
    });
    sEmitEvent.end();

    trace.setOutput({ request_id: requestId, has_corporation: result.corporation !== null });
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof MyCorporationError) {
      return errorResponse(err.message, err.status);
    }
    console.error("my_corporation.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));

async function loadMyCorporation(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
}): Promise<{ corporation: Record<string, unknown> | null }> {
  const { supabase, characterId } = params;
  const character = await loadCharacterSafe(supabase, characterId);
  if (!character.corporation_id) {
    return { corporation: null };
  }

  const corporation = await loadCorporationSafe(
    supabase,
    character.corporation_id,
  );
  const members = await fetchCorporationMembers(
    supabase,
    character.corporation_id,
  );
  const ships = await fetchCorporationShipSummaries(
    supabase,
    character.corporation_id,
  );
  const destroyedShips = await fetchDestroyedCorporationShips(
    supabase,
    character.corporation_id,
  );
  const payload = buildCorporationMemberPayload(corporation, members, ships, destroyedShips);
  payload.joined_at = character.corporation_joined_at;
  return { corporation: payload };
}

async function loadCharacterSafe(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
) {
  try {
    return await loadCharacter(supabase, characterId);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.toLowerCase().includes("not found")
    ) {
      throw new MyCorporationError("Character not found", 404);
    }
    console.error("my_corporation.character", err);
    throw new MyCorporationError("Failed to load character data", 500);
  }
}

async function loadCorporationSafe(
  supabase: ReturnType<typeof createServiceRoleClient>,
  corpId: string,
) {
  try {
    return await loadCorporationById(supabase, corpId);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.toLowerCase().includes("not found")
    ) {
      throw new MyCorporationError("Corporation not found", 404);
    }
    console.error("my_corporation.corporation", err);
    throw new MyCorporationError("Failed to load corporation data", 500);
  }
}
