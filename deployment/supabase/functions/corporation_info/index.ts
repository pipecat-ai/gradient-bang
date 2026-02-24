import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { loadCharacter } from "../_shared/status.ts";
import {
  buildCorporationMemberPayload,
  buildCorporationPublicPayload,
  fetchCorporationMembers,
  fetchCorporationShipSummaries,
  fetchDestroyedCorporationShips,
  loadCorporationById,
} from "../_shared/corporations.ts";

class CorporationInfoError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CorporationInfoError";
    this.status = status;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
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
    console.error("corporation_info.parse", err);
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
  const corpId = requireString(payload, "corp_id");

  try {
    await enforceRateLimit(supabase, characterId, "corporation_info");
  } catch (err) {
    if (err instanceof RateLimitError) {
      return errorResponse("Too many corporation requests", 429);
    }
    console.error("corporation_info.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const result = await handleInfo({ supabase, characterId, corpId });
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationInfoError) {
      return errorResponse(err.message, err.status);
    }
    console.error("corporation_info.unhandled", err);
    return errorResponse("internal server error", 500);
  }
});

async function handleInfo(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  corpId: string;
}): Promise<Record<string, unknown>> {
  const { supabase, characterId, corpId } = params;
  const character = await loadCharacterSafe(supabase, characterId);
  const corporation = await loadCorporationSafe(supabase, corpId);
  const members = await fetchCorporationMembers(supabase, corpId);
  const memberCount = members.length;
  const isMember = character.corporation_id === corpId;

  if (!isMember) {
    return buildCorporationPublicPayload(corporation, memberCount);
  }

  const ships = await fetchCorporationShipSummaries(supabase, corpId);
  const destroyedShips = await fetchDestroyedCorporationShips(supabase, corpId);
  return buildCorporationMemberPayload(corporation, members, ships, destroyedShips);
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
      throw new CorporationInfoError("Character not found", 404);
    }
    console.error("corporation_info.character", err);
    throw new CorporationInfoError("Failed to load character data", 500);
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
      throw new CorporationInfoError("Corporation not found", 404);
    }
    console.error("corporation_info.corporation", err);
    throw new CorporationInfoError("Failed to load corporation data", 500);
  }
}
