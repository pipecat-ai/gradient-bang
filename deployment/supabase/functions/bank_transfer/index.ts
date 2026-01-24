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
} from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { loadCombatForSector } from "../_shared/combat_state.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
  RequestValidationError,
} from "../_shared/request.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const BANK_SECTOR = 0;

class BankTransferError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BankTransferError";
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
    console.error("bank_transfer.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const direction = requireString(payload, "direction");
  const actorCharacterLabel = optionalString(payload, "actor_character_id");
  const actorCharacterId = actorCharacterLabel
    ? await canonicalizeCharacterId(actorCharacterLabel)
    : null;
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  // Try to get a character_id from the payload for error logging
  const characterIdForErrors =
    optionalString(payload, "character_id") ?? actorCharacterId;

  try {
    if (direction === "deposit") {
      return await handleDeposit(
        supabase,
        payload,
        requestId,
        actorCharacterId,
        adminOverride,
        taskId,
      );
    }
    if (direction === "withdraw") {
      return await handleWithdraw(
        supabase,
        payload,
        requestId,
        actorCharacterId,
        adminOverride,
        taskId,
      );
    }
    throw new BankTransferError(
      "direction must be 'deposit' or 'withdraw'",
      400,
    );
  } catch (err) {
    // Only emit error event if we have a valid character ID
    const shouldEmitError = characterIdForErrors !== null;

    if (err instanceof RequestValidationError) {
      if (shouldEmitError) {
        try {
          await emitErrorEvent(supabase, {
            characterId: characterIdForErrors!,
            method: "bank_transfer",
            requestId,
            detail: err.message,
            status: err.status,
          });
        } catch (emitErr) {
          console.error("[bank_transfer] Failed to emit error event", {
            emitErr,
          });
        }
      }
      return errorResponse(err.message, err.status);
    }
    if (err instanceof ActorAuthorizationError) {
      if (shouldEmitError) {
        try {
          await emitErrorEvent(supabase, {
            characterId: characterIdForErrors!,
            method: "bank_transfer",
            requestId,
            detail: err.message,
            status: err.status,
          });
        } catch (emitErr) {
          console.error("[bank_transfer] Failed to emit error event", {
            emitErr,
          });
        }
      }
      return errorResponse(err.message, err.status);
    }
    if (err instanceof BankTransferError) {
      if (shouldEmitError) {
        try {
          await emitErrorEvent(supabase, {
            characterId: characterIdForErrors!,
            method: "bank_transfer",
            requestId,
            detail: err.message,
            status: err.status,
          });
        } catch (emitErr) {
          console.error("[bank_transfer] Failed to emit error event", {
            emitErr,
          });
        }
      }
      return errorResponse(err.message, err.status);
    }
    console.error("bank_transfer.unhandled", {
      error: err,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      name: err instanceof Error ? err.name : undefined,
    });
    return errorResponse("internal server error", 500);
  }
});

async function handleDeposit(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
  taskId: string | null,
): Promise<Response> {
  console.log("[bank_transfer.deposit] Starting deposit handler", {
    requestId,
    payload,
  });

  const shipIdFromPayload = optionalString(payload, "ship_id");
  const targetPlayerName = requireString(payload, "target_player_name");
  const amount = requirePositiveInt(payload, "amount");
  const sourceCharacterLabel = optionalString(payload, "character_id");
  const sourceCharacterId = sourceCharacterLabel
    ? await canonicalizeCharacterId(sourceCharacterLabel)
    : null;

  console.log("[bank_transfer.deposit] Parsed params", {
    shipIdFromPayload,
    targetPlayerName,
    amount,
    sourceCharacterId,
  });

  // Derive ship_id from character if not provided
  let shipId: string;
  if (shipIdFromPayload) {
    shipId = shipIdFromPayload;
    console.log("[bank_transfer.deposit] Using provided ship_id", { shipId });
  } else if (sourceCharacterId) {
    console.log("[bank_transfer.deposit] Deriving ship_id from character", {
      sourceCharacterId,
    });
    let sourceCharacter;
    try {
      sourceCharacter = await loadCharacter(supabase, sourceCharacterId);
      console.log("[bank_transfer.deposit] Loaded source character", {
        current_ship_id: sourceCharacter.current_ship_id,
      });
    } catch (err) {
      console.error("[bank_transfer.deposit] Failed to load character", {
        sourceCharacterId,
        err,
      });
      throw new BankTransferError("Character not found or has no ship", 404);
    }
    if (!sourceCharacter.current_ship_id) {
      throw new BankTransferError("Character has no ship", 400);
    }
    shipId = sourceCharacter.current_ship_id;
  } else {
    throw new BankTransferError(
      "Either ship_id or character_id must be provided",
      400,
    );
  }

  let ship;
  try {
    console.log("[bank_transfer.deposit] Loading ship", { shipId });
    ship = await loadShip(supabase, shipId);
    console.log("[bank_transfer.deposit] Loaded ship", {
      shipId,
      credits: ship.credits,
      sector: ship.current_sector,
    });
  } catch (err) {
    console.error("[bank_transfer.deposit] Failed to load ship", {
      shipId,
      err,
    });
    throw new BankTransferError("Ship not found", 404);
  }

  try {
    await ensureActorAuthorization({
      supabase,
      ship,
      actorCharacterId,
      adminOverride,
      targetCharacterId:
        sourceCharacterId ??
        ship.owner_character_id ??
        ship.owner_id ??
        ship.ship_id,
    });
    console.log("[bank_transfer.deposit] Authorization passed");
  } catch (err) {
    console.error("[bank_transfer.deposit] Authorization failed", { err });
    throw err;
  }

  // Note: Deposits can happen from any sector (legacy parity)
  // Only withdrawals require sector 0

  const ownerId = ship.owner_character_id ?? ship.owner_id;
  console.log("[bank_transfer.deposit] Resolved owner", { ownerId });

  console.log("[bank_transfer.deposit] Looking up target player", {
    targetPlayerName,
  });
  const target = await findCharacterByName(supabase, targetPlayerName);
  if (!target) {
    console.error("[bank_transfer.deposit] Target player not found", {
      targetPlayerName,
    });
    throw new BankTransferError("Target player not found", 404);
  }
  const targetCharacterId = target.character_id;
  console.log("[bank_transfer.deposit] Found target", {
    targetCharacterId,
    targetName: target.name,
  });

  // For rate limiting: use actor character ID for corp ships, owner ID for personal ships
  const rateLimitCharacterId =
    ship.owner_type === "corporation" && actorCharacterId
      ? actorCharacterId
      : (ship.owner_character_id ?? targetCharacterId);

  try {
    await enforceRateLimit(supabase, rateLimitCharacterId, "bank_transfer");
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new BankTransferError("Too many bank_transfer requests", 429);
    }
    console.error("bank_transfer.rate_limit", err);
    throw new BankTransferError("rate limit error", 500);
  }

  const shipCreditsBefore = ship.credits ?? 0;
  console.log("[bank_transfer.deposit] Checking balance", {
    shipCreditsBefore,
    amount,
    sufficient: shipCreditsBefore >= amount,
    shipCreditsRaw: ship.credits,
    shipObject: {
      ship_id: ship.ship_id,
      credits: ship.credits,
      owner: ship.owner_character_id,
    },
  });
  if (shipCreditsBefore < amount) {
    console.log(
      "[bank_transfer.deposit] THROWING insufficient credits error - this should be 400",
    );
    throw new BankTransferError("Insufficient ship credits for deposit", 400);
  }
  console.log(
    "[bank_transfer.deposit] Balance check passed, proceeding with deposit",
  );

  console.log("[bank_transfer.deposit] Updating ship credits", {
    shipId,
    before: shipCreditsBefore,
    after: shipCreditsBefore - amount,
  });
  const shipUpdate = await supabase
    .from("ship_instances")
    .update({ credits: shipCreditsBefore - amount })
    .eq("ship_id", shipId)
    .select();

  if (shipUpdate.error) {
    throw new BankTransferError(
      `Failed to update ship credits: ${shipUpdate.error.message}`,
      500,
    );
  }
  if (!shipUpdate.data || shipUpdate.data.length === 0) {
    throw new BankTransferError("No ship updated - ship not found", 404);
  }

  const bankBefore = target.credits_in_megabank ?? 0;
  console.log("[bank_transfer.deposit] Updating bank balance", {
    targetCharacterId,
    before: bankBefore,
    after: bankBefore + amount,
  });
  const bankUpdate = await supabase
    .from("characters")
    .update({ credits_in_megabank: bankBefore + amount })
    .eq("character_id", targetCharacterId)
    .select();

  if (bankUpdate.error) {
    throw new BankTransferError(
      `Failed to update bank balance: ${bankUpdate.error.message}`,
      500,
    );
  }
  if (!bankUpdate.data || bankUpdate.data.length === 0) {
    throw new BankTransferError(
      "No character updated - character not found",
      404,
    );
  }

  const source = buildEventSource("bank_transfer", requestId);
  const timestamp = new Date().toISOString();

  console.log("[bank_transfer.deposit] Building target status payload", {
    targetCharacterId,
  });
  let targetStatus;
  try {
    targetStatus = await buildStatusPayload(supabase, targetCharacterId);
    console.log("[bank_transfer.deposit] Built target status payload");
  } catch (err) {
    console.error("[bank_transfer.deposit] Failed to build target status", {
      targetCharacterId,
      err,
    });
    throw err;
  }
  const targetDisplayId = resolveDisplayIdFromStatus(
    targetStatus,
    target.name ?? targetPlayerName,
    targetCharacterId,
  );

  // For corp ships, source_character_id should be null (no character owns the ship)
  const resolvedSourceCharacter =
    ship.owner_type === "corporation"
      ? null
      : (sourceCharacterId ?? ship.owner_character_id ?? targetCharacterId);
  console.log("[bank_transfer.deposit] Resolved source character", {
    resolvedSourceCharacter,
    sourceCharacterId,
    owner: ship.owner_character_id,
    ownerType: ship.owner_type,
  });

  let sourceStatus: Record<string, unknown> | null = null;
  if (
    resolvedSourceCharacter &&
    resolvedSourceCharacter !== targetCharacterId
  ) {
    console.log("[bank_transfer.deposit] Building source status payload", {
      resolvedSourceCharacter,
    });
    try {
      sourceStatus = await buildStatusPayload(
        supabase,
        resolvedSourceCharacter,
      );
      console.log("[bank_transfer.deposit] Built source status payload");
    } catch (err) {
      console.error("[bank_transfer.deposit] Failed to build source status", {
        resolvedSourceCharacter,
        err,
      });
      throw err;
    }
  }
  // For corp ships, sourceDisplayId should be null (no source character)
  const sourceDisplayId = !resolvedSourceCharacter
    ? null
    : resolvedSourceCharacter === targetCharacterId
      ? targetDisplayId
      : resolveDisplayIdFromStatus(
          sourceStatus,
          sourceCharacterLabel,
          resolvedSourceCharacter,
        );
  console.log("[bank_transfer.deposit] Display IDs resolved", {
    targetDisplayId,
    sourceDisplayId,
  });

  console.log("[bank_transfer.deposit] Emitting bank transaction event");
  try {
    await emitBankTransaction(
      supabase,
      targetCharacterId,
      buildDepositPayload({
        source,
        amount,
        shipId, // Use the depositing ship's ID, not the target's ship ID
        shipCreditsBefore,
        shipCreditsAfter: shipCreditsBefore - amount,
        bankBefore,
        bankAfter: bankBefore + amount,
        timestamp,
        targetCharacterId: targetDisplayId,
        sourceCharacterId: sourceDisplayId,
      }),
      {
        requestId,
        sectorId: BANK_SECTOR,
        shipId,
        actorCharacterId,
        corpId: target.corporation_id,
        taskId,
      },
    );
    console.log("[bank_transfer.deposit] Emitted bank transaction event");
  } catch (err) {
    console.error("[bank_transfer.deposit] Failed to emit bank transaction", {
      err,
    });
    throw err;
  }

  await emitCharacterEvent({
    supabase,
    characterId: targetCharacterId,
    eventType: "status.update",
    payload: targetStatus,
    requestId,
    sectorId: BANK_SECTOR,
    shipId,
    actorCharacterId,
    corpId: target.corporation_id,
    taskId,
  });

  if (
    resolvedSourceCharacter &&
    resolvedSourceCharacter !== targetCharacterId
  ) {
    console.log("[bank_transfer.deposit] Emitting source status update", {
      resolvedSourceCharacter,
    });
    const ownerStatus =
      sourceStatus ??
      (await buildStatusPayload(supabase, resolvedSourceCharacter));
    const sourceChar = await loadCharacter(supabase, resolvedSourceCharacter);
    await emitCharacterEvent({
      supabase,
      characterId: resolvedSourceCharacter,
      eventType: "status.update",
      payload: ownerStatus,
      requestId,
      sectorId: BANK_SECTOR,
      shipId,
      actorCharacterId,
      corpId: sourceChar.corporation_id,
      taskId,
    });
  }

  console.log("[bank_transfer.deposit] Deposit completed successfully", {
    requestId,
  });
  return successResponse({
    request_id: requestId,
    ship_id: shipId,
    target_character_id: targetCharacterId,
    source_character_id: resolvedSourceCharacter,
    ship_credits_after: shipCreditsBefore - amount,
    credits_in_bank_after: bankBefore + amount,
  });
}

async function handleWithdraw(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
  taskId: string | null,
): Promise<Response> {
  const characterLabel = requireString(payload, "character_id");
  const characterId = await canonicalizeCharacterId(characterLabel);
  const amount = requirePositiveInt(payload, "amount");

  try {
    await enforceRateLimit(supabase, characterId, "bank_transfer");
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new BankTransferError("Too many bank_transfer requests", 429);
    }
    console.error("bank_transfer.rate_limit", err);
    throw new BankTransferError("rate limit error", 500);
  }

  let character;
  try {
    character = await loadCharacter(supabase, characterId);
  } catch (err) {
    throw new BankTransferError("Character not found", 404);
  }

  let ship;
  try {
    ship = await loadShip(supabase, character.current_ship_id);
  } catch (err) {
    throw new BankTransferError("Ship not found", 404);
  }

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });
  if (ship.current_sector !== BANK_SECTOR || ship.in_hyperspace) {
    throw new BankTransferError(
      "Withdrawals require the pilot to be at the Megaport (sector 0)",
      400,
    );
  }

  // Check if character is in combat
  const combat = await loadCombatForSector(supabase, ship.current_sector);
  if (combat && !combat.ended && combat.participants[characterId]) {
    throw new BankTransferError(
      "Cannot withdraw from bank while in combat",
      409,
    );
  }

  const bankBalance = character.credits_in_megabank ?? 0;
  if (bankBalance < amount) {
    throw new BankTransferError("Insufficient bank balance", 400);
  }

  await supabase
    .from("characters")
    .update({ credits_in_megabank: bankBalance - amount })
    .eq("character_id", characterId);

  await supabase
    .from("ship_instances")
    .update({ credits: (ship.credits ?? 0) + amount })
    .eq("ship_id", ship.ship_id);

  const statusPayload = await buildStatusPayload(supabase, characterId);
  const timestamp = new Date().toISOString();
  const source = buildEventSource("bank_transfer", requestId);
  await emitBankTransaction(
    supabase,
    characterId,
    buildWithdrawPayload({
      source,
      amount,
      shipCreditsBefore: ship.credits ?? 0,
      shipCreditsAfter: (ship.credits ?? 0) + amount,
      bankBefore: bankBalance,
      bankAfter: bankBalance - amount,
      timestamp,
      characterId: resolveDisplayIdFromStatus(
        statusPayload,
        characterLabel,
        characterId,
      ),
    }),
    {
      requestId,
      sectorId: BANK_SECTOR,
      shipId: ship.ship_id,
      actorCharacterId,
      corpId: character.corporation_id,
      taskId,
    },
  );

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "status.update",
    payload: statusPayload,
    requestId,
    sectorId: BANK_SECTOR,
    shipId: ship.ship_id,
    actorCharacterId,
    corpId: character.corporation_id,
    taskId,
  });

  return successResponse({ request_id: requestId });
}

async function emitBankTransaction(
  supabase: SupabaseClient,
  characterId: string,
  payload: Record<string, unknown>,
  options: {
    requestId?: string | null;
    sectorId?: number | null;
    shipId?: string | null;
    actorCharacterId?: string | null;
    corpId?: string | null;
    taskId?: string | null;
  } = {},
): Promise<void> {
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "bank.transaction",
    payload,
    requestId: options.requestId,
    sectorId: options.sectorId,
    taskId: options.taskId,
    shipId: options.shipId ?? undefined,
    actorCharacterId: options.actorCharacterId ?? null,
    corpId: options.corpId ?? null,
  });
}

function requirePositiveInt(
  payload: Record<string, unknown>,
  key: string,
): number {
  const value = optionalNumber(payload, key);
  if (value === null || !Number.isInteger(value) || value <= 0) {
    throw new BankTransferError(`${key} must be a positive integer`, 400);
  }
  return Math.floor(value);
}

async function findCharacterByName(
  supabase: SupabaseClient,
  name: string,
): Promise<{
  character_id: string;
  credits_in_megabank: number | null;
  name: string | null;
  corporation_id: string | null;
} | null> {
  const pattern = name.replace(/[%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await supabase
    .from("characters")
    .select("character_id, credits_in_megabank, name, corporation_id")
    .ilike("name", pattern)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("bank_transfer.lookup", error);
    throw new BankTransferError("Failed to lookup target player", 500);
  }
  return data ?? null;
}

function resolveDisplayIdFromStatus(
  statusPayload: Record<string, unknown> | null,
  fallbackName: string | null,
  fallbackId: string,
): string {
  if (statusPayload && typeof statusPayload === "object") {
    const player = (statusPayload["player"] ?? {}) as Record<string, unknown>;
    const name =
      typeof player["name"] === "string" ? (player["name"] as string) : null;
    if (name && name.trim()) {
      return name;
    }
    const playerId =
      typeof player["id"] === "string" ? (player["id"] as string) : null;
    if (playerId && playerId.trim()) {
      return playerId;
    }
  }
  if (fallbackName && fallbackName.trim()) {
    return fallbackName;
  }
  return fallbackId;
}

function buildDepositPayload(params: {
  source: Record<string, unknown>;
  amount: number;
  shipId: string;
  shipCreditsBefore: number;
  shipCreditsAfter: number;
  bankBefore: number;
  bankAfter: number;
  timestamp: string;
  targetCharacterId: string;
  sourceCharacterId: string | null;
}): Record<string, unknown> {
  return {
    source: params.source,
    target_character_id: params.targetCharacterId,
    source_character_id: params.sourceCharacterId,
    ship_id: params.shipId,
    direction: "deposit",
    amount: params.amount,
    timestamp: params.timestamp,
    ship_credits_before: params.shipCreditsBefore,
    ship_credits_after: params.shipCreditsAfter,
    credits_in_bank_before: params.bankBefore,
    credits_in_bank_after: params.bankAfter,
  };
}

function buildWithdrawPayload(params: {
  source: Record<string, unknown>;
  amount: number;
  shipCreditsBefore: number;
  shipCreditsAfter: number;
  bankBefore: number;
  bankAfter: number;
  timestamp: string;
  characterId: string;
}): Record<string, unknown> {
  return {
    source: params.source,
    character_id: params.characterId,
    sector: { id: BANK_SECTOR },
    direction: "withdraw",
    amount: params.amount,
    timestamp: params.timestamp,
    ship_credits_before: params.shipCreditsBefore,
    ship_credits_after: params.shipCreditsAfter,
    credits_in_bank_before: params.bankBefore,
    credits_in_bank_after: params.bankAfter,
  };
}

function resolveLegacyShipId(
  statusPayload: Record<string, unknown>,
  fallback: string,
  characterLabel: string,
): string {
  if (statusPayload && typeof statusPayload === "object") {
    const ship = statusPayload["ship"];
    if (ship && typeof ship === "object") {
      const statusShipId = (ship as Record<string, unknown>)["ship_id"];
      if (typeof statusShipId === "string" && statusShipId.trim()) {
        if (!looksLikeUuid(characterLabel) && looksLikeUuid(statusShipId)) {
          return `${characterLabel}-ship`;
        }
        return statusShipId;
      }
    }
  }
  if (
    characterLabel &&
    !looksLikeUuid(characterLabel) &&
    looksLikeUuid(fallback)
  ) {
    return `${characterLabel}-ship`;
  }
  return fallback;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value,
  );
}
