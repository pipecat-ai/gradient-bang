import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
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
  type ShipDefinitionRow,
} from "../_shared/status.ts";
import {
  emitCorporationEvent,
  isActiveCorporationMember,
  loadCorporationById,
} from "../_shared/corporations.ts";
import {
  calculateTradeInValue,
  isAutonomousShipType,
} from "../_shared/ships.ts";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";

class ShipPurchaseError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ShipPurchaseError";
    this.status = status;
  }
}

const PERSONAL_PURCHASE = "personal";
const CORPORATION_PURCHASE = "corporation";

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
    console.error("ship_purchase.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, "character_id");
  const shipTypeRaw = requireString(payload, "ship_type").toLowerCase();
  const purchaseTypeInput = optionalString(
    payload,
    "purchase_type",
  )?.toLowerCase();
  const forCorporation = optionalBoolean(payload, "for_corporation") ?? false;
  const purchaseType =
    purchaseTypeInput ??
    (forCorporation ? CORPORATION_PURCHASE : PERSONAL_PURCHASE);
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  if (actorCharacterId && actorCharacterId !== characterId && !adminOverride) {
    return errorResponse(
      "actor_character_id must match character_id unless admin_override is true",
      403,
    );
  }

  if (
    purchaseType !== PERSONAL_PURCHASE &&
    purchaseType !== CORPORATION_PURCHASE
  ) {
    return errorResponse("purchase_type must be 'personal'", 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, "ship_purchase");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "ship_purchase",
        requestId,
        detail: "Too many ship_purchase requests",
        status: 429,
      });
      return errorResponse("Too many ship_purchase requests", 429);
    }
    console.error("ship_purchase.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    if (purchaseType === CORPORATION_PURCHASE) {
      return await handleCorporationPurchase(
        supabase,
        payload,
        characterId,
        shipTypeRaw,
        requestId,
        taskId,
      );
    }
    return await handlePersonalPurchase(
      supabase,
      payload,
      characterId,
      shipTypeRaw,
      requestId,
      taskId,
    );
  } catch (err) {
    if (err instanceof ShipPurchaseError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "ship_purchase",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("ship_purchase.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId,
      method: "ship_purchase",
      requestId,
      detail: "internal server error",
      status: 500,
    });
    return errorResponse("internal server error", 500);
  }
});

async function handlePersonalPurchase(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  shipType: string,
  requestId: string,
  taskId: string | null,
): Promise<Response> {
  if (isAutonomousShipType(shipType)) {
    throw new ShipPurchaseError(
      "Autonomous ship types may only be purchased for corporations",
    );
  }

  const character = await loadCharacter(supabase, characterId);
  const currentShip = await loadShip(supabase, character.current_ship_id);
  if (currentShip.in_hyperspace) {
    throw new ShipPurchaseError(
      "Cannot purchase ships while in hyperspace",
      409,
    );
  }
  await ensureNotInCombat(supabase, currentShip);

  const tradeInShipIdRaw = optionalString(payload, "trade_in_ship_id");
  const tradeInShipId = normalizeTradeInShipId(
    tradeInShipIdRaw,
    currentShip.ship_id,
  );
  if (tradeInShipIdRaw && tradeInShipId !== currentShip.ship_id) {
    throw new ShipPurchaseError("Trade-in ship must match your current ship");
  }

  const targetDefinition = await loadShipDefinition(supabase, shipType);
  const tradeInDefinition = await loadShipDefinition(
    supabase,
    currentShip.ship_type,
  );
  const tradeInValue = calculateTradeInValue(currentShip, tradeInDefinition);
  const price = targetDefinition.purchase_price ?? 0;
  const netCost = Math.max(0, price - tradeInValue);

  const shipCredits = currentShip.credits ?? 0;
  if (shipCredits < netCost) {
    throw new ShipPurchaseError(`Insufficient credits (need ${netCost})`);
  }

  const remainingCredits = shipCredits - netCost;
  const shipNameOverride = optionalString(payload, "ship_name");
  let shipName = shipNameOverride ?? targetDefinition.display_name;
  if (shipNameOverride) {
    await ensureShipNameAvailable(supabase, shipName);
  } else {
    shipName = await generateUniqueShipName(supabase, shipName);
  }
  const insertedShip = await insertShip({
    supabase,
    ownerType: "character",
    ownerId: characterId,
    shipType,
    shipName,
    sectorId: currentShip.current_sector ?? 0,
    definition: targetDefinition,
    credits: remainingCredits,
  });
  const newShipId = insertedShip.ship_id;

  const timestamp = new Date().toISOString();
  const { error: characterUpdateError } = await supabase
    .from("characters")
    .update({ current_ship_id: newShipId, last_active: timestamp })
    .eq("character_id", characterId);
  if (characterUpdateError) {
    console.error("ship_purchase.character_update", characterUpdateError);
    throw new ShipPurchaseError("Failed to update character state", 500);
  }

  // Mark old ship as unowned (trade-in) instead of deleting
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
    .eq("ship_id", currentShip.ship_id);
  if (unownedError) {
    console.error("ship_purchase.old_ship_unowned", unownedError);
    throw new ShipPurchaseError("Failed to mark old ship as unowned", 500);
  }

  const statusPayload = await buildStatusPayload(supabase, characterId);
  const sectorId =
    insertedShip.current_sector ?? currentShip.current_sector ?? 0;
  const source = buildEventSource("ship_purchase", requestId);

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "status.update",
    payload: statusPayload,
    sectorId,
    requestId,
    corpId: character.corporation_id,
    taskId,
    shipId: insertedShip.ship_id,
  });

  if (currentShip.ship_id) {
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "ship.traded_in",
      payload: {
        source,
        character_id: characterId,
        old_ship_id: currentShip.ship_id,
        old_ship_type: currentShip.ship_type,
        new_ship_id: newShipId,
        new_ship_type: shipType,
        trade_in_value: tradeInValue,
        price,
        net_cost: netCost,
        timestamp,
      },
      sectorId,
      requestId,
      corpId: character.corporation_id,
      taskId,
      shipId: insertedShip.ship_id,
    });
  }

  return successResponse({
    ship_id: newShipId,
    ship_type: shipType,
    net_cost: netCost,
    credits_after: remainingCredits,
    request_id: requestId,
  });
}

async function handleCorporationPurchase(
  supabase: ReturnType<typeof createServiceRoleClient>,
  payload: Record<string, unknown>,
  characterId: string,
  shipType: string,
  requestId: string,
  taskId: string | null,
): Promise<Response> {
  const initialCreditsRaw = optionalNumber(payload, "initial_ship_credits");
  const initialShipCredits =
    initialCreditsRaw === null ? 0 : Math.floor(initialCreditsRaw);
  if (!Number.isInteger(initialShipCredits) || initialShipCredits < 0) {
    throw new ShipPurchaseError(
      "initial_ship_credits must be a non-negative integer",
    );
  }

  const explicitCorpId = optionalString(payload, "corp_id");
  const character = await loadCharacter(supabase, characterId);
  const corpId = explicitCorpId ?? character.corporation_id;
  if (!corpId) {
    throw new ShipPurchaseError("Not in a corporation", 400);
  }

  const isMember = await isActiveCorporationMember(
    supabase,
    corpId,
    characterId,
  );
  if (!isMember) {
    throw new ShipPurchaseError(
      "Not authorized to purchase for this corporation",
      403,
    );
  }
  const corporation = await loadCorporationById(supabase, corpId);

  const currentShip = await loadShip(supabase, character.current_ship_id);
  if (currentShip.in_hyperspace) {
    throw new ShipPurchaseError(
      "Cannot purchase ships while in hyperspace",
      409,
    );
  }
  await ensureNotInCombat(supabase, currentShip);

  if (optionalString(payload, "trade_in_ship_id")) {
    throw new ShipPurchaseError("Cannot trade in a corporation-owned ship");
  }

  const shipDefinition = await loadShipDefinition(supabase, shipType);
  const shipNameOverride = optionalString(payload, "ship_name");
  let shipName = shipNameOverride ?? shipDefinition.display_name;
  if (shipNameOverride) {
    await ensureShipNameAvailable(supabase, shipName);
  } else {
    shipName = await generateUniqueShipName(supabase, shipName);
  }
  const price = shipDefinition.purchase_price ?? 0;
  const totalCost = price + initialShipCredits;
  const bankBalance = character.credits_in_megabank ?? 0;
  if (bankBalance < totalCost) {
    throw new ShipPurchaseError(
      `Insufficient bank balance (need ${totalCost})`,
    );
  }

  const timestamp = new Date().toISOString();
  const insertedShip = await insertShip({
    supabase,
    ownerType: "corporation",
    ownerId: corpId,
    shipType,
    shipName,
    sectorId: currentShip.current_sector ?? 0,
    definition: shipDefinition,
    credits: initialShipCredits,
    metadata: { acquired_by: characterId },
  });

  const { error: bankUpdateError } = await supabase
    .from("characters")
    .update({
      credits_in_megabank: bankBalance - totalCost,
      last_active: timestamp,
    })
    .eq("character_id", characterId);
  if (bankUpdateError) {
    console.error("ship_purchase.bank_update", bankUpdateError);
    throw new ShipPurchaseError("Failed to update bank balance", 500);
  }

  const { error: corpShipInsertError } = await supabase
    .from("corporation_ships")
    .insert({
      corp_id: corpId,
      ship_id: insertedShip.ship_id,
      added_by: characterId,
    });
  if (corpShipInsertError) {
    console.error("ship_purchase.corporation_ship_insert", corpShipInsertError);
    throw new ShipPurchaseError("Failed to register corporation ship", 500);
  }

  await ensureCorporationShipCharacter({
    supabase,
    shipId: insertedShip.ship_id,
    corpId,
    sectorId: currentShip.current_sector ?? 0,
    timestamp,
  });

  const source = buildEventSource("ship_purchase", requestId);
  const statusPayload = await buildStatusPayload(supabase, characterId);

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "status.update",
    payload: statusPayload,
    sectorId: currentShip.current_sector ?? 0,
    requestId,
    corpId,
    taskId,
    shipId: currentShip.ship_id,
  });

  const corpEventPayload = {
    source,
    corp_id: corpId,
    corp_name: corporation.name,
    ship_id: insertedShip.ship_id,
    ship_type: shipType,
    ship_name: shipName,
    purchase_price: price,
    buyer_id: characterId,
    buyer_name: character.name,
    sector: currentShip.current_sector ?? 0,
    timestamp,
  };
  await emitCorporationEvent(supabase, corpId, {
    eventType: "corporation.ship_purchased",
    payload: corpEventPayload,
    requestId,
    taskId,
  });

  return successResponse({
    corp_id: corpId,
    ship_id: insertedShip.ship_id,
    ship_type: shipType,
    initial_ship_credits: initialShipCredits,
    bank_after: bankBalance - totalCost,
    request_id: requestId,
  });
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
    console.error("ship_purchase.combat_check", error);
    throw new ShipPurchaseError("Failed to verify combat state", 500);
  }
  if (data && data.combat) {
    throw new ShipPurchaseError("Cannot purchase ships while in combat", 409);
  }
}

async function ensureCorporationShipCharacter(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  shipId: string;
  corpId: string;
  sectorId: number;
  timestamp: string;
}): Promise<void> {
  const existing = await params.supabase
    .from("characters")
    .select("character_id")
    .eq("character_id", params.shipId)
    .maybeSingle();
  if (existing.data) {
    return;
  }

  const baseName = "Corp Ship";
  let attempt = 0;
  while (attempt < 3) {
    const resolvedName = generateCorporationShipName(
      baseName,
      params.shipId,
      attempt,
    );
    const insert = await params.supabase.from("characters").insert({
      character_id: params.shipId,
      name: resolvedName,
      current_ship_id: params.shipId,
      credits_in_megabank: 0,
      map_knowledge: {
        total_sectors_visited: 0,
        sectors_visited: {},
        current_sector: params.sectorId,
        last_update: params.timestamp,
      },
      player_metadata: {
        player_type: "corporation_ship",
        owner_corp_id: params.corpId,
      },
      is_npc: true,
      first_visit: params.timestamp,
      last_active: params.timestamp,
      created_at: params.timestamp,
      corporation_id: params.corpId,
      corporation_joined_at: params.timestamp,
    });
    if (!insert.error) {
      return;
    }
    if (insert.error.code === "23505") {
      attempt += 1;
      continue;
    }
    console.error("ship_purchase.corporation_character_insert", insert.error);
    throw new ShipPurchaseError(
      "Failed to register corporation ship character",
      500,
    );
  }
  throw new ShipPurchaseError(
    "Failed to register corporation ship character",
    500,
  );
}

function generateCorporationShipName(
  baseName: string,
  shipId: string,
  attempt: number,
): string {
  const suffix = shipId.slice(0, 6);
  if (attempt === 0) {
    return `${baseName} [${suffix}]`;
  }
  return `${baseName} [${suffix}-${attempt}]`;
}

async function ensureShipNameAvailable(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipName: string,
): Promise<void> {
  const available = await isShipNameAvailable(supabase, shipName);
  if (!available) {
    throw new ShipPurchaseError("Ship name already exists", 409);
  }
}

async function generateUniqueShipName(
  supabase: ReturnType<typeof createServiceRoleClient>,
  baseName: string,
): Promise<string> {
  let candidate = baseName;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const shipAvailable = await isShipNameAvailable(supabase, candidate);
    if (shipAvailable) {
      return candidate;
    }
    candidate = `${baseName} [${randomSuffix(3)}]`;
  }
  throw new ShipPurchaseError("Failed to generate unique ship name", 500);
}

function normalizeTradeInShipId(
  value: string | null,
  currentShipId: string,
): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (validateUuid(trimmed)) {
    return trimmed;
  }
  if (/^[0-9a-f]{6,8}$/i.test(trimmed)) {
    return currentShipId.toLowerCase().startsWith(trimmed.toLowerCase())
      ? currentShipId
      : null;
  }
  throw new ShipPurchaseError(
    "trade_in_ship_id must be a UUID or 6-8 hex prefix",
    400,
  );
}

async function isShipNameAvailable(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipName: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("ship_instances")
    .select("ship_id")
    .eq("ship_name", shipName)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("ship_purchase.ship_name_check", error);
    throw new ShipPurchaseError("Failed to validate ship name", 500);
  }
  return !data;
}

function randomSuffix(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

type InsertShipParams = {
  supabase: ReturnType<typeof createServiceRoleClient>;
  ownerType: "character" | "corporation" | "unowned";
  ownerId: string | null;
  shipType: string;
  shipName: string;
  sectorId: number;
  definition: ShipDefinitionRow;
  credits: number;
  metadata?: Record<string, unknown>;
};

async function insertShip(params: InsertShipParams) {
  const ownerCharacterId =
    params.ownerType === "character" ? params.ownerId : null;
  const ownerCorporationId =
    params.ownerType === "corporation" ? params.ownerId : null;
  const resolvedOwnerId =
    params.ownerType === "unowned" ? null : params.ownerId;
  const { data, error } = await params.supabase
    .from("ship_instances")
    .insert({
      owner_id: resolvedOwnerId,
      owner_type: params.ownerType,
      owner_character_id: ownerCharacterId,
      owner_corporation_id: ownerCorporationId,
      ship_type: params.shipType,
      ship_name: params.shipName,
      current_sector: params.sectorId,
      in_hyperspace: false,
      hyperspace_destination: null,
      hyperspace_eta: null,
      credits: params.credits,
      cargo_qf: 0,
      cargo_ro: 0,
      cargo_ns: 0,
      current_warp_power: params.definition.warp_power_capacity,
      current_shields: params.definition.shields,
      current_fighters: params.definition.fighters,
      became_unowned: null,
      former_owner_name: null,
      metadata: params.metadata ?? {},
    })
    .select("ship_id, current_sector, ship_type")
    .single();
  if (error || !data) {
    console.error("ship_purchase.ship_insert", error);
    throw new ShipPurchaseError("Failed to create new ship", 500);
  }
  return data;
}
