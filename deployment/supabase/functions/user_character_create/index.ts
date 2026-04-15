/**
 * Public Edge Function: character_create
 *
 * Creates a new character for an authenticated user.
 * Requires verified email and valid Supabase Auth JWT.
 * Enforces character limit per user (max 5).
 * Returns character_id and game JWT for play.
 */

import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import {
  getAuthenticatedUser,
  requireEmailVerified,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  enforcePublicRateLimit,
  RateLimitError,
} from "../_shared/rate_limiting.ts";
import {
  parseJsonRequest,
  requireString,
  respondWithError,
  RequestValidationError,
} from "../_shared/request.ts";
import {
  loadUniverseMeta,
  pickSpawnSector,
} from "../_shared/fedspace.ts";
import {
  validateDisplayName,
  NameValidationError,
} from "../_shared/name_validation.ts";
import { traced } from "../_shared/weave.ts";

const DEFAULT_SHIP_TYPE = "sparrow_scout";
const DEFAULT_CREDITS = 12000;
const MAX_CHARACTERS_PER_USER = 5;

// CORS headers for public access from web clients
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

interface ShipDefinitionRow {
  ship_type: string;
  warp_power_capacity: number;
  shields: number;
  fighters: number;
}

class CharacterCreateError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "CharacterCreateError";
    this.status = status;
  }
}

Deno.serve(traced("user_character_create", async (req, trace) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabase = createServiceRoleClient();

  // Authenticate user from JWT
  const sAuth = trace.span("auth_check");
  let user;
  try {
    user = await getAuthenticatedUser(req);
    sAuth.end({ user_id: user.id });
  } catch (err) {
    sAuth.end({ error: err instanceof Error ? err.message : String(err) });
    console.error("character_create.auth", err);
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Authentication failed",
      },
      401,
    );
  }

  // Verify email is confirmed
  const sEmailVerify = trace.span("email_verification");
  try {
    requireEmailVerified(user);
    sEmailVerify.end();
  } catch (err) {
    sEmailVerify.end({ error: err instanceof Error ? err.message : String(err) });
    console.error("character_create.email_verification", err);
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Email not verified",
      },
      403,
    );
  }

  // Apply rate limiting (per user)
  const sRateLimit = trace.span("rate_limit");
  try {
    await enforcePublicRateLimit(supabase, req, "character_create");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      console.warn("character_create.rate_limit", err.message);
      return corsResponse(
        { success: false, error: "Too many requests. Please try again later." },
        429,
      );
    }
    console.error("character_create.rate_limit", err);
  }

  let payload;
  const sParse = trace.span("parse_request");
  try {
    payload = await parseJsonRequest(req);
    sParse.end();
  } catch (err) {
    sParse.end({ error: err instanceof Error ? err.message : String(err) });
    const response = respondWithError(err);
    if (response) {
      return corsResponse(await response.json(), response.status);
    }
    console.error("character_create.parse", err);
    return corsResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  try {
    // Parse and validate request
    const sValidate = trace.span("validate_input");
    const rawName = requireString(payload, "name");
    const name = validateDisplayName(rawName, "character");

    trace.setInput({ user_id: user.id, name });
    sValidate.end({ name });

    // Check character limit for this user via junction table
    const sCountCheck = trace.span("check_character_limit");
    const { count, error: countError } = await supabase
      .from("user_characters")
      .select("character_id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      sCountCheck.end({ error: countError.message });
      console.error("character_create.count_check", countError);
      throw new CharacterCreateError("Failed to check character limit", 500);
    }

    if (count !== null && count >= MAX_CHARACTERS_PER_USER) {
      sCountCheck.end({ error: "Limit reached", count });
      throw new CharacterCreateError(
        `You have reached the maximum number of characters (${MAX_CHARACTERS_PER_USER})`,
        400,
      );
    }
    sCountCheck.end({ count });

    // Check name uniqueness (globally unique)
    const sNameCheck = trace.span("check_name_uniqueness");
    const existingCharacter = await supabase
      .from("characters")
      .select("character_id")
      .eq("name", name)
      .maybeSingle();

    if (existingCharacter.error) {
      sNameCheck.end({ error: existingCharacter.error.message });
      console.error("character_create.name_check", existingCharacter.error);
      throw new CharacterCreateError("Failed to check character name", 500);
    }

    if (existingCharacter.data) {
      sNameCheck.end({ error: "Name taken" });
      throw new CharacterCreateError(
        `Character name "${name}" is already taken`,
        409,
      );
    }
    sNameCheck.end();

    // Get ship definition
    const sShipDef = trace.span("load_ship_definition");
    const { data: shipDefinition, error: shipDefError } = await supabase
      .from("ship_definitions")
      .select("ship_type, warp_power_capacity, shields, fighters")
      .eq("ship_type", DEFAULT_SHIP_TYPE)
      .maybeSingle();

    if (shipDefError || !shipDefinition) {
      sShipDef.end({ error: shipDefError?.message ?? "Not found" });
      console.error("character_create.ship_definition", shipDefError);
      throw new CharacterCreateError(
        `Invalid ship type: ${DEFAULT_SHIP_TYPE}`,
        500,
      );
    }
    sShipDef.end({ ship_type: DEFAULT_SHIP_TYPE });

    // Create character (without user link yet)
    const sCreateChar = trace.span("create_character");
    const { data: character, error: characterError } = await supabase
      .from("characters")
      .insert({
        name,
        current_ship_id: null,
        map_knowledge: {
          sectors_visited: {},
          total_sectors_visited: 0,
        },
        is_npc: false,
      })
      .select("character_id")
      .single();

    if (characterError || !character) {
      sCreateChar.end({ error: characterError?.message ?? "No data" });
      console.error("character_create.character_insert", characterError);
      throw new CharacterCreateError("Failed to create character", 500);
    }
    sCreateChar.end({ character_id: character.character_id });

    const characterId = character.character_id;

    const universeMeta = await loadUniverseMeta(supabase);
    const startSector = await pickSpawnSector(supabase, universeMeta);

    // Create ship for character
    const sCreateShip = trace.span("create_ship");
    const { data: ship, error: shipError } = await supabase
      .from("ship_instances")
      .insert({
        owner_id: characterId,
        owner_type: "character",
        owner_character_id: characterId,
        owner_corporation_id: null,
        ship_type: DEFAULT_SHIP_TYPE,
        ship_name: null,
        current_sector: startSector,
        credits: DEFAULT_CREDITS,
        cargo_qf: 0,
        cargo_ro: 0,
        cargo_ns: 0,
        current_warp_power: shipDefinition.warp_power_capacity,
        current_shields: shipDefinition.shields,
        current_fighters: shipDefinition.fighters,
      })
      .select("ship_id")
      .single();

    if (shipError || !ship) {
      sCreateShip.end({ error: shipError?.message ?? "No data" });
      console.error("character_create.ship_insert", shipError);
      // Clean up character if ship creation fails
      await supabase
        .from("characters")
        .delete()
        .eq("character_id", characterId);
      throw new CharacterCreateError("Failed to create ship", 500);
    }
    sCreateShip.end({ ship_id: ship.ship_id });

    // Update character with ship reference
    const sLinkShip = trace.span("link_ship_to_character");
    const { error: updateError } = await supabase
      .from("characters")
      .update({ current_ship_id: ship.ship_id })
      .eq("character_id", characterId);

    if (updateError) {
      sLinkShip.end({ error: updateError.message });
      console.error("character_create.character_update", updateError);
      // Clean up on failure
      await supabase
        .from("ship_instances")
        .delete()
        .eq("ship_id", ship.ship_id);
      await supabase
        .from("characters")
        .delete()
        .eq("character_id", characterId);
      throw new CharacterCreateError("Failed to link ship to character", 500);
    }
    sLinkShip.end();

    // Link character to user via junction table
    const sLinkUser = trace.span("link_character_to_user");
    const { error: linkError } = await supabase.from("user_characters").insert({
      user_id: user.id,
      character_id: characterId,
    });

    if (linkError) {
      sLinkUser.end({ error: linkError.message });
      console.error("character_create.user_link", linkError);
      // Clean up on failure
      await supabase
        .from("ship_instances")
        .delete()
        .eq("ship_id", ship.ship_id);
      await supabase
        .from("characters")
        .delete()
        .eq("character_id", characterId);
      throw new CharacterCreateError("Failed to link character to user", 500);
    }
    sLinkUser.end();

    // Assign quests marked as assign_on_creation (e.g. tutorial)
    const sQuests = trace.span("assign_quests");
    const { data: autoQuests } = await supabase
      .from("quest_definitions")
      .select("code")
      .eq("assign_on_creation", true)
      .eq("enabled", true);

    if (autoQuests) {
      for (const quest of autoQuests) {
        await supabase.rpc("assign_quest", {
          p_player_id: characterId,
          p_quest_code: quest.code,
        });
      }
    }
    sQuests.end({ count: autoQuests?.length ?? 0 });

    // Return success response
    trace.setOutput({ character_id: characterId, ship_id: ship.ship_id, name });
    return corsResponse(
      {
        success: true,
        character_id: characterId,
        name,
        ship: {
          ship_id: ship.ship_id,
          ship_type: DEFAULT_SHIP_TYPE,
          current_sector: startSector,
          credits: DEFAULT_CREDITS,
        },
      },
      201,
    );
  } catch (err) {
    if (err instanceof NameValidationError) {
      return corsResponse(
        { success: false, error: err.message, code: err.code },
        err.status,
      );
    }
    if (err instanceof CharacterCreateError) {
      return corsResponse({ success: false, error: err.message }, err.status);
    }
    if (err instanceof RequestValidationError) {
      return corsResponse({ success: false, error: err.message }, err.status);
    }
    console.error("character_create.unhandled", err);
    return corsResponse(
      { success: false, error: "Internal server error" },
      500,
    );
  }
}));
