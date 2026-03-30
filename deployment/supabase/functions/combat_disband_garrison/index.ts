import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import type { QueryClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  emitSectorEnvelope,
  buildEventSource,
} from "../_shared/events.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { buildSectorSnapshot, buildSectorGarrisonMapUpdate } from "../_shared/map.ts";
import {
  pgLoadCharacter,
  pgLoadShip,
  pgEnforceRateLimit,
  pgEnsureActorAuthorization,
  pgComputeCorpMemberRecipients,
  RateLimitError,
  ActorAuthorizationError,
} from "../_shared/pg_queries.ts";
import { loadUniverseMeta, isFedspaceSector } from "../_shared/fedspace.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(traced("combat_disband_garrison", async (req, trace) => {
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
    console.error("combat_disband_garrison.parse", err);
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
  let actorCharacterId: string | null;
  let adminOverride: boolean;
  let taskId: string | null;
  try {
    requestId = resolveRequestId(payload);
    characterId = requireString(payload, "character_id");
    sector = optionalNumber(payload, "sector");
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

  trace.setInput({ requestId, characterId, sector, actorCharacterId, adminOverride, taskId });

  const pg = await acquirePgClient();
  try {
    const sRateLimit = trace.span("rate_limit");
    try {
      await pgEnforceRateLimit(pg, characterId, "combat_disband_garrison");
      sRateLimit.end();
    } catch (err) {
      sRateLimit.end({ error: String(err) });
      if (err instanceof RateLimitError) {
        await emitErrorEvent(supabase, {
          characterId,
          method: "combat_disband_garrison",
          requestId,
          detail: "Too many requests",
          status: 429,
        });
        return errorResponse("Too many requests", 429);
      }
      console.error("combat_disband_garrison.rate_limit", err);
      return errorResponse("rate limit error", 500);
    }

    const sHandle = trace.span("handle_disband_garrison", { character_id: characterId, sector });
    const result = await handleCombatDisbandGarrison({
      pg,
      supabase,
      requestId,
      characterId,
      sector,
      actorCharacterId,
      adminOverride,
      taskId,
    });
    sHandle.end();
    trace.setOutput({ request_id: requestId, characterId, sector });
    return result;
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_disband_garrison",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("combat_disband_garrison.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    const detail =
      err instanceof Error ? err.message : "disband garrison failed";
    await emitErrorEvent(supabase, {
      characterId,
      method: "combat_disband_garrison",
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  } finally {
    pg.release();
  }
}));

function buildStatusError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

async function handleCombatDisbandGarrison(params: {
  pg: QueryClient;
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  sector: number;
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
    actorCharacterId,
    adminOverride,
    taskId,
  } = params;

  // Load character and ship, validate actor controls the ship.
  const character = await pgLoadCharacter(pg, characterId);
  const ship = await pgLoadShip(pg, character.current_ship_id);
  await pgEnsureActorAuthorization(pg, {
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  // Fedspace check
  const universeMeta = await loadUniverseMeta(supabase);
  if (await isFedspaceSector(supabase, sector, universeMeta)) {
    throw buildStatusError("Garrisons cannot be disbanded in Federation Space", 400);
  }

  // Find garrison in this sector.
  const garrisonResult = await pg.queryObject<{
    owner_id: string;
    fighters: number;
    mode: string;
    toll_amount: number;
    toll_balance: number;
    deployed_at: string | null;
  }>(
    `SELECT owner_id, fighters::int AS fighters, mode,
            COALESCE(toll_amount, 0)::float8 AS toll_amount,
            COALESCE(toll_balance, 0)::float8 AS toll_balance,
            deployed_at
     FROM garrisons
     WHERE sector_id = $1`,
    [sector],
  );

  if (garrisonResult.rows.length === 0) {
    throw buildStatusError("No friendly garrison found in this sector", 404);
  }

  const garrison = garrisonResult.rows[0];

  // Verify ownership or corp membership.
  let isFriendly = garrison.owner_id === characterId;
  if (!isFriendly) {
    const collectorCorpResult = await pg.queryObject<{ corp_id: string | null }>(
      `SELECT COALESCE(
        (SELECT corp_id FROM corporation_members WHERE character_id = $1 AND left_at IS NULL),
        (SELECT owner_corporation_id FROM ship_instances WHERE ship_id = $1)
      ) as corp_id`,
      [characterId],
    );
    const collectorCorpId = collectorCorpResult.rows[0]?.corp_id ?? null;

    if (collectorCorpId) {
      const ownerCorpResult = await pg.queryObject<{ corp_id: string | null }>(
        `SELECT COALESCE(
          (SELECT corp_id FROM corporation_members WHERE character_id = $1 AND left_at IS NULL),
          (SELECT owner_corporation_id FROM ship_instances WHERE ship_id = $1)
        ) as corp_id`,
        [garrison.owner_id],
      );
      const ownerCorpId = ownerCorpResult.rows[0]?.corp_id ?? null;
      isFriendly = ownerCorpId !== null && ownerCorpId === collectorCorpId;
    }
  }

  if (!isFriendly) {
    throw buildStatusError("No friendly garrison found in this sector", 404);
  }

  // Pay out toll balance if applicable.
  const tollPayout = garrison.mode === "toll"
    ? Math.max(0, Math.trunc(garrison.toll_balance))
    : 0;

  if (tollPayout > 0) {
    await pg.queryObject(
      `UPDATE ship_instances
       SET credits = credits + $1::bigint, updated_at = NOW()
       WHERE ship_id = $2`,
      [tollPayout, ship.ship_id],
    );
  }

  // Delete the garrison.
  const disbandedFighters = garrison.fighters;
  await pg.queryObject(
    `DELETE FROM garrisons WHERE sector_id = $1 AND owner_id = $2`,
    [sector, garrison.owner_id],
  );

  // Resolve garrison owner name for event.
  let garrisonOwnerName = character.name;
  if (garrison.owner_id !== characterId) {
    const ownerChar = await pgLoadCharacter(pg, garrison.owner_id);
    garrisonOwnerName = ownerChar.name;
  }

  // Read updated ship credits for event.
  const updatedShipResult = await pg.queryObject<{ credits: number }>(
    `SELECT credits::bigint AS credits FROM ship_instances WHERE ship_id = $1`,
    [ship.ship_id],
  );
  const newShipCredits = Number(updatedShipResult.rows[0]?.credits ?? 0);

  // Emit status.update if toll was paid out.
  if (tollPayout > 0) {
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "status.update",
      payload: {
        source: buildEventSource("combat.disband_garrison", requestId),
        sector: { id: sector },
        credits: newShipCredits,
        ship: {
          ship_id: ship.ship_id,
          ship_type: ship.ship_type,
          credits: newShipCredits,
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

  // Emit garrison.collected with fighter_loss to indicate destruction.
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "garrison.collected",
    payload: {
      source: buildEventSource("combat.disband_garrison", requestId),
      sector: { id: sector },
      credits_collected: tollPayout,
      disbanded: true,
      fighters_disbanded: disbandedFighters,
      garrison: null,
    },
    sectorId: sector,
    requestId,
    taskId,
    shipId: ship.ship_id,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  // Emit sector.update to all sector occupants.
  const sectorSnapshot = await buildSectorSnapshot(supabase, sector);
  await emitSectorEnvelope({
    supabase,
    sectorId: sector,
    eventType: "sector.update",
    payload: {
      source: buildEventSource("combat.disband_garrison", requestId),
      ...sectorSnapshot,
    },
    requestId,
    actorCharacterId: characterId,
  });

  // Emit map.update so garrison removal reflects on maps.
  const mapUpdatePayload = await buildSectorGarrisonMapUpdate(supabase, sector);
  const mapCorpRecipients = character.corporation_id
    ? await pgComputeCorpMemberRecipients(pg, [character.corporation_id], [characterId])
    : [];
  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "map.update",
    payload: {
      source: buildEventSource("combat.disband_garrison", requestId),
      ...mapUpdatePayload,
    } as Record<string, unknown>,
    sectorId: sector,
    requestId,
    taskId,
    corpId: character.corporation_id,
    additionalRecipients: mapCorpRecipients,
  });

  return successResponse({ success: true });
}
