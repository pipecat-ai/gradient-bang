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
import { traced } from "../_shared/weave.ts";

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

Deno.serve(traced("user_character_list", async (req, trace) => {
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
  const sRateLimit = trace.span("rate_limit");
  try {
    await enforcePublicRateLimit(supabase, req, "character_list");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      console.warn("character_list.rate_limit", err.message);
      return corsResponse(
        { success: false, error: "Too many requests. Please try again later." },
        429,
      );
    }
    console.error("character_list.rate_limit", err);
  }

  trace.setInput({ user_id: user.id });

  try {
    // Query user's characters via junction table with basic ship info
    const sQuery = trace.span("query_characters");
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
      sQuery.end({ error: charactersError.message });
      console.error("character_list.query", charactersError);
      return corsResponse(
        { success: false, error: "Failed to load characters" },
        500,
      );
    }
    sQuery.end({ count: (userCharacters || []).length });

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

    // Fetch event memberships for all characters
    const sEvents = trace.span("fetch_event_memberships");
    const characterIds = formattedCharacters.map(
      (c: { character_id: string }) => c.character_id,
    );
    const { data: eventMemberships } = await supabase
      .from("world_event_participants")
      .select(
        "character_id, event_id, world_events!inner(event_id, title, ends_at, visible_until)",
      )
      .in("character_id", characterIds)
      .gt("world_events.visible_until", new Date().toISOString());

    // Build character_id -> event map
    const eventMap = new Map<
      string,
      { event_id: string; title: string }
    >();
    for (const mem of eventMemberships ?? []) {
      const ev = mem.world_events as any;
      eventMap.set(mem.character_id, {
        event_id: ev.event_id,
        title: ev.title,
      });
    }
    sEvents.end({ count: eventMap.size });

    // Attach event info to each character
    const enrichedCharacters = formattedCharacters.map(
      (c: { character_id: string }) => ({
        ...c,
        event: eventMap.get(c.character_id) ?? null,
      }),
    );

    trace.setOutput({ count: enrichedCharacters.length });
    return corsResponse(
      {
        success: true,
        characters: enrichedCharacters,
        count: enrichedCharacters.length,
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
}));
