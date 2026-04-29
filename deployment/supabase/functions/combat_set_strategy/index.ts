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
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { loadCharacter, loadShip } from "../_shared/status.ts";
import {
  ensureActorCanControlShip,
  ActorAuthorizationError,
} from "../_shared/actors.ts";
import {
  getDoctrineText,
  isValidTemplate,
  type CombatStrategyTemplate,
} from "../_shared/combat_doctrines.ts";
import { traced } from "../_shared/weave.ts";

// custom_prompt is optional with ANY template — it's additive guidance the
// commander layers on top of the base doctrine.
const MAX_CUSTOM_PROMPT_CHARS = 1000;

Deno.serve(traced("combat_set_strategy", async (req, trace) => {
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
    console.error("combat_set_strategy.parse", err);
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
  const shipId = requireString(payload, "ship_id");
  const template = (requireString(payload, "template")).toLowerCase();
  const customPrompt = optionalString(payload, "custom_prompt");
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;

  trace.setInput({ requestId, characterId, shipId, template, adminOverride });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "combat_set_strategy");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_set_strategy",
        requestId,
        detail: "Too many requests",
        status: 429,
      });
      return errorResponse("Too many requests", 429);
    }
    console.error("combat_set_strategy.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const sHandle = trace.span("handle_set_strategy", {
      character_id: characterId,
      ship_id: shipId,
      template,
    });
    const result = await handleCombatSetStrategy({
      supabase,
      requestId,
      characterId,
      shipId,
      template,
      customPrompt,
      adminOverride,
    });
    sHandle.end();
    trace.setOutput({ request_id: requestId, characterId, shipId, template });
    return result;
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_set_strategy",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("combat_set_strategy.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    const detail =
      err instanceof Error ? err.message : "set combat strategy failed";
    await emitErrorEvent(supabase, {
      characterId,
      method: "combat_set_strategy",
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  }
}));

async function handleCombatSetStrategy(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  shipId: string;
  template: string;
  customPrompt: string | null;
  adminOverride: boolean;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    shipId,
    template,
    customPrompt,
    adminOverride,
  } = params;

  if (!isValidTemplate(template)) {
    const err = new Error(
      "Invalid template; must be one of: balanced, offensive, defensive",
    ) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const validTemplate = template as CombatStrategyTemplate;

  // custom_prompt is optional; when provided it must be a non-empty string
  // up to MAX_CUSTOM_PROMPT_CHARS. Mirrors the DB CHECK constraint so we
  // fail at 400 instead of 500 on constraint violation.
  const trimmedCustom = customPrompt?.trim() ?? "";
  const effectiveCustomPrompt = trimmedCustom.length > 0 ? trimmedCustom : null;
  if (effectiveCustomPrompt && effectiveCustomPrompt.length > MAX_CUSTOM_PROMPT_CHARS) {
    const err = new Error(
      `custom_prompt exceeds maximum length of ${MAX_CUSTOM_PROMPT_CHARS} characters`,
    ) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const character = await loadCharacter(supabase, characterId);
  const resolvedShipId = resolveShipIdFromInputSync(shipId) ??
    (await resolveShipIdByPrefix(supabase, shipId, character));
  const ship = await loadShip(supabase, resolvedShipId);

  // Authorization: personal ships require owner match; corp ships require corp
  // membership. Admin override bypasses both.
  if (!adminOverride) {
    if (ship.owner_type === "corporation") {
      const allowed = await ensureActorCanControlShip(
        supabase,
        characterId,
        ship,
      );
      if (!allowed) {
        throw new ActorAuthorizationError(
          "Not authorized: must be a member of the ship's corporation",
          403,
        );
      }
    } else {
      if (ship.owner_character_id !== characterId) {
        throw new ActorAuthorizationError(
          "Not authorized: must be the ship's owner",
          403,
        );
      }
    }
  }

  // Upsert: one row per ship (UNIQUE(ship_id)). author_character_id tracks
  // who last set it — useful for corp-ship provenance.
  const { data: upserted, error: upsertError } = await supabase
    .from("combat_strategies")
    .upsert(
      {
        ship_id: resolvedShipId,
        template: validTemplate,
        custom_prompt: effectiveCustomPrompt,
        author_character_id: characterId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "ship_id" },
    )
    .select("strategy_id, ship_id, template, custom_prompt, updated_at")
    .single();

  if (upsertError || !upserted) {
    console.error("combat_set_strategy.upsert", upsertError);
    const err = new Error(
      upsertError?.message ?? "Failed to save combat strategy",
    ) as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  // Surface the base doctrine text alongside the custom prompt so clients
  // and the LLM relay can display / append both without a second lookup.
  const doctrine = getDoctrineText(upserted.template as CombatStrategyTemplate);

  const strategyPayload = {
    template: upserted.template,
    custom_prompt: upserted.custom_prompt,
    doctrine,
    updated_at: upserted.updated_at,
  };

  // ship_name is NULL in the DB for default-named ships (the display name is
  // derived from ship_type). Fall back so the LLM always sees something
  // identifiable when matching this event to known fleet entries.
  const displayShipName =
    (ship.ship_name && ship.ship_name.trim().length > 0)
      ? ship.ship_name
      : (ship.ship_type ?? null);

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "ships.strategy_set",
    payload: {
      source: buildEventSource("ships.set_strategy", requestId),
      ship_id: upserted.ship_id,
      ship_name: displayShipName,
      ship_type: ship.ship_type ?? null,
      strategy: strategyPayload,
      player: { id: characterId },
    },
    sectorId: null,
    requestId,
    shipId: upserted.ship_id,
    actorCharacterId: characterId,
    corpId: character.corporation_id,
  });

  return successResponse({
    success: true,
    strategy: {
      strategy_id: upserted.strategy_id,
      ship_id: upserted.ship_id,
      ...strategyPayload,
    },
  });
}

// Returns a normalized full UUID if input is already one, else null.
function resolveShipIdFromInputSync(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    const err = new Error("ship_id is required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  if (validateUuid(trimmed)) return trimmed;
  if (!/^[0-9a-f]{6,8}$/i.test(trimmed)) {
    const err = new Error(
      "ship_id must be a UUID or 6-8 hex prefix",
    ) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return null; // signal: caller must resolve via prefix lookup
}

// Resolve a 6-8 hex prefix against the caller's personal ship + corp ships.
// Matches the pattern used by ship_rename / transfer_warp_power.
async function resolveShipIdByPrefix(
  supabase: ReturnType<typeof createServiceRoleClient>,
  raw: string,
  character: { current_ship_id: string | null; corporation_id: string | null },
): Promise<string> {
  const prefix = raw.trim().toLowerCase();
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
      console.error("combat_set_strategy.ship_prefix_lookup", error);
      const err = new Error("Failed to resolve ship_id prefix") as Error & {
        status?: number;
      };
      err.status = 500;
      throw err;
    }
    for (const row of data ?? []) {
      const shipId = row?.ship_id;
      if (typeof shipId === "string" && shipId.toLowerCase().startsWith(prefix)) {
        matches.add(shipId);
      }
    }
  }
  if (matches.size > 1) {
    const err = new Error(
      "ship_id prefix is ambiguous; use full ship_id",
    ) as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  const match = matches.values().next().value;
  if (!match) {
    const err = new Error(
      `No ship matching prefix '${prefix}' owned or accessible to caller`,
    ) as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return match;
}
