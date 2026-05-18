import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  type AuthContext,
  authenticate,
  authErrorResponse,
  canActOnCharacter,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import {
  pgBuildStatusPayload,
  pgEnsureActorAuthorization,
  pgLoadCharacterContext,
  RateLimitError,
} from "../_shared/pg_queries.ts";
import {
  optionalString,
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { ActorAuthorizationError } from "../_shared/actors.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(traced("sms_agent_tools", async (req, trace) => {
  let auth: AuthContext;
  try {
    auth = await authenticate(req);
  } catch (err) {
    return authErrorResponse(err);
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
    console.error("sms_agent_tools.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const tool = requireString(payload, "tool");
  if (tool !== "status") {
    return errorResponse("unsupported sms agent tool", 400);
  }

  const rawCharacterId = requireString(payload, "character_id");
  let characterId: string;
  try {
    characterId = await canonicalizeCharacterId(rawCharacterId);
  } catch (err) {
    console.error("sms_agent_tools.canonicalize_character_id", err);
    return errorResponse("invalid character_id", 400);
  }

  const rawActorId = optionalString(payload, "actor_character_id");
  let actorCharacterId: string | null = null;
  if (rawActorId) {
    try {
      actorCharacterId = await canonicalizeCharacterId(rawActorId);
    } catch (err) {
      console.error("sms_agent_tools.canonicalize_actor_id", err);
      return errorResponse("invalid actor_character_id", 400);
    }
  }

  if (
    !(await canActOnCharacter(auth, actorCharacterId ?? characterId, supabase))
  ) {
    return errorResponse("forbidden", 403);
  }

  trace.setInput({
    tool,
    characterId,
    actorCharacterId: actorCharacterId ?? null,
    requestId,
  });

  const pg = await acquirePgClient();
  try {
    const sLoadCtx = trace.span("load_character_context", {
      character_id: characterId,
    });
    let ctx;
    try {
      ctx = await pgLoadCharacterContext(pg, characterId, {
        endpoint: "sms_agent_tools",
      });
      sLoadCtx.end({ name: ctx.character.name, ship_id: ctx.ship.ship_id });
    } catch (err) {
      sLoadCtx.end({ error: String(err) });
      if (err instanceof RateLimitError) {
        return errorResponse("Too many status requests", 429);
      }
      if (err instanceof Error && err.message.includes("not found")) {
        return errorResponse("character not found", 404);
      }
      throw err;
    }

    const sAuth = trace.span("actor_authorization");
    await pgEnsureActorAuthorization(pg, {
      ship: ctx.ship,
      actorCharacterId,
      adminOverride: false,
      targetCharacterId: characterId,
    });
    sAuth.end();

    if (ctx.ship.in_hyperspace) {
      return errorResponse(
        "Character is in hyperspace, status unavailable until arrival",
        409,
      );
    }

    const sBuildStatus = trace.span("build_status_payload");
    const statusPayload = await pgBuildStatusPayload(pg, characterId, {
      character: ctx.character,
      ship: ctx.ship,
      shipDefinition: ctx.shipDefinition,
      actorCharacterId,
      parentSpan: sBuildStatus,
    });
    sBuildStatus.end();

    const summary = summarizeStatus(statusPayload);
    trace.setOutput({ tool, request_id: requestId, characterId });
    return successResponse({
      tool,
      request_id: requestId,
      status: statusPayload,
      summary,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      return errorResponse(err.message, err.status);
    }
    if (err instanceof Error && /not found/i.test(err.message ?? "")) {
      return errorResponse("character not found", 404);
    }
    console.error("sms_agent_tools.unhandled", err);
    return errorResponse("internal server error", 500);
  } finally {
    pg.release();
  }
}));

function summarizeStatus(status: Record<string, unknown>): string {
  const player = asRecord(status.player);
  const ship = asRecord(status.ship);
  const sector = asRecord(status.sector);
  const corporation = asRecord(status.corporation);

  const playerName = stringValue(player.name) ?? "Unknown player";
  const sectorId = stringValue(sector.id) ?? "unknown";
  const shipName = stringValue(ship.ship_name) ?? stringValue(ship.name) ??
    "unknown ship";
  const shipType = stringValue(ship.ship_type) ??
    stringValue(ship.ship_type_name) ?? "ship";
  const credits = numberValue(ship.credits) ??
    numberValue(player.credits_on_hand) ?? 0;
  const bank = numberValue(player.credits_in_bank);
  const warp = numberValue(ship.warp_power) ?? 0;
  const warpMax = numberValue(ship.warp_power_capacity) ?? 0;
  const shields = numberValue(ship.shields) ?? 0;
  const shieldsMax = numberValue(ship.max_shields) ?? 0;
  const fighters = numberValue(ship.fighters) ?? 0;
  const region = stringValue(sector.region);

  const lines = [
    `Player: ${playerName}`,
    `In sector ${sectorId}${region ? ` (${region})` : ""}.`,
  ];
  if (corporation && stringValue(corporation.name)) {
    lines.push(`Corporation: ${stringValue(corporation.name)}`);
  }
  lines.push(`Ship: ${shipName} (${shipType})`);
  lines.push(`Credits: ${credits}${bank !== null ? ` (bank: ${bank})` : ""}.`);
  lines.push(
    `Warp: ${warp}/${warpMax}. Shields: ${shields}/${shieldsMax}. Fighters: ${fighters}.`,
  );
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
