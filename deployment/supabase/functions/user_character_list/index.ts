/**
 * Public Edge Function: character_list
 *
 * Returns list of characters owned by the authenticated user.
 * Requires valid Supabase Auth JWT.
 * Includes basic character stats for character selection screen.
 */

import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import {
  getAuthenticatedUser,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  enforcePublicRateLimit,
  RateLimitError,
} from "../_shared/rate_limiting.ts";
import { parseJsonRequest, respondWithError } from "../_shared/request.ts";

// CORS headers for public access from web clients
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    console.error("character_list.auth", err);
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Authentication failed",
      },
      401,
    );
  }

  // Apply rate limiting (per user)
  try {
    await enforcePublicRateLimit(supabase, req, "character_list");
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn("character_list.rate_limit", err.message);
      return corsResponse(
        { success: false, error: "Too many requests. Please try again later." },
        429,
      );
    }
    console.error("character_list.rate_limit", err);
  }

  try {
    // Query user's characters via junction table with basic ship info
    const { data: userCharacters, error: charactersError } = await supabase
      .from("user_characters")
      .select(
        `
        character_id,
        characters!inner (
          character_id,
          name,
          created_at,
          last_active,
          credits_in_megabank,
          is_npc,
          current_ship_id,
          ship_instances!characters_current_ship_id_fkey (
            ship_id,
            ship_type,
            ship_name,
            current_sector,
            credits,
            current_warp_power,
            current_shields,
            current_fighters,
            cargo_qf,
            cargo_ro,
            cargo_ns
          )
        )
      `,
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (charactersError) {
      console.error("character_list.query", charactersError);
      return corsResponse(
        { success: false, error: "Failed to load characters" },
        500,
      );
    }

    // Transform data for cleaner response
    const formattedCharacters = (userCharacters || []).map((uc: any) => {
      const char = uc.characters;
      const ship = Array.isArray(char.ship_instances)
        ? char.ship_instances[0]
        : char.ship_instances;

      return {
        character_id: char.character_id,
        name: char.name,
        created_at: char.created_at,
        last_active: char.last_active,
        credits_in_bank: char.credits_in_megabank,
        ship: ship
          ? {
              ship_id: ship.ship_id,
              ship_type: ship.ship_type,
              ship_name: ship.ship_name,
              current_sector: ship.current_sector,
              credits: ship.credits,
              resources: {
                warp_power: ship.current_warp_power,
                shields: ship.current_shields,
                fighters: ship.current_fighters,
              },
              cargo: {
                quantum_foam: ship.cargo_qf,
                retro_organics: ship.cargo_ro,
                neuro_symbolics: ship.cargo_ns,
              },
            }
          : null,
      };
    });

    return corsResponse(
      {
        success: true,
        characters: formattedCharacters,
        count: formattedCharacters.length,
      },
      200,
    );
  } catch (err) {
    console.error("character_list.unhandled", err);
    return corsResponse(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});
