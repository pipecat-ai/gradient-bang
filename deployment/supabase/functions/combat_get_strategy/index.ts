import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import { validate as validateUuid } from "https://deno.land/std@0.197.0/uuid/mod.ts";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { emitErrorEvent } from "../_shared/events.ts";
import { enforceRateLimit, RateLimitError } from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
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
  DEFAULT_STRATEGY_TEMPLATE,
  type CombatStrategyTemplate,
} from "../_shared/combat_doctrines.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(traced("combat_get_strategy", async (req, trace) => {
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
    console.error("combat_get_strategy.parse", err);
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
  const adminOverride = optionalBoolean(payload, "admin_override") ?? false;

  trace.setInput({ requestId, characterId, shipId });

  const sRateLimit = trace.span("rate_limit");
  try {
    await enforceRateLimit(supabase, characterId, "combat_get_strategy");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: String(err) });
    if (err instanceof RateLimitError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_get_strategy",
        requestId,
        detail: "Too many requests",
        status: 429,
      });
      return errorResponse("Too many requests", 429);
    }
    console.error("combat_get_strategy.rate_limit", err);
    return errorResponse("rate limit error", 500);
  }

  try {
    const resolvedShipId = await resolveShipIdInput(supabase, characterId, shipId);
    const ship = await loadShip(supabase, resolvedShipId);

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
      } else if (ship.owner_character_id !== characterId) {
        throw new ActorAuthorizationError(
          "Not authorized: must be the ship's owner",
          403,
        );
      }
    }

    const { data, error } = await supabase
      .from("combat_strategies")
      .select("strategy_id, ship_id, template, custom_prompt, updated_at")
      .eq("ship_id", resolvedShipId)
      .maybeSingle();

    if (error) {
      console.error("combat_get_strategy.fetch", error);
      throw new Error(error.message ?? "Failed to fetch combat strategy");
    }

    // Attach doctrine text + the default-template fallback so consumers
    // (LLM tool results, RTVI-driven UI) have everything needed to
    // describe the ship's active combat doctrine without a second call.
    //
    // - row present → doctrine matches row.template, custom_prompt as stored.
    // - row absent  → ship runs the default doctrine (balanced), no custom.
    let responseStrategy: Record<string, unknown> | null = null;
    if (data) {
      const template = data.template as CombatStrategyTemplate;
      responseStrategy = {
        ...data,
        doctrine: getDoctrineText(template),
      };
    }

    trace.setOutput({
      request_id: requestId,
      characterId,
      shipId: resolvedShipId,
      found: !!data,
    });
    return successResponse({
      success: true,
      strategy: responseStrategy,
      default_template: DEFAULT_STRATEGY_TEMPLATE,
      default_doctrine: getDoctrineText(DEFAULT_STRATEGY_TEMPLATE),
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      await emitErrorEvent(supabase, {
        characterId,
        method: "combat_get_strategy",
        requestId,
        detail: err.message,
        status: err.status,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("combat_get_strategy.error", err);
    const status =
      err instanceof Error && "status" in err
        ? Number((err as Error & { status?: number }).status)
        : 500;
    const detail =
      err instanceof Error ? err.message : "get combat strategy failed";
    await emitErrorEvent(supabase, {
      characterId,
      method: "combat_get_strategy",
      requestId,
      detail,
      status,
    });
    return errorResponse(detail, status);
  }
}));

// Accept either a full UUID or a 6-8 hex prefix. For a prefix, resolve by
// scanning the caller's personal ship + corp ships (same pattern as
// ship_rename). Keeps ship ids consistent across tools — the LLM can paste
// whatever it sees in `ships.list` summaries.
async function resolveShipIdInput(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
  raw: string,
): Promise<string> {
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
  const prefix = trimmed.toLowerCase();
  const character = await loadCharacter(supabase, characterId);
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
      console.error("combat_get_strategy.ship_prefix_lookup", error);
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
