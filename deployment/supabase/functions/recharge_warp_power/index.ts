import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

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
  loadCharacter,
  loadShip,
  loadShipDefinition,
  buildStatusPayload,
} from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import {
  loadUniverseMeta,
  isMegaPortSector,
} from "../_shared/fedspace.ts";

class RechargeWarpPowerError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RechargeWarpPowerError";
    this.status = status;
  }
}

const PRICE_PER_UNIT = 2;

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
    console.error("recharge_warp_power.parse", err);
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
  const characterId = await canonicalizeCharacterId(rawCharacterId);
  const actorCharacterLabel = optionalString(payload, "actor_character_id");
  const actorCharacterId = actorCharacterLabel
    ? await canonicalizeCharacterId(actorCharacterLabel)
    : null;
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  try {
    await enforceRateLimit(supabase, characterId, "recharge_warp_power");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "recharge_warp_power",
        requestId,
        detail: "Too many recharge_warp_power requests",
        status: 429,
      });
      return errorResponse("Too many recharge_warp_power requests", 429);
    }
    console.error("recharge_warp_power.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    return await handleRecharge(
      supabase,
      payload,
      characterId,
      rawCharacterId,
      requestId,
      actorCharacterId,
      adminOverride,
      taskId,
    );
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "recharge_warp_power",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof RechargeWarpPowerError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "recharge_warp_power",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("recharge_warp_power.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "recharge_warp_power",
      requestId,
      detail: "internal server error",
      status: 500,
    });
    return errorResponse("internal server error", 500);
  }
});

async function handleRecharge(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  characterLabelFallback: string,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
  taskId: string | null,
): Promise<Response> {
  const source = buildEventSource("recharge_warp_power", requestId);

  const unitsRaw = optionalNumber(payload, "units");
  if (unitsRaw === null || !Number.isInteger(unitsRaw) || unitsRaw <= 0) {
    throw new RechargeWarpPowerError("units must be a positive integer", 400);
  }
  const unitsRequested = Math.floor(unitsRaw);

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  const characterLabel =
    character.name ?? characterLabelFallback ?? character.character_id;
  const universeMeta = await loadUniverseMeta(supabase);

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  if (ship.in_hyperspace) {
    throw new RechargeWarpPowerError(
      "Character is in hyperspace, cannot recharge warp power",
      400,
    );
  }
  if (
    ship.current_sector === null ||
    ship.current_sector === undefined ||
    !isMegaPortSector(universeMeta, ship.current_sector)
  ) {
    throw new RechargeWarpPowerError(
      `Warp power depot is only available at a mega-port. You are in sector ${ship.current_sector ?? "unknown"}`,
      400,
    );
  }

  const shipDefinition = await loadShipDefinition(supabase, ship.ship_type);
  const currentWarpPower =
    ship.current_warp_power ?? shipDefinition.warp_power_capacity;
  const remainingCapacity =
    shipDefinition.warp_power_capacity - currentWarpPower;
  if (remainingCapacity <= 0) {
    throw new RechargeWarpPowerError("Warp power is already at maximum", 400);
  }

  const unitsToBuy = Math.min(unitsRequested, remainingCapacity);
  const totalCost = unitsToBuy * PRICE_PER_UNIT;
  const currentCredits = ship.credits ?? 0;
  if (currentCredits < totalCost) {
    throw new RechargeWarpPowerError(
      `Insufficient credits. Need ${totalCost} but only have ${currentCredits}`,
      400,
    );
  }

  const shipUpdate = await supabase
    .from("ship_instances")
    .update({
      current_warp_power: currentWarpPower + unitsToBuy,
      credits: currentCredits - totalCost,
    })
    .eq("ship_id", ship.ship_id)
    .select();

  if (shipUpdate.error) {
    console.error("recharge_warp_power.update_ship", shipUpdate.error);
    throw new RechargeWarpPowerError("Failed to update ship state", 500);
  }
  if (!shipUpdate.data || shipUpdate.data.length === 0) {
    throw new RechargeWarpPowerError("No ship updated - ship not found", 404);
  }

  await supabase
    .from("characters")
    .update({ last_active: new Date().toISOString() })
    .eq("character_id", characterId);

  const timestamp = new Date().toISOString();
  const warpPayload = {
    source,
    character_id: characterLabel,
    ship_id: ship.ship_id,
    ship_name: ship.ship_name ?? null,
    sector: { id: ship.current_sector },
    units: unitsToBuy,
    price_per_unit: PRICE_PER_UNIT,
    total_cost: totalCost,
    timestamp,
    new_warp_power: currentWarpPower + unitsToBuy,
    warp_power_capacity: shipDefinition.warp_power_capacity,
    new_credits: currentCredits - totalCost,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "warp.purchase",
    payload: warpPayload,
    sectorId: ship.current_sector,
    shipId: ship.ship_id,
    requestId,
    taskId,
    corpId: character.corporation_id,
  });

  const statusPayload = await buildStatusPayload(supabase, characterId);
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "status.update",
    payload: statusPayload,
    sectorId: ship.current_sector,
    shipId: ship.ship_id,
    requestId,
    taskId,
    corpId: character.corporation_id,
  });

  return successResponse({ request_id: requestId });
}
