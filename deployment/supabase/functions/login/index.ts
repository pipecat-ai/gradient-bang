/**
 * Public Edge Function: login
 *
 * Authenticates user with email and password.
 * Returns auth session JWT and list of user's characters.
 * No EDGE_API_TOKEN required - this is a public endpoint.
 */

import {
  createPublicClient,
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
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

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

Deno.serve(traced("login", async (req, trace) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const serviceClient = createServiceRoleClient();

  // Apply IP-based rate limiting
  const sRateLimit = trace.span("rate_limit");
  try {
    await enforcePublicRateLimit(serviceClient, req, "login");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      console.warn("login.rate_limit", err.message);
      return corsResponse(
        {
          success: false,
          error: "Too many login attempts. Please try again later.",
        },
        429,
      );
    }
    console.error("login.rate_limit", err);
    return corsResponse(
      { success: false, error: "Rate limit check failed" },
      500,
    );
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
    console.error("login.parse", err);
    return corsResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  try {
    // Parse and validate request
    const email = requireString(payload, "email");
    const password = requireString(payload, "password");

    trace.setInput({});

    // Create Supabase auth client (public)
    const publicClient = createPublicClient();

    // Sign in user with Supabase Auth
    const sSignin = trace.span("auth_signin");
    const { data, error } = await publicClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      sSignin.end({ error: error.message });
      console.error("login.signin", error);
      return corsResponse(
        { success: false, error: "Invalid email or password" },
        401,
      );
    }

    if (!data.user || !data.session) {
      sSignin.end({ error: "Authentication failed" });
      return corsResponse(
        { success: false, error: "Authentication failed" },
        401,
      );
    }
    sSignin.end({ user_id: data.user.id });

    // Check if email is confirmed
    const emailConfirmed = !!data.user.email_confirmed_at;

    // Query user's characters using service role client via junction table
    const sCharacters = trace.span("query_characters");
    const { data: characters, error: charactersError } = await serviceClient
      .from("user_characters")
      .select(
        `
        character_id,
        characters!inner (
          character_id,
          name,
          created_at,
          last_active,
          is_npc
        )
      `,
      )
      .eq("user_id", data.user.id)
      .order("created_at", { ascending: false });

    if (charactersError) {
      console.error("login.characters", charactersError);
      sCharacters.end({ error: charactersError.message });
      // Don't fail login if character query fails, just return empty list
    } else {
      sCharacters.end({ count: (characters || []).length });
    }

    // Transform the junction table result to flat character list
    const characterList = (characters || []).map((uc: any) => {
      const fv = uc.characters.created_at ? new Date(uc.characters.created_at).getTime() : 0;
      const la = uc.characters.last_active ? new Date(uc.characters.last_active).getTime() : 0;
      return {
        character_id: uc.characters.character_id,
        name: uc.characters.name,
        created_at: uc.characters.created_at,
        last_active: uc.characters.last_active,
        is_npc: uc.characters.is_npc,
        is_first_visit: fv > 0 && Math.abs(la - fv) < 180_000,
      };
    });

    trace.setOutput({ user_id: data.user.id, character_count: characterList.length });
    return corsResponse(
      {
        success: true,
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          expires_in: data.session.expires_in,
        },
        user: {
          id: data.user.id,
          email: data.user.email,
          email_confirmed: emailConfirmed,
        },
        characters: characterList,
      },
      200,
    );
  } catch (err) {
    console.error("login.unhandled", err);
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      500,
    );
  }
}));
