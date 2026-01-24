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

/**
 * Public endpoint for looking up character information by character_id.
 *
 * This endpoint does NOT require admin password since character display names
 * are already public information visible in-game.
 *
 * Returns: character_id, name, created_at
 */
Deno.serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
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

  // Rate limit per character lookup (prevents abuse)
  try {
    await enforceRateLimit(supabase, characterId, "character_info");
  } catch (err) {
    if (err instanceof RateLimitError) {
      return errorResponse("Too many character_info requests", 429);
    }
    console.error("character_info.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  // Query character profile from database
  try {
    const { data, error } = await supabase
      .from("characters")
      .select("character_id, name, created_at")
      .eq("character_id", characterId)
      .single();

    if (error) {
      console.error("character_info.query", error);
      if (error.code === "PGRST116") {
        // PostgreSQL error code for no rows returned
        return errorResponse(`Character not found: ${characterId}`, 404);
      }
      return errorResponse("database query failed", 500);
    }

    if (!data) {
      return errorResponse(`Character not found: ${characterId}`, 404);
    }

    return successResponse({
      character_id: data.character_id,
      name: data.name,
      created_at: data.created_at,
    });
  } catch (err) {
    console.error("character_info.unhandled", err);
    return errorResponse("internal server error", 500);
  }
});
