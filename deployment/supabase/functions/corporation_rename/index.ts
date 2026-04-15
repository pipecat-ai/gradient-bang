/**
 * Edge Function: corporation_rename
 *
 * Renames the caller's corporation.
 * Emits corporation.data to every active member so clients hydrate the new name.
 */

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { emitCharacterEvent, buildEventSource, emitErrorEvent } from "../_shared/events.ts";
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
  validateDisplayName,
  NameValidationError,
} from "../_shared/name_validation.ts";
import {
  buildCorporationMemberPayload,
  fetchCorporationMembers,
  fetchCorporationShipSummaries,
  fetchDestroyedCorporationShips,
  isActiveCorporationMember,
  listCorporationMemberIds,
  loadCorporationById,
} from "../_shared/corporations.ts";
import { traced } from "../_shared/weave.ts";

class CorporationRenameError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CorporationRenameError";
    this.status = status;
  }
}

Deno.serve(traced("corporation_rename", async (req, trace) => {
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
    console.error("corporation_rename.parse", err);
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
  const nameInput = requireString(payload, "name");
  const actorCharacterId = optionalString(payload, "actor_character_id");
  ensureActorMatches(actorCharacterId, characterId);

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "corporation_rename");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "corporation_rename",
        requestId,
        detail: "Too many corporation_rename requests",
        status: 429,
      });
      return errorResponse("Too many corporation requests", 429);
    }
    console.error("corporation_rename.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const sRename = trace.span("handle_rename", { characterId });
    const result = await handleRename({
      supabase,
      characterId,
      nameInput,
      requestId,
    });
    sRename.end(result);
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof NameValidationError) {
      return errorResponse(err.message, err.status, { code: err.code });
    }
    if (err instanceof CorporationRenameError) {
      return errorResponse(err.message, err.status);
    }
    console.error("corporation_rename.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));

async function handleRename(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  nameInput: string;
  requestId: string;
}): Promise<{ name: string }> {
  const { supabase, characterId, nameInput, requestId } = params;

  const character = await loadCharacter(supabase, characterId);
  const corpId = character.corporation_id;
  if (!corpId) {
    throw new CorporationRenameError("Not in a corporation", 400);
  }

  const isMember = await isActiveCorporationMember(supabase, corpId, characterId);
  if (!isMember) {
    throw new CorporationRenameError("Not authorized for this corporation", 403);
  }

  const trimmedName = validateDisplayName(nameInput, "corporation");

  // Case-insensitive uniqueness check (exclude own corporation and disbanded)
  const { data: duplicate, error: dupError } = await supabase
    .from("corporations")
    .select("corp_id")
    .ilike("name", trimmedName)
    .neq("corp_id", corpId)
    .is("disbanded_at", null)
    .maybeSingle();
  if (dupError) {
    console.error("corporation_rename.uniqueness_check", dupError);
    throw new CorporationRenameError("Failed to validate name uniqueness", 500);
  }
  if (duplicate) {
    throw new CorporationRenameError("Corporation name already exists", 409);
  }

  // Update the name
  const { error: updateError } = await supabase
    .from("corporations")
    .update({ name: trimmedName })
    .eq("corp_id", corpId);
  if (updateError) {
    console.error("corporation_rename.update", updateError);
    throw new CorporationRenameError("Failed to rename corporation", 500);
  }

  // Load full corporation data to emit to members
  const [corporation, members, ships, destroyedShips, memberIds] = await Promise.all([
    loadCorporationById(supabase, corpId),
    fetchCorporationMembers(supabase, corpId),
    fetchCorporationShipSummaries(supabase, corpId),
    fetchDestroyedCorporationShips(supabase, corpId),
    listCorporationMemberIds(supabase, corpId),
  ]);

  const corpPayload = buildCorporationMemberPayload(corporation, members, ships, destroyedShips);
  const source = buildEventSource("corporation_rename", requestId);

  // Emit corporation.data to every active member so their clients hydrate
  for (const memberId of memberIds) {
    await emitCharacterEvent({
      supabase,
      characterId: memberId,
      eventType: "corporation.data",
      payload: { source, corporation: corpPayload },
      requestId,
    });
  }

  return { name: trimmedName };
}

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationRenameError(
      "actor_character_id must match character_id for corporation.rename",
      400,
    );
  }
}
