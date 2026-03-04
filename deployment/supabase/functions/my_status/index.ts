import { serve } from "https://deno.land/std@0.197.0/http/server.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
import { ActorAuthorizationError } from "../_shared/actors.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import {
  pgLoadCharacterContext,
  pgFinishHyperspace,
  pgMarkSectorVisited,
  pgBuildSectorSnapshot,
  pgBuildStatusPayload,
  pgEnsureActorAuthorization,
  pgEmitCharacterEvent,
  RateLimitError,
} from "../_shared/pg_queries.ts";
import { traced } from "../_shared/weave.ts";

const HYPERSPACE_ERROR =
  "Character is in hyperspace, status unavailable until arrival";
const STUCK_THRESHOLD_MS = 20_000; // 20 seconds past ETA = stuck

Deno.serve(traced("my_status", async (req, trace) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("my_status.parse", err);
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
  let characterId: string;
  try {
    characterId = await canonicalizeCharacterId(rawCharacterId);
  } catch (err) {
    console.error("my_status.canonicalize_character_id", err);
    return errorResponse("invalid character_id", 400);
  }

  const rawActorId = optionalString(payload, "actor_character_id");
  let actorCharacterId: string | null = null;
  if (rawActorId) {
    try {
      actorCharacterId = await canonicalizeCharacterId(rawActorId);
    } catch (err) {
      console.error("my_status.canonicalize_actor_id", err);
      return errorResponse("invalid actor_character_id", 400);
    }
  }
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  const pg = await acquirePgClient();
  try {
    // Load character context (rate limit + character + ship + definition in one query)
    const sLoadCtx = trace.span("load_character_context", { character_id: characterId });
    let ctx;
    try {
      ctx = await pgLoadCharacterContext(pg, characterId, {
        endpoint: "my_status",
      });
      sLoadCtx.end({ name: ctx.character.name, ship_id: ctx.ship.ship_id });
    } catch (err) {
      sLoadCtx.end({ error: String(err) });
      if (err instanceof RateLimitError) {
        return errorResponse("Too many my_status requests", 429);
      }
      if (err instanceof Error && err.message.includes("not found")) {
        return errorResponse("character not found", 404);
      }
      throw err;
    }
    const { character, ship, shipDefinition } = ctx;

    const sAuth = trace.span("actor_authorization");
    await pgEnsureActorAuthorization(pg, {
      ship,
      actorCharacterId,
      adminOverride,
      targetCharacterId: characterId,
    });
    sAuth.end();

    if (ship.in_hyperspace) {
      // Check if ship is stuck (past ETA + threshold)
      const now = Date.now();
      const eta = ship.hyperspace_eta
        ? new Date(ship.hyperspace_eta).getTime()
        : null;

      if (eta && now > eta + STUCK_THRESHOLD_MS && ship.hyperspace_destination !== null) {
        // Ship is stuck - recover by completing the hyperspace jump
        console.warn("my_status.hyperspace_recovery", {
          character_id: characterId,
          ship_id: ship.ship_id,
          stuck_destination: ship.hyperspace_destination,
          eta: ship.hyperspace_eta,
          seconds_overdue: Math.round((now - eta) / 1000),
        });

        const sRecovery = trace.span("hyperspace_recovery");
        try {
          await pgFinishHyperspace(pg, {
            shipId: ship.ship_id,
            destination: ship.hyperspace_destination,
          });
          const sectorSnapshot = await pgBuildSectorSnapshot(
            pg,
            ship.hyperspace_destination,
            characterId,
          );
          await pgMarkSectorVisited(pg, {
            characterId,
            sectorId: ship.hyperspace_destination,
            sectorSnapshot,
            playerMetadata: character.player_metadata,
            corporationId: character.corporation_id,
          });
          // Update local ship state to reflect completed jump
          ship.in_hyperspace = false;
          ship.current_sector = ship.hyperspace_destination;
          ship.hyperspace_destination = null;
          ship.hyperspace_eta = null;
          sRecovery.end();
        } catch (recoveryErr) {
          sRecovery.end({ error: String(recoveryErr) });
          console.error("my_status.hyperspace_recovery_failed", recoveryErr);
          await emitErrorEvent(supabase, {
            characterId,
            method: "my_status",
            requestId,
            detail: "Failed to recover from stuck hyperspace",
            status: 500,
          });
          return errorResponse("failed to recover from stuck hyperspace", 500);
        }
      } else {
        // Ship is legitimately in hyperspace - return error
        await emitErrorEvent(supabase, {
          characterId,
          method: "my_status",
          requestId,
          detail: HYPERSPACE_ERROR,
          status: 409,
        });
        return errorResponse(HYPERSPACE_ERROR, 409);
      }
    }

    const source = buildEventSource("my_status", requestId);
    const sBuildStatus = trace.span("build_status_payload");
    const statusPayload = await pgBuildStatusPayload(pg, characterId, {
      character,
      ship,
      shipDefinition,
      parentSpan: sBuildStatus,
    });
    statusPayload["source"] = source;
    sBuildStatus.end();

    // For corp ships the recipient should be the actor (the player controlling
    // the ship) rather than the ship's pseudo-character which nothing polls for.
    // We also set corp_id so the event is discoverable via events_since corp_id
    // polling.
    const isCorpShip = actorCharacterId && ship.owner_corporation_id;
    const eventRecipientId = isCorpShip ? actorCharacterId : characterId;
    const eventCorpId = isCorpShip ? ship.owner_corporation_id : undefined;

    const sEmitEvent = trace.span("emit_status_snapshot");
    await pgEmitCharacterEvent({
      pg,
      characterId: eventRecipientId,
      eventType: "status.snapshot",
      payload: statusPayload,
      shipId: ship.ship_id,
      sectorId: ship.current_sector ?? null,
      requestId,
      taskId,
      corpId: eventCorpId,
    });
    sEmitEvent.end();

    return successResponse({ request_id: requestId });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      return errorResponse(err.message, err.status);
    }
    if (isNotFoundError(err)) {
      return errorResponse("character not found", 404);
    }
    console.error("my_status.unhandled", err);
    return errorResponse("internal server error", 500);
  } finally {
    pg.release();
  }
}));

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /not found/i.test(err.message ?? "");
}
