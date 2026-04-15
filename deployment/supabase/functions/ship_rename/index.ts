/**
 * Edge Function: ship_rename
 *
 * Renames a ship (personal or corporation).
 * Emits ship.renamed event (corp scope for corp ships, direct for personal).
 * For personal ships, also emits status.update to refresh UI state.
 */

import { validate as validateUuid } from "https://deno.land/std@0.197.0/uuid/mod.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  ActorAuthorizationError,
  ensureActorAuthorization,
} from "../_shared/actors.ts";
import {
  emitCharacterEvent,
  emitErrorEvent,
  buildEventSource,
} from "../_shared/events.ts";
import {
  emitCorporationEvent,
  loadCorporationById,
} from "../_shared/corporations.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";
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
} from "../_shared/status.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import { pgBuildStatusPayload } from "../_shared/pg_queries.ts";
import {
  validateDisplayName,
  NameValidationError,
} from "../_shared/name_validation.ts";
import { traced } from "../_shared/weave.ts";

class ShipRenameError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ShipRenameError";
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;

Deno.serve(traced("ship_rename", async (req, trace) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: JsonRecord;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("ship_rename.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: "ok" });
  }

  const requestId = resolveRequestId(payload);

  try {
    const rawCharacterId = requireString(payload, "character_id");
    const characterId = await canonicalizeCharacterId(rawCharacterId);
    const actorLabel = optionalString(payload, "actor_character_id");
    const actorCharacterId = actorLabel
      ? await canonicalizeCharacterId(actorLabel)
      : null;
    const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
    const shipId = optionalString(payload, "ship_id");
    const shipName = requireString(payload, "ship_name");
    const taskId = optionalString(payload, "task_id");

    trace.setInput({
      characterId,
      actorCharacterId,
      adminOverride,
      shipId,
      shipName,
      taskId,
      requestId,
    });

    const rateLimitId = actorCharacterId ?? characterId;
    const sRateLimit = trace.span("rate_limit");
    try {
      await enforceRateLimit(supabase, rateLimitId, "ship_rename");
      sRateLimit.end();
    } catch (err) {
      sRateLimit.end({ error: "rate_limited" });
      if (err instanceof RateLimitError) {
        await emitErrorEvent(supabase, {
          characterId,
          method: "ship_rename",
          requestId,
          detail: "Too many ship_rename requests",
          status: 429,
        });
        return errorResponse("Too many ship_rename requests", 429);
      }
      console.error("ship_rename.rate_limit", err);
      return errorResponse("rate limit error", 500);
    }

    const sRename = trace.span("handle_rename");
    const renamed = await handleRename({
      supabase,
      characterId,
      actorCharacterId,
      adminOverride,
      shipId,
      shipName,
      requestId,
      taskId,
    });
    sRename.end({ changed: renamed.changed });

    trace.setOutput({ request_id: requestId, ship_id: renamed.ship_id, changed: renamed.changed });
    return successResponse({ request_id: requestId, ...renamed });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    if (err instanceof NameValidationError) {
      const rawCharacterId = payload.character_id as string | undefined;
      if (rawCharacterId) {
        try {
          const characterId = await canonicalizeCharacterId(rawCharacterId);
          await emitErrorEvent(supabase, {
            characterId,
            method: "ship_rename",
            requestId,
            detail: err.message,
            status: err.status,
          });
        } catch (emitErr) {
          console.error("ship_rename.emit_error", emitErr);
        }
      }
      return errorResponse(err.message, err.status, { code: err.code });
    }
    if (err instanceof ActorAuthorizationError) {
      const rawCharacterId = payload.character_id as string | undefined;
      if (rawCharacterId) {
        try {
          const characterId = await canonicalizeCharacterId(rawCharacterId);
          await emitErrorEvent(supabase, {
            characterId,
            method: "ship_rename",
            requestId,
            detail: err.message,
            status: err.status,
          });
        } catch (emitErr) {
          console.error("ship_rename.emit_error", emitErr);
        }
      }
      return errorResponse(err.message, err.status);
    }
    if (err instanceof ShipRenameError) {
      const rawCharacterId = payload.character_id as string | undefined;
      if (rawCharacterId) {
        try {
          const characterId = await canonicalizeCharacterId(rawCharacterId);
          await emitErrorEvent(supabase, {
            characterId,
            method: "ship_rename",
            requestId,
            detail: err.message,
            status: err.status,
          });
        } catch (emitErr) {
          console.error("ship_rename.emit_error", emitErr);
        }
      }
      return errorResponse(err.message, err.status);
    }

    console.error("ship_rename.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));

async function handleRename(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  characterId: string;
  actorCharacterId: string | null;
  adminOverride: boolean;
  shipId: string | null;
  shipName: string;
  requestId: string;
  taskId: string | null;
}): Promise<{ ship_id: string; ship_name: string; changed: boolean }> {
  const {
    supabase,
    characterId,
    actorCharacterId,
    adminOverride,
    shipId,
    shipName,
    requestId,
    taskId,
  } = params;

  const character = await loadCharacterRow(supabase, characterId);
  const { shipId: parsedShipId, shipIdPrefix } = parseShipIdInput(shipId);
  let resolvedShipId = parsedShipId;
  if (!resolvedShipId && shipIdPrefix) {
    resolvedShipId = await resolveShipIdByPrefixForCharacter(
      supabase,
      shipIdPrefix,
      character,
    );
    if (!resolvedShipId) {
      throw new ShipRenameError("Ship not found", 404);
    }
  }
  if (!resolvedShipId) {
    resolvedShipId = character.current_ship_id ?? null;
  }
  if (!resolvedShipId) {
    throw new ShipRenameError("Character has no ship", 400);
  }

  const ship = await loadShip(supabase, resolvedShipId);
  if (ship.owner_type === "unowned") {
    throw new ShipRenameError("Cannot rename unowned ships", 403);
  }

  const effectiveActorId = actorCharacterId ?? characterId;
  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId: effectiveActorId,
    adminOverride,
    targetCharacterId: ship.owner_character_id ?? ship.owner_id ?? ship.ship_id,
  });

  const trimmedName = validateDisplayName(shipName, "ship");

  const oldName = ship.ship_name ?? null;
  const changed = oldName !== trimmedName;

  if (changed) {
    await ensureShipNameUnique(supabase, ship.ship_id, trimmedName);

    const { error: shipUpdateError } = await supabase
      .from("ship_instances")
      .update({ ship_name: trimmedName })
      .eq("ship_id", ship.ship_id);

    if (shipUpdateError) {
      console.error("ship_rename.ship_update", shipUpdateError);
      throw new ShipRenameError("Failed to rename ship", 500);
    }

    // For corporation ships, the pseudo-character name should match the ship name
    if (ship.owner_type === "corporation") {
      const { error: charUpdateError } = await supabase
        .from("characters")
        .update({ name: trimmedName })
        .eq("character_id", ship.ship_id);

      if (charUpdateError) {
        console.error("ship_rename.character_update", charUpdateError);
      }
    }
  }

  const timestamp = new Date().toISOString();
  const source = buildEventSource("ship_rename", requestId);
  const actorName =
    actorCharacterId && actorCharacterId !== characterId
      ? await loadActorName(supabase, actorCharacterId)
      : null;
  const ownerCorporationName =
    ship.owner_type === "corporation" && ship.owner_corporation_id
      ? (await loadCorporationById(supabase, ship.owner_corporation_id)).name
      : null;
  const eventPayload: Record<string, unknown> = {
    source,
    ship_id: ship.ship_id,
    ship_type: ship.ship_type,
    ship_name: trimmedName,
    previous_ship_name: oldName,
    owner_type: ship.owner_type,
    owner_character_id: ship.owner_character_id ?? null,
    owner_corporation_name: ownerCorporationName,
    actor_id: effectiveActorId,
    actor_name: actorName ?? character.name,
    timestamp,
    changed,
  };

  if (ship.owner_type === "corporation" && ship.owner_corporation_id) {
    eventPayload.corp_id = ship.owner_corporation_id;
    await emitCorporationEvent(supabase, ship.owner_corporation_id, {
      eventType: "ship.renamed",
      payload: eventPayload,
      requestId,
      actorCharacterId: effectiveActorId,
      taskId,
    });
  } else {
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "ship.renamed",
      payload: eventPayload,
      requestId,
      taskId,
      shipId: ship.ship_id,
      actorCharacterId: effectiveActorId,
    });

    if (changed) {
      const pgClient = await acquirePgClient();
      let statusPayload: Record<string, unknown>;
      try {
        statusPayload = await pgBuildStatusPayload(pgClient, characterId, {
          actorCharacterId,
        });
      } finally {
        pgClient.release();
      }
      await emitCharacterEvent({
        supabase,
        characterId,
        eventType: "status.update",
        payload: statusPayload,
        sectorId: ship.current_sector ?? null,
        requestId,
        taskId,
        shipId: ship.ship_id,
        corpId: character.corporation_id,
      });
    }
  }

  return { ship_id: ship.ship_id, ship_name: trimmedName, changed };
}

async function loadCharacterRow(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
) {
  const { data, error } = await supabase
    .from("characters")
    .select("character_id, name, current_ship_id, corporation_id")
    .eq("character_id", characterId)
    .maybeSingle();

  if (error) {
    console.error("ship_rename.character_load", error);
    throw new ShipRenameError("Failed to load character", 500);
  }
  if (!data) {
    throw new ShipRenameError("Character not found", 404);
  }
  return data as {
    character_id: string;
    name: string;
    current_ship_id: string | null;
    corporation_id: string | null;
  };
}

async function loadActorName(
  supabase: ReturnType<typeof createServiceRoleClient>,
  actorCharacterId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("characters")
    .select("name")
    .eq("character_id", actorCharacterId)
    .maybeSingle();

  if (error) {
    console.error("ship_rename.actor_load", error);
    return null;
  }
  if (!data || typeof data.name !== "string" || !data.name.trim()) {
    return null;
  }
  return data.name;
}

async function ensureShipNameUnique(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipId: string,
  shipName: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("ship_instances")
    .select("ship_id")
    .eq("ship_name", shipName)
    .neq("ship_id", shipId)
    .maybeSingle();

  if (error) {
    console.error("ship_rename.name_check", error);
    throw new ShipRenameError("Failed to validate ship name", 500);
  }

  if (data) {
    throw new ShipRenameError("A ship already exists in the universe with that name. Each ship must have a unique name.", 409);
  }
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
  throw new ShipRenameError("ship_id must be a UUID or 6-8 hex prefix", 400);
}

async function resolveShipIdByPrefixForCharacter(
  supabase: ReturnType<typeof createServiceRoleClient>,
  prefix: string,
  character: { current_ship_id: string | null; corporation_id: string | null },
): Promise<string | null> {
  const matches = new Set<string>();
  const personalShipId = character.current_ship_id ?? null;
  if (personalShipId && personalShipId.toLowerCase().startsWith(prefix)) {
    matches.add(personalShipId);
  }

  if (character.corporation_id) {
    const { data, error } = await supabase
      .from("corporation_ships")
      .select("ship_id")
      .eq("corp_id", character.corporation_id);

    if (error) {
      console.error("ship_rename.ship_prefix_lookup", error);
      throw new ShipRenameError("Failed to lookup ship", 500);
    }

    for (const row of data ?? []) {
      const shipId = row?.ship_id;
      if (
        typeof shipId === "string" &&
        shipId.toLowerCase().startsWith(prefix)
      ) {
        matches.add(shipId);
      }
    }
  }

  if (matches.size > 1) {
    throw new ShipRenameError(
      "Ship id prefix is ambiguous; use full ship_id",
      409,
    );
  }
  if (matches.size === 1) {
    return matches.values().next().value ?? null;
  }
  return null;
}
