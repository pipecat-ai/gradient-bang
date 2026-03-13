import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { traced } from "../_shared/weave.ts";

/**
 * Public endpoint for looking up character information by character_id.
 *
 * This endpoint does NOT require admin password since character display names
 * are already public information visible in-game.
 *
 * Returns: character_id, name, created_at
 */
Deno.serve(traced("character_info", async (req, trace) => {
  const sAuth = trace.span("auth_check");
  if (!validateApiToken(req)) {
    sAuth.end({ error: "unauthorized" });
    return unauthorizedResponse();
  }
  sAuth.end();

  const supabase = createServiceRoleClient();
  let payload;
  const sParse = trace.span("parse_request");
  try {
    payload = await parseJsonRequest(req);
    sParse.end();
  } catch (err) {
    sParse.end({ error: err instanceof Error ? err.message : String(err) });
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("character_info.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const rawCharacterId = requireString(payload, "character_id");
  let characterId: string;
  try {
    characterId = await canonicalizeCharacterId(rawCharacterId);
  } catch (err) {
    console.error("character_info.canonicalize_character_id", err);
    return errorResponse("invalid character_id", 400);
  }

  trace.setInput({ characterId, requestId });

  // Rate limit per character lookup (prevents abuse)
  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "character_info");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      return errorResponse("Too many character_info requests", 429);
    }
    console.error("character_info.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  // Query character profile from database
  const sQuery = trace.span("query_character", { characterId });
  try {
    const { data, error } = await supabase
      .from("characters")
      .select("character_id, name, created_at")
      .eq("character_id", characterId)
      .single();

    if (error) {
      sQuery.end({ error: error.message });
      console.error("character_info.query", error);
      if (error.code === "PGRST116") {
        // PostgreSQL error code for no rows returned
        return errorResponse(`Character not found: ${characterId}`, 404);
      }
      return errorResponse("database query failed", 500);
    }

    if (!data) {
      sQuery.end({ error: "not found" });
      return errorResponse(`Character not found: ${characterId}`, 404);
    }

    sQuery.end({ name: data.name });
    trace.setOutput({ request_id: requestId, character_id: data.character_id, name: data.name });
    return successResponse({
      character_id: data.character_id,
      name: data.name,
      created_at: data.created_at,
    });
  } catch (err) {
    sQuery.end({ error: err instanceof Error ? err.message : String(err) });
    console.error("character_info.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));
