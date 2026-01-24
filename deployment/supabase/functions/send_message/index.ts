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
  buildEventSource,
  recordEventWithRecipients,
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
import { loadCharacter, loadShip } from "../_shared/status.ts";
import {
  ensureActorAuthorization,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import {
  resolveShipByNameWithSuffixFallback,
  type ShipNameLookupError,
} from "../_shared/ship_names.ts";
import type { EventRecipientSnapshot } from "../_shared/visibility.ts";

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
    console.error("send_message.parse", err);
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
  const msgType = optionalString(payload, "type") ?? "broadcast";
  const content = optionalString(payload, "content") ?? "";
  const toName = optionalString(payload, "to_name");
  const toShipIdLabel = optionalString(payload, "to_ship_id");
  const toShipName = optionalString(payload, "to_ship_name");
  let toShipId: string | null = null;
  let toShipIdPrefix: string | null = null;
  try {
    ({ shipId: toShipId, shipIdPrefix: toShipIdPrefix } =
      parseShipIdInput(toShipIdLabel));
  } catch (err) {
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 400;
    return errorResponse(
      err instanceof Error ? err.message : "invalid ship id",
      status,
    );
  }
  const actorCharacterId = optionalString(payload, "actor_character_id");
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;
  const taskId = optionalString(payload, "task_id");

  // Validate message type
  if (!["broadcast", "direct"].includes(msgType)) {
    return errorResponse(
      "Invalid message type (must be broadcast or direct)",
      400,
    );
  }

  // Validate content
  if (!content || content.trim().length === 0) {
    return errorResponse("Empty content", 400);
  }
  if (content.length > 512) {
    return errorResponse("Content too long (max 512)", 400);
  }

  // Validate direct message requirements
  if (
    msgType === "direct" &&
    !toName &&
    !toShipId &&
    !toShipIdPrefix &&
    !toShipName
  ) {
    return errorResponse("Missing recipient for direct message", 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, "send_message");
  } catch (err) {
    if (err instanceof RateLimitError) {
      return errorResponse("Too many requests", 429);
    }
    console.error("send_message.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    return await handleSendMessage({
      supabase,
      requestId,
      characterId,
      msgType,
      content,
      toName,
      toShipId,
      toShipIdPrefix,
      toShipName,
      actorCharacterId,
      adminOverride,
      taskId,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      return errorResponse(err.message, err.status);
    }
    console.error("send_message.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    const detail = err instanceof Error ? err.message : "send message failed";
    const extra =
      err instanceof Error && "extra" in err
        ? (err as Error & { extra?: Record<string, unknown> }).extra
        : undefined;
    return errorResponse(detail, status, extra);
  }
});

async function handleSendMessage(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  msgType: string;
  content: string;
  toName: string | null;
  toShipId: string | null;
  toShipIdPrefix: string | null;
  toShipName: string | null;
  actorCharacterId: string | null;
  adminOverride: boolean;
  taskId: string | null;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    msgType,
    content,
    toName,
    toShipId,
    toShipIdPrefix,
    toShipName,
    actorCharacterId,
    adminOverride,
    taskId,
  } = params;

  // Load sender character and ship for actor authorization
  const sender = await loadCharacter(supabase, characterId);

  // Load ship for corporation ship authorization
  let ship = null;
  if (sender.current_ship_id) {
    const { data: shipData } = await supabase
      .from("ship_instances")
      .select("*")
      .eq("ship_id", sender.current_ship_id)
      .maybeSingle();
    ship = shipData;
  }

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  // Look up sender's display name
  const senderName = sender.name;

  // For direct messages, look up recipient's character ID from display name
  let toCharacterId: string | null = null;
  let resolvedToName = toName;
  if (msgType === "direct") {
    const recipient = await resolveRecipient(supabase, {
      toName,
      toShipId,
      toShipIdPrefix,
      toShipName,
      senderCorpId: sender.corporation_id,
    });
    if (!recipient) {
      const err = new Error("Recipient not found") as Error & {
        status?: number;
      };
      err.status = 404;
      throw err;
    }
    toCharacterId = recipient.characterId;
    resolvedToName = recipient.displayName;
  }

  // Build message record (mimicking legacy MessageStore.append)
  const timestamp = new Date().toISOString();
  const messageId = `${Date.now()}-${characterId.substring(0, 8)}`;

  // Public message record (excludes internal character IDs)
  const publicRecord = {
    id: messageId,
    from_name: senderName,
    type: msgType,
    content,
    to_name: msgType === "direct" ? resolvedToName : null,
    timestamp,
  };

  // Determine recipients for event filtering
  let recipients: EventRecipientSnapshot[] = [];
  let scope: "broadcast" | "direct" = "broadcast";

  if (msgType === "direct" && toCharacterId) {
    // Direct message: only sender and recipient
    recipients = [
      { characterId, reason: "sender" },
      { characterId: toCharacterId, reason: "recipient" },
    ];
    scope = "direct";
  }
  // For broadcast, recipients array stays empty but broadcast flag is set below

  // Emit chat.message event
  await recordEventWithRecipients({
    supabase,
    eventType: "chat.message",
    scope,
    payload: publicRecord,
    requestId,
    taskId,
    senderId: characterId,
    actorCharacterId: characterId,
    recipients,
    broadcast: msgType === "broadcast",
  });

  return successResponse({ id: messageId });
}

async function resolveRecipient(
  supabase: ReturnType<typeof createServiceRoleClient>,
  target: {
    toName: string | null;
    toShipId: string | null;
    toShipIdPrefix: string | null;
    toShipName: string | null;
    senderCorpId: string | null;
  },
): Promise<{ characterId: string; displayName: string } | null> {
  if (target.toShipId) {
    return await resolveRecipientByShipId(supabase, target.toShipId);
  }
  if (target.toShipIdPrefix) {
    return await resolveRecipientByShipIdPrefix(
      supabase,
      target.toShipIdPrefix,
      target.senderCorpId,
    );
  }
  if (target.toShipName) {
    return await resolveRecipientByShipName(supabase, target.toShipName);
  }
  if (!target.toName) {
    return null;
  }

  const { data, error } = await supabase
    .from("characters")
    .select("character_id, name")
    .eq("name", target.toName)
    .maybeSingle();

  if (error) {
    console.error("send_message.recipient_lookup", error);
    const err = new Error("Failed to look up recipient") as Error & {
      status?: number;
    };
    err.status = 500;
    throw err;
  }
  if (data) {
    return { characterId: data.character_id, displayName: data.name };
  }

  return await resolveRecipientByShipName(supabase, target.toName);
}

async function resolveRecipientByShipName(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipName: string,
): Promise<{ characterId: string; displayName: string } | null> {
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
      console.error("send_message.ship_lookup_suffix", cause);
    } else {
      console.error("send_message.ship_lookup", cause);
    }
    const lookupError = new Error(
      "Failed to look up recipient ship",
    ) as Error & { status?: number };
    lookupError.status = 500;
    throw lookupError;
  }

  if (lookup.status === "none") {
    return null;
  }

  if (lookup.status === "ambiguous") {
    throw buildShipNameAmbiguityError(
      lookup.base_name,
      lookup.candidates,
      lookup.total_matches,
    );
  }

  const character = await findCharacterByShipId(supabase, lookup.ship.ship_id);
  if (!character) {
    return null;
  }

  return {
    characterId: character.characterId,
    displayName:
      (lookup.ship.ship_name && lookup.ship.ship_name.trim()) ||
      lookup.ship.ship_type ||
      shipName,
  };
}

async function resolveRecipientByShipIdPrefix(
  supabase: ReturnType<typeof createServiceRoleClient>,
  prefix: string,
  senderCorpId: string | null,
): Promise<{ characterId: string; displayName: string } | null> {
  if (!senderCorpId) {
    return null;
  }
  const { data, error } = await supabase
    .from("ship_instances")
    .select("ship_id, ship_name, ship_type")
    .eq("owner_corporation_id", senderCorpId);

  if (error) {
    console.error("send_message.ship_prefix_lookup", error);
    const err = new Error("Failed to look up recipient ship") as Error & {
      status?: number;
    };
    err.status = 500;
    throw err;
  }

  const matches = (data ?? [])
    .filter((row) => typeof row.ship_id === "string")
    .filter((row) => row.ship_id.toLowerCase().startsWith(prefix));

  if (matches.length > 1) {
    const err = new Error(
      "Ship id prefix is ambiguous; use ship name or full ship_id",
    ) as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  if (matches.length === 0) {
    return null;
  }

  const match = matches[0];
  const character = await findCharacterByShipId(supabase, match.ship_id);
  if (!character) {
    return null;
  }

  return {
    characterId: character.characterId,
    displayName:
      (match.ship_name && match.ship_name.trim()) ||
      match.ship_type ||
      match.ship_id,
  };
}

function buildShipNameAmbiguityError(
  baseName: string,
  candidates: string[],
  totalMatches: number,
): Error & { status?: number; extra?: Record<string, unknown> } {
  const err = new Error(
    "Ship name is ambiguous; use full ship name",
  ) as Error & {
    status?: number;
    extra?: Record<string, unknown>;
  };
  err.status = 409;
  err.extra = {
    base_name: baseName,
    candidates,
    total_matches: totalMatches,
  };
  return err;
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
  const err = new Error(
    "to_ship_id must be a UUID or 6-8 hex prefix",
  ) as Error & { status?: number };
  err.status = 400;
  throw err;
}

async function resolveRecipientByShipId(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipId: string,
): Promise<{ characterId: string; displayName: string } | null> {
  let ship;
  try {
    ship = await loadShip(supabase, shipId);
  } catch (err) {
    console.error("send_message.ship_lookup_id", err);
    return null;
  }

  const character = await findCharacterByShipId(supabase, ship.ship_id);
  if (!character) {
    return null;
  }

  return {
    characterId: character.characterId,
    displayName:
      (ship.ship_name && ship.ship_name.trim()) ||
      ship.ship_type ||
      ship.ship_id,
  };
}

async function findCharacterByShipId(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipId: string,
): Promise<{ characterId: string; name: string } | null> {
  const { data, error } = await supabase
    .from("characters")
    .select("character_id, name, current_ship_id")
    .eq("current_ship_id", shipId)
    .maybeSingle();

  if (error) {
    console.error("send_message.ship_character_lookup", error);
    const err = new Error("Failed to look up recipient ship") as Error & {
      status?: number;
    };
    err.status = 500;
    throw err;
  }
  if (data) {
    return { characterId: data.character_id, name: data.name };
  }

  const { data: directData, error: directError } = await supabase
    .from("characters")
    .select("character_id, name")
    .eq("character_id", shipId)
    .maybeSingle();

  if (directError) {
    console.error("send_message.ship_character_direct_lookup", directError);
    const err = new Error("Failed to look up recipient ship") as Error & {
      status?: number;
    };
    err.status = 500;
    throw err;
  }
  if (!directData) {
    return null;
  }

  return { characterId: directData.character_id, name: directData.name };
}
