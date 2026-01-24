import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  successResponse,
  errorResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import {
  loadCharacter,
  loadShip,
  buildStatusPayload,
} from "../_shared/status.ts";
import {
  generateInviteCode,
  upsertCorporationMembership,
} from "../_shared/corporations.ts";

const CORPORATION_CREATION_COST = 10_000;

class CorporationCreateError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CorporationCreateError";
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
    console.error("corporation_create.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const supabase = createServiceRoleClient();
  const characterId = requireString(payload, "character_id");
  const nameInput = requireString(payload, "name");
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const taskId = optionalString(payload, "task_id");
  ensureActorMatches(actorCharacterId, characterId);

  const normalizedName = nameInput.trim();
  if (normalizedName.length < 3 || normalizedName.length > 50) {
    return errorResponse("Name must be 3-50 characters", 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, "corporation_create");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "corporation_create",
        requestId,
        detail: "Too many corporation_create requests",
        status: 429,
      });
      return errorResponse("Too many corporation requests", 429);
    }
    console.error("corporation_create.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const result = await handleCreate({
      supabase,
      characterId,
      normalizedName,
      requestId,
      taskId,
    });
    return successResponse({ ...result, request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationCreateError) {
      return errorResponse(err.message, err.status);
    }
    console.error("corporation_create.unhandled", err);
    return errorResponse("internal server error", 500);
  }
});

async function handleCreate(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  normalizedName: string;
  requestId: string;
  taskId: string | null;
}): Promise<Record<string, unknown>> {
  const { supabase, characterId, normalizedName, requestId, taskId } = params;
  const character = await loadCharacter(supabase, characterId);
  if (character.corporation_id) {
    throw new CorporationCreateError("Already in a corporation", 400);
  }

  const ship = await loadShip(supabase, character.current_ship_id);
  const shipCredits = ship.credits ?? 0;
  if (shipCredits < CORPORATION_CREATION_COST) {
    throw new CorporationCreateError(
      `Insufficient credits (need ${CORPORATION_CREATION_COST.toLocaleString()})`,
      400,
    );
  }

  const inviteCode = generateInviteCode();
  const inserted = await insertCorporation({
    supabase,
    name: normalizedName,
    founderId: characterId,
    inviteCode,
  });
  const joinedAt = inserted.founded ?? new Date().toISOString();

  await upsertCorporationMembership(
    supabase,
    inserted.corp_id,
    characterId,
    joinedAt,
  );
  await updateShipCredits(
    supabase,
    ship.ship_id,
    shipCredits - CORPORATION_CREATION_COST,
  );
  const { error: characterUpdateError } = await supabase
    .from("characters")
    .update({
      corporation_id: inserted.corp_id,
      corporation_joined_at: joinedAt,
      last_active: new Date().toISOString(),
    })
    .eq("character_id", characterId);
  if (characterUpdateError) {
    console.error("corporation_create.character_update", characterUpdateError);
    throw new CorporationCreateError("Failed to update character state", 500);
  }

  const source = buildEventSource("corporation_create", requestId);
  const statusPayload = await buildStatusPayload(supabase, characterId);
  const timestamp = new Date().toISOString();
  const eventPayload = {
    source,
    corp_id: inserted.corp_id,
    name: inserted.name,
    invite_code: inserted.invite_code,
    founder_id: characterId,
    member_count: 1,
    timestamp,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "corporation.created",
    payload: eventPayload,
    sectorId: ship.current_sector ?? null,
    requestId,
    corpId: inserted.corp_id,
    taskId,
  });

  return {
    corp_id: inserted.corp_id,
    name: inserted.name,
    invite_code: inserted.invite_code,
    founder_id: characterId,
    member_count: 1,
  };
}

async function insertCorporation(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  name: string;
  founderId: string;
  inviteCode: string;
}): Promise<{
  corp_id: string;
  name: string;
  founded: string;
  invite_code: string;
}> {
  const { supabase, name, founderId, inviteCode } = params;
  const timestamp = new Date().toISOString();
  const { data, error } = await supabase
    .from("corporations")
    .insert({
      name,
      founder_id: founderId,
      invite_code: inviteCode,
      invite_code_generated: timestamp,
      invite_code_generated_by: founderId,
    })
    .select("corp_id, name, founded, invite_code")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new CorporationCreateError(
        `Corporation name '${name}' already taken`,
        400,
      );
    }
    console.error("corporation_create.insert", error);
    throw new CorporationCreateError("Failed to create corporation", 500);
  }
  if (!data) {
    throw new CorporationCreateError("Failed to create corporation", 500);
  }
  return data as {
    corp_id: string;
    name: string;
    founded: string;
    invite_code: string;
  };
}

async function updateShipCredits(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipId: string,
  credits: number,
): Promise<void> {
  const { data, error } = await supabase
    .from("ship_instances")
    .update({ credits })
    .eq("ship_id", shipId)
    .select();
  if (error) {
    console.error("corporation_create.ship_update", error);
    throw new CorporationCreateError("Failed to update ship credits", 500);
  }
  if (!data || data.length === 0) {
    console.error("corporation_create.ship_update_no_rows", {
      shipId,
      credits,
    });
    throw new CorporationCreateError("Ship not found for credit update", 500);
  }
}

function ensureActorMatches(actorId: string | null, characterId: string): void {
  if (actorId && actorId !== characterId) {
    throw new CorporationCreateError(
      "actor_character_id must match character_id for corporation.create",
      400,
    );
  }
}
