import { validate as validateUuid } from "https://deno.land/std@0.197.0/uuid/mod.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  buildStatusPayload,
  loadCharacter,
  loadShip,
  loadShipDefinition,
  type ShipRow,
} from "../_shared/status.ts";
import {
  emitCorporationEvent,
  isActiveCorporationMember,
  loadCorporationById,
} from "../_shared/corporations.ts";
import { calculateTradeInValue } from "../_shared/ships.ts";
import {
  optionalString,
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import {
  loadUniverseMeta,
  isMegaPortSector,
  type UniverseMeta,
} from "../_shared/fedspace.ts";

class ShipSellError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ShipSellError";
    this.status = status;
  }
}

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
    console.error("ship_sell.parse", err);
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
  const actorCharacterId = optionalString(payload, "actor_character_id");
  // When a corp ship agent calls sell_ship, character_id is the corp ship's
  // own ID. The actual player is in actor_character_id. Always use the actor
  // (the player) as the seller so we load the right personal ship.
  const characterId = actorCharacterId ?? rawCharacterId;
  const shipIdRaw = requireString(payload, "ship_id");
  const taskId = optionalString(payload, "task_id");

  try {
    await enforceRateLimit(supabase, characterId, "ship_sell");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "ship_sell",
        requestId,
        detail: "Too many ship_sell requests",
        status: 429,
      });
      return errorResponse("Too many ship_sell requests", 429);
    }
    console.error("ship_sell.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    return await handleShipSell(
      supabase,
      characterId,
      shipIdRaw,
      requestId,
      taskId,
    );
  } catch (err) {
    if (err instanceof ShipSellError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "ship_sell",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("ship_sell.unhandled", err);
    const detail =
      err instanceof Error ? err.message : "internal server error";
    await emitErrorEvent(supabase, {
      characterId,
      method: "ship_sell",
      requestId,
      detail,
      status: 500,
    });
    return errorResponse(detail, 500);
  }
});

async function handleShipSell(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
  shipIdRaw: string,
  requestId: string,
  taskId: string | null,
): Promise<Response> {
  // Load the character and their personal ship
  let character;
  try {
    character = await loadCharacter(supabase, characterId);
  } catch (err) {
    throw new ShipSellError(
      `Failed to load character: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }

  let personalShip;
  try {
    personalShip = await loadShip(supabase, character.current_ship_id);
  } catch (err) {
    throw new ShipSellError(
      `Failed to load personal ship: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  // Resolve ship_id — accept full UUID or 6-8 hex prefix
  const shipId = await resolveShipId(supabase, shipIdRaw, characterId);

  // Cannot sell your personal ship
  if (shipId === personalShip.ship_id) {
    throw new ShipSellError(
      "Cannot sell your personal ship — you would be left without a ship",
    );
  }

  // Player must be at a mega port
  if (personalShip.in_hyperspace) {
    throw new ShipSellError("Cannot sell ships while in hyperspace", 409);
  }
  await ensureNotInCombat(supabase, personalShip);
  const universeMeta = await loadUniverseMeta(supabase);
  ensureShipAtMegaPort(universeMeta, personalShip);

  // Load the target ship being sold
  let targetShip;
  try {
    targetShip = await loadShip(supabase, shipId);
  } catch (err) {
    throw new ShipSellError(
      `Ship not found: ${err instanceof Error ? err.message : String(err)}`,
      404,
    );
  }

  // Must be a corporation ship
  if (targetShip.owner_type !== "corporation") {
    throw new ShipSellError("Only corporation ships can be sold");
  }

  const corpId = targetShip.owner_corporation_id;
  if (!corpId) {
    throw new ShipSellError("Ship has no corporation owner", 400);
  }

  // Character must be an active member of the corporation
  const isMember = await isActiveCorporationMember(
    supabase,
    corpId,
    characterId,
  );
  if (!isMember) {
    throw new ShipSellError(
      "Not authorized — you are not a member of this corporation",
      403,
    );
  }

  // Only the character who purchased the ship can sell it
  const { data: corpShipRow, error: corpShipError } = await supabase
    .from("corporation_ships")
    .select("added_by")
    .eq("corp_id", corpId)
    .eq("ship_id", shipId)
    .maybeSingle();

  if (corpShipError) {
    console.error("ship_sell.corp_ship_lookup", corpShipError);
    throw new ShipSellError("Failed to verify ship ownership", 500);
  }
  if (!corpShipRow) {
    throw new ShipSellError("Ship is not registered as a corporation ship");
  }
  if (corpShipRow.added_by !== characterId) {
    throw new ShipSellError(
      "You can only sell corporation ships that you purchased",
      403,
    );
  }

  // Calculate trade-in value
  let targetDefinition;
  try {
    targetDefinition = await loadShipDefinition(
      supabase,
      targetShip.ship_type,
    );
  } catch (err) {
    throw new ShipSellError(
      `Failed to load ship definition: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
  const tradeInValue = calculateTradeInValue(targetShip, targetDefinition);

  const timestamp = new Date().toISOString();

  // Add trade-in credits to the player's personal ship
  const personalCredits = personalShip.credits ?? 0;
  const creditsAfter = personalCredits + tradeInValue;
  const { error: creditError } = await supabase
    .from("ship_instances")
    .update({ credits: creditsAfter })
    .eq("ship_id", personalShip.ship_id);
  if (creditError) {
    console.error("ship_sell.credit_update", creditError);
    throw new ShipSellError("Failed to apply sale credits", 500);
  }

  // Mark the sold ship as unowned
  const { error: unownedError } = await supabase
    .from("ship_instances")
    .update({
      owner_type: "unowned",
      owner_id: null,
      owner_character_id: null,
      owner_corporation_id: null,
      became_unowned: timestamp,
      former_owner_name: character.name,
    })
    .eq("ship_id", shipId);
  if (unownedError) {
    console.error("ship_sell.unown_ship", unownedError);
    throw new ShipSellError("Failed to mark ship as unowned", 500);
  }

  // Remove the corporation_ships association
  const { error: corpShipDeleteError } = await supabase
    .from("corporation_ships")
    .delete()
    .eq("corp_id", corpId)
    .eq("ship_id", shipId);
  if (corpShipDeleteError) {
    console.error("ship_sell.corp_ship_delete", corpShipDeleteError);
    // Non-fatal — ship is already unowned
  }

  // Emit status.update so the player's client refreshes
  const source = buildEventSource("ship_sell", requestId);
  const statusPayload = await buildStatusPayload(supabase, characterId);
  const sectorId = personalShip.current_sector ?? 0;

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "status.update",
    payload: statusPayload,
    sectorId,
    requestId,
    corpId,
    taskId,
    shipId: personalShip.ship_id,
  });

  // Emit corporation event
  let corpName = "Unknown";
  try {
    const corporation = await loadCorporationById(supabase, corpId);
    corpName = corporation.name;
  } catch {
    // Non-fatal — use fallback name
  }
  await emitCorporationEvent(supabase, corpId, {
    eventType: "corporation.ship_sold",
    payload: {
      source,
      corp_id: corpId,
      corp_name: corpName,
      ship_id: shipId,
      ship_type: targetShip.ship_type,
      ship_name: targetShip.ship_name,
      trade_in_value: tradeInValue,
      seller_id: characterId,
      seller_name: character.name,
      sector: personalShip.current_sector ?? 0,
      timestamp,
    },
    requestId,
    taskId,
  });

  return successResponse({
    ship_id: shipId,
    trade_in_value: tradeInValue,
    credits_after: creditsAfter,
    request_id: requestId,
  });
}

/**
 * Resolve a ship_id that may be a full UUID or a 6-8 hex prefix.
 * For prefixes, look up matching corporation ships owned by the character.
 */
async function resolveShipId(
  supabase: ReturnType<typeof createServiceRoleClient>,
  value: string,
  characterId: string,
): Promise<string> {
  const trimmed = value.trim();

  // Full UUID — use directly
  if (validateUuid(trimmed)) {
    return trimmed;
  }

  // 6-8 hex prefix — resolve against character's corporation ships
  if (/^[0-9a-f]{6,8}$/i.test(trimmed)) {
    const prefix = trimmed.toLowerCase();
    // Get the character's corporation
    const { data: charData } = await supabase
      .from("characters")
      .select("corporation_id")
      .eq("character_id", characterId)
      .maybeSingle();
    const corpId = charData?.corporation_id;
    if (!corpId) {
      throw new ShipSellError("Not in a corporation — cannot resolve ship prefix");
    }
    // Get all corp ship IDs and match prefix
    const { data: corpShips } = await supabase
      .from("corporation_ships")
      .select("ship_id")
      .eq("corp_id", corpId);
    if (corpShips) {
      for (const row of corpShips) {
        if (row.ship_id && row.ship_id.toLowerCase().startsWith(prefix)) {
          return row.ship_id;
        }
      }
    }
    throw new ShipSellError(`No corporation ship found matching prefix "${trimmed}"`, 404);
  }

  throw new ShipSellError(
    "ship_id must be a UUID or 6-8 hex prefix",
    400,
  );
}

async function ensureNotInCombat(
  supabase: ReturnType<typeof createServiceRoleClient>,
  ship: ShipRow,
): Promise<void> {
  const sectorId = ship.current_sector;
  if (sectorId === null || sectorId === undefined) {
    return;
  }
  const { data, error } = await supabase
    .from("sector_contents")
    .select("combat")
    .eq("sector_id", sectorId)
    .maybeSingle();
  if (error) {
    console.error("ship_sell.combat_check", error);
    throw new ShipSellError("Failed to verify combat state", 500);
  }
  if (data && data.combat) {
    throw new ShipSellError("Cannot sell ships while in combat", 409);
  }
}

function ensureShipAtMegaPort(meta: UniverseMeta, ship: ShipRow): void {
  if (
    ship.current_sector === null ||
    ship.current_sector === undefined ||
    !isMegaPortSector(meta, ship.current_sector)
  ) {
    throw new ShipSellError(
      `Ship sales require docking at a mega-port. You are in sector ${ship.current_sector ?? "unknown"}`,
      400,
    );
  }
}
