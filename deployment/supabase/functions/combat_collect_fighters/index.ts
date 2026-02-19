import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { createPgClient, connectWithCleanup } from "../_shared/pg.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { computeSectorVisibilityRecipients } from "../_shared/visibility.ts";
import { recordEventWithRecipients } from "../_shared/events.ts";
import {
  pgLoadCharacter,
  pgLoadShip,
  pgEnforceRateLimit,
  pgEnsureActorAuthorization,
  RateLimitError,
  ActorAuthorizationError,
} from "../_shared/pg_queries.ts";
import { runCollectFightersTransaction } from "../_shared/garrison_transactions.ts";

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
    console.error("combat_collect_fighters.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  let requestId: string;
  let characterId: string;
  let sector: number | null;
  let quantity: number | null;
  let actorCharacterId: string | null;
  let adminOverride: boolean;
  let taskId: string | null;
  try {
    requestId = resolveRequestId(payload);
    characterId = requireString(payload, "character_id");
    sector = optionalNumber(payload, "sector");
    quantity = optionalNumber(payload, "quantity");
    actorCharacterId = optionalString(payload, "actor_character_id");
    adminOverride = optionalBoolean(payload, "admin_override") ?? false;
    taskId = optionalString(payload, "task_id");
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    return errorResponse("invalid request payload", 400);
  }

  if (sector === null || sector === undefined) {
    return errorResponse("sector is required", 400);
  }
  if (quantity === null || quantity === undefined) {
    return errorResponse("quantity is required", 400);
  }

  const pg = createPgClient();
  try {
    await connectWithCleanup(pg);

    try {
      await pgEnforceRateLimit(pg, characterId, "combat_collect_fighters");
    } catch (err) {
      if (err instanceof RateLimitError) {
        await emitErrorEvent(supabase, {
          characterId,
          method: "combat_collect_fighters",
          requestId,
          detail: "Too many requests",
          status: 429,
        });
        return errorResponse("Too many requests", 429);
      }
      console.error("combat_collect_fighters.rate_limit", err);
      return errorResponse("rate limit error", 500);
    }

    return await handleCombatCollectFighters({
      pg,
      supabase,
      requestId,
      characterId,
      sector,
      quantity,
      actorCharacterId,
      adminOverride,
      taskId,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_collect_fighters",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("combat_collect_fighters.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    const detail =
      err instanceof Error ? err.message : "collect fighters failed";
    await emitErrorEvent(supabase, {
      characterId,
      method: "combat_collect_fighters",
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  } finally {
    try {
      await pg.end();
    } catch {
      // Ignore cleanup errors
    }
  }
});

async function handleCombatCollectFighters(params: {
  pg: Awaited<ReturnType<typeof createPgClient>>;
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  sector: number;
  quantity: number;
  actorCharacterId: string | null;
  adminOverride: boolean;
  taskId: string | null;
}): Promise<Response> {
  const {
    pg,
    supabase,
    requestId,
    characterId,
    sector,
    quantity,
    actorCharacterId,
    adminOverride,
    taskId,
  } = params;

  // Validate quantity
  if (quantity <= 0) {
    const err = new Error("Quantity must be positive") as Error & {
      status?: number;
    };
    err.status = 400;
    throw err;
  }

  // Load character and ship via PG, then validate actor controls the ship.
  const character = await pgLoadCharacter(pg, characterId);
  const ship = await pgLoadShip(pg, character.current_ship_id);
  await pgEnsureActorAuthorization(pg, {
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  const {
    newShipFighters,
    newShipCredits,
    tollPayout,
    updatedGarrison,
  } = await runCollectFightersTransaction(pg, {
    sectorId: sector,
    characterId,
    shipId: ship.ship_id,
    quantity,
  });

  if (tollPayout > 0) {
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "status.update",
      payload: {
        source: buildEventSource("combat.collect_fighters", requestId),
        sector: { id: sector },
        credits: newShipCredits,
        ship: {
          ship_id: ship.ship_id,
          ship_type: ship.ship_type,
          credits: newShipCredits,
          current_fighters: newShipFighters,
        },
      },
      sectorId: sector,
      requestId,
      taskId,
      shipId: ship.ship_id,
      actorCharacterId: characterId,
      corpId: character.corporation_id,
    });
  }

  // Build garrison payload for event
  // Fetch garrison owner's name for the event
  let garrisonOwnerName: string | null = null;
  if (updatedGarrison) {
    const ownerChar = await pgLoadCharacter(pg, updatedGarrison.owner_id);
    garrisonOwnerName = ownerChar.name;
  }

  const garrisonPayload = updatedGarrison
    ? {
        owner_name: garrisonOwnerName!, // Human-readable name, not UUID
        fighters: updatedGarrison.fighters,
        fighter_loss: null,
        mode: updatedGarrison.mode,
        toll_amount: updatedGarrison.toll_amount,
        deployed_at: updatedGarrison.deployed_at,
        is_friendly: updatedGarrison.owner_id === characterId, // Friendly if collector owns it
      }
    : null;

  // Emit garrison.collected event to character
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "garrison.collected",
    payload: {
      source: buildEventSource("combat.collect_fighters", requestId),
      sector: { id: sector },
      credits_collected: tollPayout,
      garrison: garrisonPayload,
      fighters_on_ship: newShipFighters,
    },
    sectorId: sector,
    requestId,
    taskId,
    shipId: ship.ship_id,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  // Emit sector.update to all sector occupants
  const recipients = await computeSectorVisibilityRecipients(
    supabase,
    sector,
    [],
  );
  if (recipients.length > 0) {
    // Build sector update payload
    // For now, we'll emit a simple notification that sector contents changed
    // The full sector_contents payload would require loading all sector data
    await recordEventWithRecipients({
      supabase,
      eventType: "sector.update",
      scope: "sector",
      payload: {
        source: buildEventSource("combat.collect_fighters", requestId),
        sector: { id: sector },
        // TODO: Add full sector contents if needed
      },
      recipients,
      sectorId: sector,
      actorCharacterId: characterId,
      requestId,
      taskId,
    });
  }

  return successResponse({ success: true });
}
