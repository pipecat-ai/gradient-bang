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
  buildPublicPlayerSnapshotFromStatus,
} from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import {
  resolveShipByNameWithSuffixFallback,
  type ShipNameLookupError,
} from "../_shared/ship_names.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

class TransferWarpPowerError extends Error {
  status: number;
  extra?: Record<string, unknown>;

  constructor(message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.name = "TransferWarpPowerError";
    this.status = status;
    this.extra = extra;
  }
}

type TransferTargetQuery = {
  toPlayerName: string | null;
  toShipId: string | null;
  toShipIdPrefix: string | null;
  toShipName: string | null;
};

type TransferTarget = {
  character: {
    character_id: string;
    name: string;
    first_visit: string;
    player_metadata: Record<string, unknown> | null;
    current_ship_id: string;
  };
  ship: {
    ship_id: string;
    ship_type: string;
    ship_name: string | null;
    current_sector: number | null;
    in_hyperspace: boolean;
    current_warp_power: number | null;
  };
};

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
    console.error("transfer_warp_power.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const fromCharacterLabel = requireString(payload, "from_character_id");
  const fromCharacterId = await canonicalizeCharacterId(fromCharacterLabel);
  const toPlayerName = optionalString(payload, "to_player_name");
  const toShipIdLabel = optionalString(payload, "to_ship_id");
  const toShipName = optionalString(payload, "to_ship_name");
  let toShipId: string | null = null;
  let toShipIdPrefix: string | null = null;
  try {
    ({ shipId: toShipId, shipIdPrefix: toShipIdPrefix } =
      parseShipIdInput(toShipIdLabel));
  } catch (err) {
    if (err instanceof TransferWarpPowerError) {
      return errorResponse(err.message, err.status, err.extra);
    }
    console.error("transfer_warp_power.ship_id_parse", err);
    return errorResponse("invalid ship id", 400);
  }
  const actorCharacterLabel = optionalString(payload, "actor_character_id");
  const actorCharacterId = actorCharacterLabel
    ? await canonicalizeCharacterId(actorCharacterLabel)
    : null;
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  try {
    await enforceRateLimit(supabase, fromCharacterId, "transfer_warp_power");
  } catch (err) {
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: "transfer_warp_power",
        requestId,
        detail: "Too many transfer_warp_power requests",
        status: 429,
      });
      return errorResponse("Too many transfer_warp_power requests", 429);
    }
    console.error("transfer_warp_power.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    return await handleTransfer(
      supabase,
      payload,
      fromCharacterId,
      { toPlayerName, toShipId, toShipIdPrefix, toShipName },
      requestId,
      actorCharacterId,
      adminOverride,
      taskId,
    );
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: "transfer_warp_power",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof TransferWarpPowerError) {
      await emitErrorEvent(supabase, {
        characterId: fromCharacterId,
        method: "transfer_warp_power",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status, err.extra);
    }
    console.error("transfer_warp_power.unhandled", err);
    await emitErrorEvent(supabase, {
      characterId: fromCharacterId,
      method: "transfer_warp_power",
      requestId,
      detail: "internal server error",
      status: 500,
    });
    return errorResponse("internal server error", 500);
  }
});

async function handleTransfer(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  fromCharacterId: string,
  target: TransferTargetQuery,
  requestId: string,
  actorCharacterId: string | null,
  adminOverride: boolean,
  taskId: string | null,
): Promise<Response> {
  const source = buildEventSource("transfer_warp_power", requestId);

  const unitsRaw = optionalNumber(payload, "units");
  if (unitsRaw === null || !Number.isInteger(unitsRaw) || unitsRaw <= 0) {
    throw new TransferWarpPowerError("units must be a positive integer", 400);
  }
  const unitsRequested = Math.floor(unitsRaw);

  const fromCharacter = await loadCharacter(supabase, fromCharacterId);
  const fromShip = await loadShip(supabase, fromCharacter.current_ship_id);
  await ensureActorAuthorization({
    supabase,
    ship: fromShip,
    actorCharacterId,
    adminOverride,
    targetCharacterId: fromCharacterId,
  });
  if (fromShip.in_hyperspace) {
    throw new TransferWarpPowerError(
      "Sender is in hyperspace, cannot transfer warp power",
      400,
    );
  }

  const { toPlayerName, toShipId, toShipIdPrefix, toShipName } = target;
  if (!toPlayerName && !toShipId && !toShipIdPrefix && !toShipName) {
    throw new TransferWarpPowerError(
      "Must provide to_player_name, to_ship_id, or to_ship_name",
      400,
    );
  }

  const toCharacterRecord = await resolveTransferTarget(
    supabase,
    { toPlayerName, toShipId, toShipIdPrefix, toShipName },
    fromShip.current_sector ?? null,
    fromCharacterId,
  );
  if (!toCharacterRecord) {
    throw new TransferWarpPowerError("Target not found in this sector", 404);
  }

  const { character: toCharacter, ship: toShip } = toCharacterRecord;
  if (toShip.in_hyperspace) {
    throw new TransferWarpPowerError(
      "Receiver is in hyperspace, cannot transfer warp power",
      400,
    );
  }

  if ((toShip.current_sector ?? null) !== (fromShip.current_sector ?? null)) {
    throw new TransferWarpPowerError(
      "Characters must be in the same sector",
      400,
    );
  }

  const senderWarp = fromShip.current_warp_power ?? 0;
  if (senderWarp < unitsRequested) {
    throw new TransferWarpPowerError(
      `Insufficient warp power. ${fromCharacterId} only has ${senderWarp} units`,
      400,
    );
  }

  if (toCharacter.character_id === fromCharacterId) {
    throw new TransferWarpPowerError(
      "Cannot transfer warp power to yourself",
      400,
    );
  }

  const toDefinition = await loadShipDefinition(supabase, toShip.ship_type);
  const receiverCapacity =
    toDefinition.warp_power_capacity - (toShip.current_warp_power ?? 0);
  const unitsToTransfer = Math.min(unitsRequested, receiverCapacity);
  if (unitsToTransfer <= 0) {
    throw new TransferWarpPowerError(
      `${toCharacter.character_id}'s warp power is already at maximum`,
      400,
    );
  }

  await updateWarpPower(
    supabase,
    fromShip.ship_id,
    senderWarp - unitsToTransfer,
  );
  await updateWarpPower(
    supabase,
    toShip.ship_id,
    (toShip.current_warp_power ?? 0) + unitsToTransfer,
  );

  const timestamp = new Date().toISOString();
  await supabase
    .from("characters")
    .update({ last_active: timestamp })
    .eq("character_id", fromCharacterId);
  await supabase
    .from("characters")
    .update({ last_active: timestamp })
    .eq("character_id", toCharacter.character_id);

  const fromStatus = await buildStatusPayload(supabase, fromCharacterId);
  const toStatus = await buildStatusPayload(supabase, toCharacter.character_id);

  const fromPlayer = buildPublicPlayerSnapshotFromStatus(fromStatus);
  const toPlayer = buildPublicPlayerSnapshotFromStatus(toStatus);

  const transferDetails = { warp_power: unitsToTransfer };
  const sectorId = fromShip.current_sector ?? toShip.current_sector ?? 0;
  const sectorPayload = { id: sectorId };

  await emitCharacterEvent({
    supabase,
    characterId: fromCharacterId,
    eventType: "warp.transfer",
    payload: {
      transfer_direction: "sent",
      transfer_details: transferDetails,
      from: fromPlayer,
      to: toPlayer,
      sector: sectorPayload,
      timestamp,
      source,
    },
    requestId,
    taskId,
    sectorId,
    shipId: fromShip.ship_id,
    actorCharacterId,
    corpId: fromCharacter.corporation_id,
  });

  await emitCharacterEvent({
    supabase,
    characterId: toCharacter.character_id,
    eventType: "warp.transfer",
    payload: {
      transfer_direction: "received",
      transfer_details: transferDetails,
      from: fromPlayer,
      to: toPlayer,
      sector: sectorPayload,
      timestamp,
      source,
    },
    requestId,
    taskId,
    sectorId,
    shipId: toShip.ship_id,
    actorCharacterId,
    corpId: toCharacter.corporation_id,
  });

  await emitCharacterEvent({
    supabase,
    characterId: fromCharacterId,
    eventType: "status.update",
    payload: fromStatus,
    requestId,
    taskId,
    sectorId,
    shipId: fromShip.ship_id,
    actorCharacterId,
    corpId: fromCharacter.corporation_id,
  });
  await emitCharacterEvent({
    supabase,
    characterId: toCharacter.character_id,
    eventType: "status.update",
    payload: toStatus,
    requestId,
    taskId,
    sectorId,
    shipId: toShip.ship_id,
    actorCharacterId,
    corpId: toCharacter.corporation_id,
  });

  return successResponse({ request_id: requestId });
}

async function updateWarpPower(
  supabase: SupabaseClient,
  shipId: string,
  warpPower: number,
): Promise<void> {
  const { error } = await supabase
    .from("ship_instances")
    .update({ current_warp_power: warpPower })
    .eq("ship_id", shipId);
  if (error) {
    console.error("transfer_warp_power.update_ship", error);
    throw new TransferWarpPowerError("Failed to update ship state", 500);
  }
}

async function findCharacterByNameInSector(
  supabase: SupabaseClient,
  name: string,
  sectorId: number | null,
  excludeCharacterId: string,
): Promise<TransferTarget | null> {
  if (sectorId === null) {
    return null;
  }

  const pattern = name.replace(/[%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await supabase
    .from("characters")
    .select("character_id, name, first_visit, player_metadata, current_ship_id")
    .ilike("name", `${pattern}%`)
    .neq("character_id", excludeCharacterId)
    .limit(5);

  if (error) {
    console.error("transfer_warp_power.lookup", error);
    throw new TransferWarpPowerError("Failed to lookup target player", 500);
  }
  if (!data) {
    return null;
  }

  for (const candidate of data) {
    if (!candidate.current_ship_id) {
      continue;
    }
    let ship;
    try {
      ship = await loadShip(supabase, candidate.current_ship_id);
    } catch (err) {
      console.error("transfer_warp_power.lookup_ship", err);
      continue;
    }
    if ((ship.current_sector ?? null) !== sectorId) {
      continue;
    }
    if (ship.in_hyperspace) {
      continue;
    }
    return {
      character: {
        character_id: candidate.character_id,
        name: candidate.name,
        first_visit: candidate.first_visit,
        player_metadata: candidate.player_metadata,
        current_ship_id: candidate.current_ship_id,
      },
      ship: {
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        ship_name: ship.ship_name,
        current_sector: ship.current_sector,
        in_hyperspace: ship.in_hyperspace,
        current_warp_power: ship.current_warp_power,
      },
    };
  }

  return null;
}

async function resolveTransferTarget(
  supabase: SupabaseClient,
  target: TransferTargetQuery,
  sectorId: number | null,
  excludeCharacterId: string,
): Promise<TransferTarget | null> {
  if (target.toShipId) {
    return await resolveCharacterByShipId(supabase, target.toShipId);
  }
  if (target.toShipIdPrefix) {
    const resolvedId = await resolveShipIdByPrefixInSector(
      supabase,
      target.toShipIdPrefix,
      sectorId,
    );
    if (!resolvedId) {
      return null;
    }
    return await resolveCharacterByShipId(supabase, resolvedId);
  }
  if (target.toShipName) {
    return await resolveCharacterByShipName(supabase, target.toShipName);
  }
  if (target.toPlayerName) {
    return await findCharacterByNameInSector(
      supabase,
      target.toPlayerName,
      sectorId,
      excludeCharacterId,
    );
  }
  return null;
}

async function resolveCharacterByShipId(
  supabase: SupabaseClient,
  shipId: string,
): Promise<TransferTarget | null> {
  let ship;
  try {
    ship = await loadShip(supabase, shipId);
  } catch (err) {
    console.error("transfer_warp_power.lookup_ship_id", err);
    return null;
  }

  const { data, error } = await supabase
    .from("characters")
    .select("character_id, name, first_visit, player_metadata, current_ship_id")
    .eq("current_ship_id", ship.ship_id)
    .maybeSingle();

  if (error) {
    console.error("transfer_warp_power.lookup_ship_character", error);
    throw new TransferWarpPowerError("Failed to lookup target ship", 500);
  }
  if (!data || !data.current_ship_id) {
    return null;
  }

  return {
    character: {
      character_id: data.character_id,
      name: data.name,
      first_visit: data.first_visit,
      player_metadata: data.player_metadata,
      current_ship_id: data.current_ship_id,
    },
    ship: {
      ship_id: ship.ship_id,
      ship_type: ship.ship_type,
      ship_name: ship.ship_name,
      current_sector: ship.current_sector,
      in_hyperspace: ship.in_hyperspace,
      current_warp_power: ship.current_warp_power,
    },
  };
}

async function resolveCharacterByShipName(
  supabase: SupabaseClient,
  shipName: string,
): Promise<TransferTarget | null> {
  let lookup;
  try {
    lookup = await resolveShipByNameWithSuffixFallback(supabase, shipName);
  } catch (err) {
    const stage = (err as ShipNameLookupError | null)?.stage;
    const cause =
      err instanceof Error && "cause" in err
        ? (err as Error & { cause?: unknown }).cause
        : err;
    if (stage === "suffix") {
      console.error("transfer_warp_power.lookup_ship_name_suffix", cause);
    } else {
      console.error("transfer_warp_power.lookup_ship_name", cause);
    }
    throw new TransferWarpPowerError("Failed to lookup target ship", 500);
  }

  if (lookup.status === "none") {
    return null;
  }

  if (lookup.status === "ambiguous") {
    throw new TransferWarpPowerError(
      "Ship name is ambiguous; use full ship name",
      409,
      {
        base_name: lookup.base_name,
        candidates: lookup.candidates,
        total_matches: lookup.total_matches,
      },
    );
  }

  return await resolveCharacterByShipId(supabase, lookup.ship.ship_id);
}

async function resolveShipIdByPrefixInSector(
  supabase: SupabaseClient,
  prefix: string,
  sectorId: number | null,
): Promise<string | null> {
  if (sectorId === null) {
    return null;
  }
  const { data, error } = await supabase
    .from("ship_instances")
    .select("ship_id")
    .eq("current_sector", sectorId);

  if (error) {
    console.error("transfer_warp_power.lookup_ship_prefix", error);
    throw new TransferWarpPowerError("Failed to lookup target ship", 500);
  }

  const matches = (data ?? [])
    .map((row) => row.ship_id)
    .filter((shipId): shipId is string => typeof shipId === "string")
    .filter((shipId) => shipId.toLowerCase().startsWith(prefix));

  if (matches.length > 1) {
    throw new TransferWarpPowerError(
      "Ship id prefix is ambiguous; use ship name or full ship_id",
      409,
    );
  }

  return matches.length === 1 ? matches[0] : null;
}

function parseShipIdInput(value: string | null): {
  shipId: string | null;
  shipIdPrefix: string | null;
} {
  if (!value) {
    return { shipId: null, shipIdPrefix: null };
  }
  const trimmed = value.trim();
  if (validateUuid(trimmed)) {
    return { shipId: trimmed, shipIdPrefix: null };
  }
  if (/^[0-9a-f]{6,8}$/i.test(trimmed)) {
    return { shipId: null, shipIdPrefix: trimmed.toLowerCase() };
  }
  throw new TransferWarpPowerError(
    "to_ship_id must be a UUID or 6-8 hex prefix",
    400,
  );
}
