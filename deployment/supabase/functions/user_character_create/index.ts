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
  pickRandomFedspaceSector,
} from "../_shared/fedspace.ts";

const DEFAULT_START_SECTOR = 0;
const DEFAULT_SHIP_TYPE = "kestrel_courier";
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

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabase = createServiceRoleClient();

  // Authenticate user from JWT
  let user;
  try {
    user = await getAuthenticatedUser(req);
  } catch (err) {
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
  try {
    requireEmailVerified(user);
  } catch (err) {
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
  try {
    await enforcePublicRateLimit(supabase, req, "character_create");
  } catch (err) {
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
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return corsResponse(await response.json(), response.status);
    }
    console.error("character_create.parse", err);
    return corsResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  try {
    // Parse and validate request
    const name = requireString(payload, "name");

    // Validate name format (alphanumeric, underscores, spaces, 3-20 chars)
    if (!/^[a-zA-Z0-9_ ]{3,20}$/.test(name)) {
      throw new CharacterCreateError(
        "Character name must be 3-20 characters, alphanumeric, underscores, and spaces only",
        400,
      );
    }

    // Check character limit for this user via junction table
    const { count, error: countError } = await supabase
      .from("user_characters")
      .select("character_id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      console.error("character_create.count_check", countError);
      throw new CharacterCreateError("Failed to check character limit", 500);
    }

    if (count !== null && count >= MAX_CHARACTERS_PER_USER) {
      throw new CharacterCreateError(
        `You have reached the maximum number of characters (${MAX_CHARACTERS_PER_USER})`,
        400,
      );
    }

    // Check name uniqueness (globally unique)
    const existingCharacter = await supabase
      .from("characters")
      .select("character_id")
      .eq("name", name)
      .maybeSingle();

    if (existingCharacter.error) {
      console.error("character_create.name_check", existingCharacter.error);
      throw new CharacterCreateError("Failed to check character name", 500);
    }

    if (existingCharacter.data) {
      throw new CharacterCreateError(
        `Character name "${name}" is already taken`,
        409,
      );
    }

    // Get ship definition
    const { data: shipDefinition, error: shipDefError } = await supabase
      .from("ship_definitions")
      .select("ship_type, warp_power_capacity, shields, fighters")
      .eq("ship_type", DEFAULT_SHIP_TYPE)
      .maybeSingle();

    if (shipDefError || !shipDefinition) {
      console.error("character_create.ship_definition", shipDefError);
      throw new CharacterCreateError(
        `Invalid ship type: ${DEFAULT_SHIP_TYPE}`,
        500,
      );
    }

    // Create character (without user link yet)
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
      console.error("character_create.character_insert", characterError);
      throw new CharacterCreateError("Failed to create character", 500);
    }

    const characterId = character.character_id;

    const universeMeta = await loadUniverseMeta(supabase);
    const startSector = pickRandomFedspaceSector(
      universeMeta,
      DEFAULT_START_SECTOR,
    );

    // Create ship for character
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
      console.error("character_create.ship_insert", shipError);
      // Clean up character if ship creation fails
      await supabase
        .from("characters")
        .delete()
        .eq("character_id", characterId);
      throw new CharacterCreateError("Failed to create ship", 500);
    }

    // Update character with ship reference
    const { error: updateError } = await supabase
      .from("characters")
      .update({ current_ship_id: ship.ship_id })
      .eq("character_id", characterId);

    if (updateError) {
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

    // Link character to user via junction table
    const { error: linkError } = await supabase.from("user_characters").insert({
      user_id: user.id,
      character_id: characterId,
    });

    if (linkError) {
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

    // Assign quests marked as assign_on_creation (e.g. tutorial)
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

    // Return success response
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
});
