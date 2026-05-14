/**
 * Edge Function: ship_byoa_configure
 *
 * Configures BYOA (Bring-Your-Own-Agent) state on a corporation ship.
 * Three actions:
 *
 *   - claim: set byoa_owner_character_id = self, byoa_mode = private
 *   - clear: set byoa_owner_character_id = NULL, byoa_mode = 'private' (default)
 *   - set:   write per-ship wake config (encrypted wake_secret + source_url).
 *           Owner-only; ship_instances columns are encrypted server-side via
 *           set_ship_byoa_wake_config() SECURITY DEFINER. Neither value is
 *           returned to clients afterwards.
 *
 * Rules:
 *   - Caller must be a corp member of the ship's corp
 *   - Self-only claim: a member can only claim BYOA for themselves
 *   - clear / set are owner-only
 *   - Refuses to claim/clear while the ship appears to have an active task
 *     (derived from recent task.start events without a matching task.finish/
 *     task.cancel). Best-effort UX guard, not an atomic mutex. set is
 *     wake-config only and is allowed during a task.
 *   - Only corporation-owned ships can have BYOA configured
 */

import { validate as validateUuid } from "https://deno.land/std@0.197.0/uuid/mod.ts";

import {
  errorResponse,
  getAuthenticatedUser,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { buildEventSource, emitCharacterEvent } from "../_shared/events.ts";
import { emitCorporationEvent } from "../_shared/corporations.ts";
import {
  optionalString,
  parseJsonRequest,
  RequestValidationError,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { fetchActiveTaskIdsByShip } from "../_shared/tasks.ts";
import { traced } from "../_shared/weave.ts";

type ByoaAction = "claim" | "clear" | "set" | "list";
type ByoaMode = "private";

const VALID_ACTIONS: readonly ByoaAction[] = ["claim", "clear", "set", "list"];
const VALID_MODES: readonly ByoaMode[] = ["private"];

const SOURCE_URL_PATTERN = /^https?:\/\//;
const SOURCE_URL_MAX_LENGTH = 4096;
const WAKE_SECRET_MAX_LENGTH = 256;

Deno.serve(traced("ship_byoa_configure", async (req, trace) => {
  let user;
  try {
    user = await getAuthenticatedUser(req);
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : "Authentication failed",
      401,
    );
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) return response;
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterId = requireString(payload, "character_id");
    const actionRaw = requireString(payload, "action");
    const modeRaw = optionalString(payload, "mode");
    const wakeSecretProvided = Object.prototype.hasOwnProperty.call(
      payload,
      "wake_secret",
    );
    const sourceUrlProvided = Object.prototype.hasOwnProperty.call(
      payload,
      "source_url",
    );
    const wakeSecretRaw = wakeSecretProvided ? payload.wake_secret : undefined;
    const sourceUrlRaw = sourceUrlProvided ? payload.source_url : undefined;

    const { data: ownsCharacter, error: ownsErr } = await supabase.rpc(
      "can_user_access_character",
      { p_user_id: user.id, p_character_id: characterId },
    );
    if (ownsErr) {
      console.error("ship_byoa_configure.ownership_rpc", ownsErr);
      return errorResponse("Failed to verify character ownership", 500);
    }
    if (ownsCharacter !== true) {
      return errorResponse("forbidden", 403);
    }

    if (!VALID_ACTIONS.includes(actionRaw as ByoaAction)) {
      throw new RequestValidationError(
        `action must be one of ${VALID_ACTIONS.join(", ")}`,
        400,
      );
    }
    const action = actionRaw as ByoaAction;

    // ----- list ----- (no ship_id required)
    if (action === "list") {
      trace.setInput({ characterId, action, requestId });
      const ships = await listClaimableShipsForCharacter(supabase, characterId);
      trace.setOutput({ count: ships.length, action });
      return successResponse({ action, ships, request_id: requestId });
    }

    const shipId = requireString(payload, "ship_id");
    if (!validateUuid(shipId)) {
      throw new RequestValidationError("ship_id must be a UUID", 400);
    }

    let mode: ByoaMode | null = null;
    if (modeRaw !== null && modeRaw !== undefined) {
      if (!VALID_MODES.includes(modeRaw as ByoaMode)) {
        throw new RequestValidationError(
          `mode must be one of ${VALID_MODES.join(", ")}`,
          400,
        );
      }
      mode = modeRaw as ByoaMode;
    }

    if (action === "claim" && mode === null) {
      // Default new BYOA claims to private — the more conservative choice.
      mode = "private";
    }
    trace.setInput({ characterId, shipId, action, mode, requestId });

    // Load ship + current BYOA state.
    const { data: shipRow, error: shipErr } = await supabase
      .from("ship_instances")
      .select(
        "ship_id, ship_name, owner_type, owner_corporation_id, byoa_owner_character_id, byoa_mode",
      )
      .eq("ship_id", shipId)
      .maybeSingle();

    if (shipErr) {
      console.error("ship_byoa_configure.ship_lookup", shipErr);
      return errorResponse("Failed to load ship", 500);
    }
    if (!shipRow) {
      return errorResponse("ship_not_found", 404);
    }
    if (shipRow.owner_type !== "corporation") {
      return errorResponse(
        "BYOA can only be configured on corporation ships",
        400,
      );
    }
    const corpId = shipRow.owner_corporation_id as string | null;
    if (!corpId) {
      return errorResponse("Corp ship has no owning corporation", 500);
    }

    // Membership check — caller must be a member of the ship's corp.
    const { data: membership, error: memErr } = await supabase
      .from("corporation_members")
      .select("corp_id")
      .eq("character_id", characterId)
      .eq("corp_id", corpId)
      .is("left_at", null)
      .maybeSingle();
    if (memErr) {
      console.error("ship_byoa_configure.member_lookup", memErr);
      return errorResponse("Failed to verify corp membership", 500);
    }
    if (!membership) {
      return errorResponse(
        "Only corp members can configure BYOA on this ship",
        403,
      );
    }

    // ----- set -----
    // Owner-only wake config write. Doesn't touch ownership/mode, so the
    // active-task guard below is skipped — rotating a wake secret mid-task
    // is the supported recovery path when a daemon's secret leaks.
    if (action === "set") {
      const currentOwner =
        typeof shipRow.byoa_owner_character_id === "string"
          ? (shipRow.byoa_owner_character_id as string)
          : null;
      if (currentOwner !== characterId) {
        return errorResponse(
          "Only the current BYOA owner can set wake config",
          403,
        );
      }
      if (!wakeSecretProvided && !sourceUrlProvided) {
        throw new RequestValidationError(
          "set requires at least one of wake_secret or source_url",
          400,
        );
      }
      let wakeSecret: string | null = null;
      if (wakeSecretProvided) {
        if (wakeSecretRaw !== null && typeof wakeSecretRaw !== "string") {
          throw new RequestValidationError(
            "wake_secret must be a string or null",
            400,
          );
        }
        if (typeof wakeSecretRaw === "string") {
          if (
            wakeSecretRaw.length === 0 ||
            wakeSecretRaw.length > WAKE_SECRET_MAX_LENGTH
          ) {
            throw new RequestValidationError(
              `wake_secret length must be 1..${WAKE_SECRET_MAX_LENGTH}`,
              400,
            );
          }
          wakeSecret = wakeSecretRaw;
        }
      }
      let sourceUrl: string | null = null;
      if (sourceUrlProvided) {
        if (sourceUrlRaw !== null && typeof sourceUrlRaw !== "string") {
          throw new RequestValidationError(
            "source_url must be a string or null",
            400,
          );
        }
        if (typeof sourceUrlRaw === "string") {
          if (
            !SOURCE_URL_PATTERN.test(sourceUrlRaw) ||
            sourceUrlRaw.length > SOURCE_URL_MAX_LENGTH
          ) {
            throw new RequestValidationError(
              "source_url must be http(s):// and ≤ 4096 chars",
              400,
            );
          }
          sourceUrl = sourceUrlRaw;
        }
      }

      const { error: setErr } = await supabase.rpc(
        "set_ship_byoa_wake_config",
        {
          p_ship_id: shipId,
          p_wake_secret: wakeSecret,
          p_source_url: sourceUrl,
          p_update_wake_secret: wakeSecretProvided,
          p_update_source_url: sourceUrlProvided,
        },
      );
      if (setErr) {
        console.error("ship_byoa_configure.set_error", setErr);
        return errorResponse("Failed to update wake config", 500);
      }

      // Operator-private confirmation — corp-wide fan-out would leak the
      // operator's source_url to every corp member. Wake_secret stays
      // server-side; surface only its presence and a truncated source_url.
      const setEventPayload: Record<string, unknown> = {
        source: buildEventSource("ship_byoa_configure", requestId),
        ship_id: shipId,
        ship_name: shipRow.ship_name ?? null,
        corp_id: corpId,
        action,
        wake_secret_updated: wakeSecretProvided,
        source_url_updated: sourceUrlProvided,
        actor_character_id: characterId,
      };
      await emitCharacterEvent({
        supabase,
        characterId,
        eventType: "ship.byoa_configured",
        payload: setEventPayload,
        requestId,
        actorCharacterId: characterId,
      });

      trace.setOutput({
        request_id: requestId,
        ship_id: shipId,
        action,
        wake_secret_updated: wakeSecretProvided,
        source_url_updated: sourceUrlProvided,
      });
      return successResponse({
        request_id: requestId,
        ship_id: shipId,
        action,
        wake_secret_updated: wakeSecretProvided,
        source_url_updated: sourceUrlProvided,
      });
    }

    // Best-effort active-task guard — no BYOA changes while a task appears
    // to be in flight on this ship. Toggling ownership mid-task would create
    // ambiguity about who's running the active task. Inferred from recent
    // task.start events without a matching task.finish/task.cancel; not an
    // atomic mutex.
    const activeTasks = await fetchActiveTaskIdsByShip(supabase, [shipId]);
    const activeTaskId = activeTasks.get(shipId) ?? null;
    if (activeTaskId !== null) {
      return new Response(
        JSON.stringify({
          error: "ship_busy",
          ship_id: shipId,
          current_task_id: activeTaskId,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const currentOwner = typeof shipRow.byoa_owner_character_id === "string"
      ? (shipRow.byoa_owner_character_id as string)
      : null;
    const currentMode: ByoaMode = "private";

    // Action-specific authorization + state transition.
    let nextOwner: string | null;
    let nextMode: ByoaMode;

    if (action === "claim") {
      // Self-only claim: you can only claim for yourself.
      if (currentOwner && currentOwner !== characterId) {
        return errorResponse(
          "BYOA already claimed by another corp member",
          409,
        );
      }
      nextOwner = characterId;
      nextMode = mode ?? "private";
    } else {
      // clear
      if (!currentOwner) {
        // Already cleared — idempotent success.
        return successResponse({
          request_id: requestId,
          ship_id: shipId,
          byoa_owner_character_id: null,
          byoa_mode: "private",
          changed: false,
        });
      }
      if (currentOwner !== characterId) {
        return errorResponse(
          "Only the current BYOA owner can clear BYOA",
          403,
        );
      }
      nextOwner = null;
      nextMode = "private";
    }

    const changed = currentOwner !== nextOwner || currentMode !== nextMode;

    if (changed) {
      const updatePayload = {
        byoa_owner_character_id: nextOwner,
        byoa_mode: nextMode,
      };
      const baseUpdate = supabase
        .from("ship_instances")
        .update(updatePayload)
        .eq("ship_id", shipId)
        .eq("owner_type", "corporation")
        .eq("owner_corporation_id", corpId)
        .eq("byoa_mode", currentMode);

      const { data: updatedRow, error: updateErr } = currentOwner
        ? await baseUpdate
          .eq("byoa_owner_character_id", currentOwner)
          .select("ship_id")
          .maybeSingle()
        : await baseUpdate
          .is("byoa_owner_character_id", null)
          .select("ship_id")
          .maybeSingle();

      if (updateErr) {
        console.error("ship_byoa_configure.update_error", updateErr);
        return errorResponse("Failed to update BYOA configuration", 500);
      }
      if (!updatedRow) {
        return errorResponse("BYOA configuration changed; retry", 409);
      }
    }

    // Emit a corp-scoped event so all corp members see the BYOA state change.
    const eventPayload: Record<string, unknown> = {
      source: buildEventSource("ship_byoa_configure", requestId),
      ship_id: shipId,
      ship_name: shipRow.ship_name ?? null,
      corp_id: corpId,
      action,
      byoa_owner_character_id: nextOwner,
      byoa_mode: nextMode,
      changed,
      actor_character_id: characterId,
    };

    if (changed) {
      await emitCorporationEvent(supabase, corpId, {
        eventType: "ship.byoa_configured",
        payload: eventPayload,
        requestId,
        actorCharacterId: characterId,
      });
    } else {
      // No-op claim/clear — still tell the caller things are consistent
      // but don't fan out a corp-wide event for nothing.
      await emitCharacterEvent({
        supabase,
        characterId,
        eventType: "ship.byoa_configured",
        payload: eventPayload,
        requestId,
        actorCharacterId: characterId,
      });
    }

    trace.setOutput({
      request_id: requestId,
      ship_id: shipId,
      action,
      changed,
    });
    return successResponse({
      request_id: requestId,
      ship_id: shipId,
      byoa_owner_character_id: nextOwner,
      byoa_mode: nextMode,
      changed,
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) return validationResponse;
    console.error("ship_byoa_configure.error", err);
    return errorResponse(
      err instanceof Error ? err.message : "ship byoa configure failed",
      500,
    );
  }
}));

interface ClaimableShip {
  ship_id: string;
  name: string;
  sector: number | null;
  byoa_owner_character_id_prefix: string | null;
  claimable_by_me: boolean;
}

/**
 * Return the operator's corp ships, shaped for the BYOA picker. Caller
 * authorization (JWT → character_id) is enforced by the caller before
 * invoking this. We never surface the full BYOA owner UUID; only a 12-char
 * prefix consistent with the rest of the API.
 */
async function listClaimableShipsForCharacter(
  supabase: ReturnType<typeof createServiceRoleClient>,
  characterId: string,
): Promise<ClaimableShip[]> {
  const { data: character, error: charErr } = await supabase
    .from("characters")
    .select("corporation_id")
    .eq("character_id", characterId)
    .maybeSingle();
  if (charErr) {
    console.error("ship_byoa_configure.list.character", charErr);
    throw new Error("Failed to load character");
  }
  const corpId = character?.corporation_id as string | undefined | null;
  if (!corpId) return [];

  const { data: shipLinks, error: linkErr } = await supabase
    .from("corporation_ships")
    .select("ship_id")
    .eq("corp_id", corpId);
  if (linkErr) {
    console.error("ship_byoa_configure.list.ship_links", linkErr);
    throw new Error("Failed to load corp ships");
  }
  const shipIds = (shipLinks ?? [])
    .map((row) => row?.ship_id)
    .filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  if (!shipIds.length) return [];

  const { data: shipRows, error: shipErr } = await supabase
    .from("ship_instances")
    .select("ship_id, ship_name, current_sector, byoa_owner_character_id")
    .in("ship_id", shipIds)
    .neq("owner_type", "unowned")
    .is("destroyed_at", null);
  if (shipErr) {
    console.error("ship_byoa_configure.list.ships", shipErr);
    throw new Error("Failed to load ship instances");
  }

  return (shipRows ?? []).map((row): ClaimableShip => {
    const ownerId = (row?.byoa_owner_character_id as string | null) ?? null;
    return {
      ship_id: row.ship_id as string,
      name: typeof row.ship_name === "string" && row.ship_name.length > 0
        ? row.ship_name
        : (row.ship_id as string),
      sector: typeof row.current_sector === "number" ? row.current_sector : null,
      byoa_owner_character_id_prefix: ownerId
        ? ownerId.replace(/-/g, "").slice(0, 12)
        : null,
      claimable_by_me: ownerId === null || ownerId === characterId,
    };
  });
}
