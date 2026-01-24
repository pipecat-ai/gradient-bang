import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { buildEventSource, emitErrorEvent } from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { loadCharacter } from "../_shared/status.ts";
import {
  emitCorporationEvent,
  generateInviteCode,
  isActiveCorporationMember,
} from "../_shared/corporations.ts";

class CorporationInviteError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CorporationInviteError";
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
    console.error("corporation_regenerate_invite_code.parse", err);
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
  const actorCharacterId = optionalString(payload, "actor_character_id");
  ensureActorMatches(actorCharacterId, characterId);

  try {
    await enforceRateLimit(
      supabase,
      characterId,
      "corporation_regenerate_invite_code",
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "corporation_regenerate_invite_code",
        requestId,
        detail: "Too many corporation_regenerate_invite_code requests",
        status: 429,
      });
      return errorResponse("Too many corporation requests", 429);
    }
    console.error("corporation_regenerate_invite_code.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const result = await handleRegenerate({ supabase, characterId, requestId });
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationInviteError) {
      return errorResponse(err.message, err.status);
    }
    console.error("corporation_regenerate_invite_code.unhandled", err);
    return errorResponse("internal server error", 500);
  }
});

async function handleRegenerate(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  requestId: string;
}): Promise<{ new_invite_code: string }> {
  const { supabase, characterId, requestId } = params;
  const character = await loadCharacter(supabase, characterId);
  const corpId = character.corporation_id;
  if (!corpId) {
    throw new CorporationInviteError("Not in a corporation", 400);
  }

  const isMember = await isActiveCorporationMember(
    supabase,
    corpId,
    characterId,
  );
  if (!isMember) {
    throw new CorporationInviteError(
      "Not authorized for this corporation",
      403,
    );
  }

  const newCode = generateInviteCode();
  const timestamp = new Date().toISOString();
  const { data, error } = await supabase
    .from("corporations")
    .update({
      invite_code: newCode,
      invite_code_generated: timestamp,
      invite_code_generated_by: characterId,
    })
    .eq("corp_id", corpId)
    .select("name")
    .maybeSingle();
  if (error) {
    console.error("corporation_regenerate_invite_code.update", error);
    throw new CorporationInviteError("Failed to regenerate invite code", 500);
  }
  if (!data) {
    throw new CorporationInviteError("Corporation not found", 404);
  }

  const source = buildEventSource(
    "corporation_regenerate_invite_code",
    requestId,
  );
  const payload = {
    source,
    corp_id: corpId,
    name: typeof data.name === "string" ? data.name : corpId,
    new_invite_code: newCode,
    generated_by: characterId,
    timestamp,
  };

  await emitCorporationEvent(supabase, corpId, {
    eventType: "corporation.invite_code_regenerated",
    payload,
    requestId,
  });

  return { new_invite_code: newCode };
}

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationInviteError(
      "actor_character_id must match character_id for corporation.regenerate_invite_code",
      400,
    );
  }
}
