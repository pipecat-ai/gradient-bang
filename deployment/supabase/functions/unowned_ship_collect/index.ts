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
  emitSectorEnvelope,
} from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import {
  loadCharacter,
  loadShip,
  loadShipDefinition,
} from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import { pgBuildStatusPayload } from "../_shared/pg_queries.ts";
import { buildSectorSnapshot } from "../_shared/map.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(traced("unowned_ship_collect", async (req, trace) => {
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
    console.error("unowned_ship_collect.parse", err);
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
  const targetShipId = requireString(payload, "ship_id");
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  trace.setInput({
    characterId,
    targetShipId,
    actorCharacterId,
    adminOverride,
    taskId,
    requestId,
  });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "unowned_ship_collect");
  } catch (err) {
    sRateLimit.end();
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "unowned_ship_collect",
        requestId,
        detail: "Too many requests",
        status: 429,
      });
      return errorResponse("Too many requests", 429);
    }
    console.error("unowned_ship_collect.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }
  sRateLimit.end();

  const sHandle = trace.span("handle_unowned_ship_collect");
  try {
    const result = await handleUnownedShipCollect({
      supabase,
      requestId,
      characterId,
      targetShipId,
      actorCharacterId,
      adminOverride,
      taskId,
    });
    sHandle.end();
    trace.setOutput({ request_id: requestId, characterId, targetShipId });
    return result;
  } catch (err) {
    sHandle.end();
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "unowned_ship_collect",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("unowned_ship_collect.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    const detail =
      err instanceof Error ? err.message : "unowned ship collect failed";
    await emitErrorEvent(supabase, {
      characterId,
      method: "unowned_ship_collect",
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  }
}));

async function handleUnownedShipCollect(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  targetShipId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
  taskId: string | null;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    targetShipId,
    actorCharacterId,
    adminOverride,
    taskId,
  } = params;

  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  if (ship.ship_type === "escape_pod") {
    const err = new Error("Escape pods cannot collect unowned ships") as Error & {
      status?: number;
    };
    err.status = 400;
    throw err;
  }

  if (ship.in_hyperspace) {
    const err = new Error(
      "Cannot collect unowned ships while in hyperspace",
    ) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  if (ship.current_sector === null) {
    const err = new Error("Ship sector is unavailable") as Error & {
      status?: number;
    };
    err.status = 500;
    throw err;
  }

  if (targetShipId === ship.ship_id) {
    const err = new Error("Cannot collect your own ship") as Error & {
      status?: number;
    };
    err.status = 400;
    throw err;
  }

  const sectorId = ship.current_sector;

  let targetShip;
  try {
    targetShip = await loadShip(supabase, targetShipId);
  } catch (loadErr) {
    if (loadErr instanceof Error && loadErr.message.includes("not found")) {
      const err = new Error("Unowned ship not found") as Error & {
        status?: number;
      };
      err.status = 404;
      throw err;
    }
    throw loadErr;
  }

  if (targetShip.current_sector !== sectorId) {
    const err = new Error("Unowned ship not in this sector") as Error & {
      status?: number;
    };
    err.status = 404;
    throw err;
  }

  if (targetShip.in_hyperspace) {
    const err = new Error("Unowned ship is in hyperspace") as Error & {
      status?: number;
    };
    err.status = 409;
    throw err;
  }

  // Mirror buildSectorSnapshot's occupancy rule: a ship is "unowned" iff
  // no character has current_ship_id == ship_id.
  const { data: occupant, error: occupantError } = await supabase
    .from("characters")
    .select("character_id")
    .eq("current_ship_id", targetShipId)
    .maybeSingle();

  if (occupantError) {
    console.error("unowned_ship_collect.occupant_lookup", occupantError);
    const err = new Error("Failed to verify ship occupancy") as Error & {
      status?: number;
    };
    err.status = 500;
    throw err;
  }

  if (occupant) {
    const err = new Error("Ship is currently occupied") as Error & {
      status?: number;
    };
    err.status = 409;
    throw err;
  }

  const shipDefinition = await loadShipDefinition(supabase, ship.ship_type);
  const currentCargo = {
    qf: ship.cargo_qf ?? 0,
    ro: ship.cargo_ro ?? 0,
    ns: ship.cargo_ns ?? 0,
  };
  const cargoUsed = currentCargo.qf + currentCargo.ro + currentCargo.ns;
  let availableSpace = shipDefinition.cargo_holds - cargoUsed;

  const targetCargo = {
    qf: targetShip.cargo_qf ?? 0,
    ro: targetShip.cargo_ro ?? 0,
    ns: targetShip.cargo_ns ?? 0,
  };
  const targetCredits = targetShip.credits ?? 0;

  const collectedCargo: Record<string, number> = {};
  const remainingCargo: Record<string, number> = {};
  const collectedCredits = targetCredits > 0 ? targetCredits : 0;

  // Iterate alphabetically (ns→qf→ro by storage suffix happens to match
  // alphabetical commodity-name order) so collection is deterministic
  // when partial.
  const COMMODITIES: Array<{
    name: "neuro_symbolics" | "quantum_foam" | "retro_organics";
    key: "ns" | "qf" | "ro";
  }> = [
    { name: "neuro_symbolics", key: "ns" },
    { name: "quantum_foam", key: "qf" },
    { name: "retro_organics", key: "ro" },
  ];

  for (const { name, key } of COMMODITIES) {
    const amount = targetCargo[key];
    if (amount <= 0) continue;
    if (availableSpace <= 0) {
      remainingCargo[name] = amount;
      continue;
    }
    const collectible = Math.min(amount, availableSpace);
    currentCargo[key] += collectible;
    collectedCargo[name] = collectible;
    availableSpace -= collectible;
    if (amount > collectible) {
      remainingCargo[name] = amount - collectible;
    }
  }

  const timestamp = new Date().toISOString();

  // Coalesce all player-ship mutations into a single UPDATE.
  const playerUpdate: Record<string, unknown> = {
    updated_at: timestamp,
  };
  if (collectedCredits > 0) {
    playerUpdate.credits = (ship.credits ?? 0) + collectedCredits;
  }
  if (collectedCargo.quantum_foam) playerUpdate.cargo_qf = currentCargo.qf;
  if (collectedCargo.retro_organics) playerUpdate.cargo_ro = currentCargo.ro;
  if (collectedCargo.neuro_symbolics) playerUpdate.cargo_ns = currentCargo.ns;

  if (Object.keys(playerUpdate).length > 1) {
    const { error: playerError } = await supabase
      .from("ship_instances")
      .update(playerUpdate)
      .eq("ship_id", ship.ship_id);
    if (playerError) {
      console.error("unowned_ship_collect.player_update", playerError);
      const err = new Error("Failed to update collector ship") as Error & {
        status?: number;
      };
      err.status = 500;
      throw err;
    }
  }

  const remainingTargetCargo = {
    qf: remainingCargo.quantum_foam ?? 0,
    ro: remainingCargo.retro_organics ?? 0,
    ns: remainingCargo.neuro_symbolics ?? 0,
  };
  const fullyCollected =
    remainingTargetCargo.qf === 0 &&
    remainingTargetCargo.ro === 0 &&
    remainingTargetCargo.ns === 0;

  const targetUpdate: Record<string, unknown> = {
    cargo_qf: remainingTargetCargo.qf,
    cargo_ro: remainingTargetCargo.ro,
    cargo_ns: remainingTargetCargo.ns,
    credits: 0,
    updated_at: timestamp,
  };
  // Soft-delete the ship once fully drained so it leaves sector listings.
  if (fullyCollected) {
    targetUpdate.destroyed_at = timestamp;
  }

  const { error: targetError } = await supabase
    .from("ship_instances")
    .update(targetUpdate)
    .eq("ship_id", targetShipId);

  if (targetError) {
    console.error("unowned_ship_collect.target_update", targetError);
    const err = new Error("Failed to update target ship") as Error & {
      status?: number;
    };
    err.status = 500;
    throw err;
  }

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "unowned_ship.collected",
    payload: {
      action: "collected",
      target_ship: {
        ship_id: targetShipId,
        ship_type: targetShip.ship_type,
        ship_name: targetShip.ship_name,
        former_owner_name: targetShip.former_owner_name,
      },
      collected: {
        cargo: collectedCargo,
        credits: collectedCredits,
      },
      remaining: {
        cargo: remainingCargo,
      },
      fully_collected: fullyCollected,
      sector: { id: sectorId },
      timestamp,
      source: buildEventSource("unowned_ship.collect", requestId),
    },
    sectorId,
    requestId,
    taskId,
    shipId: ship.ship_id,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  // Status snapshot and sector snapshot are independent reads; build in parallel.
  const pgClient = await acquirePgClient();
  let statusPayload: Record<string, unknown>;
  let sectorSnapshot: Awaited<ReturnType<typeof buildSectorSnapshot>>;
  try {
    [statusPayload, sectorSnapshot] = await Promise.all([
      pgBuildStatusPayload(pgClient, characterId, {
        character,
        shipDefinition,
        actorCharacterId,
      }),
      buildSectorSnapshot(supabase, sectorId),
    ]);
  } finally {
    pgClient.release();
  }
  statusPayload.source = buildEventSource("unowned_ship.collect", requestId);
  sectorSnapshot.source = buildEventSource("unowned_ship.collect", requestId);

  await Promise.all([
    emitCharacterEvent({
      supabase,
      characterId,
      eventType: "status.update",
      payload: statusPayload,
      sectorId,
      requestId,
      taskId,
      shipId: ship.ship_id,
      actorCharacterId: characterId,
      corpId: character.corporation_id,
    }),
    emitSectorEnvelope({
      supabase,
      sectorId,
      eventType: "sector.update",
      payload: sectorSnapshot,
      requestId,
      actorCharacterId: characterId,
    }),
  ]);

  return successResponse({
    success: true,
    collected: {
      credits: collectedCredits,
      cargo: collectedCargo,
    },
    remaining: {
      cargo: remainingCargo,
    },
    fully_collected: fullyCollected,
  });
}
