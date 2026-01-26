/**
 * Public Edge Function: sessions
 *
 * Proxy function for bot service endpoints.
 * Requires valid Supabase Auth JWT.
 * Supports routing to different bot endpoints via URL path.
 *
 * Endpoints:
 * - /start: POST only, requires character_id in body.character_id, verifies ownership (creates new session)
 * - /start/{id} and /start/{id}/*: All HTTP methods supported, proxies to bot `/sessions/{id}/*`
 *   Examples:
 *   - /start/{id}          -> BOT_START_URL base + /sessions/{id}
 *   - /start/{id}/status   -> BOT_START_URL base + /sessions/{id}/status
 *
 * Optional: Adds BOT_START_API_KEY as Bearer token if configured.
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
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
  // Check for required environment variable
  const botStartUrl =
    Deno.env.get("BOT_START_URL") || "http://host.docker.internal:7860/start";

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Parse action from URL path
  const url = new URL(req.url);
  const pathname = url.pathname;

  let action: string;
  // Check if this is a session-specific request (has session ID after /start/)
  // e.g., /start/{uuid} or /start/{uuid}/api/offer
  if (pathname.match(/\/start\/[^/]+(\/.*)?$/)) {
    action = "proxy_session";
  } else if (pathname.endsWith("/start") || pathname === "/") {
    // Creating a new session - requires character validation
    action = "create_session";
  } else {
    // Invalid path
    return corsResponse(
      { success: false, error: "Invalid endpoint path" },
      404,
    );
  }

  // Only enforce POST for "create_session" action
  if (action === "create_session" && req.method !== "POST") {
    return corsResponse(
      { success: false, error: "Creating a session requires POST method" },
      405,
    );
  }

  // Allow all methods for "proxy_session" action (no method restriction)

  const supabase = createServiceRoleClient();

  // Authenticate user from JWT
  let user;
  try {
    user = await getAuthenticatedUser(req);
  } catch (err) {
    console.error("start.auth", err);
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
    await enforcePublicRateLimit(supabase, req, "start");
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn("start.rate_limit", err.message);
      return corsResponse(
        { success: false, error: "Too many requests. Please try again later." },
        429,
      );
    }
    console.error("start.rate_limit", err);
  }

  try {
    // Parse request body (only for methods that support body)
    let requestData = null;
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      try {
        const body = await parseJsonRequest(req);
        requestData = body;
      } catch (err) {
        console.error("start.parse_request", err);
        return corsResponse(
          { success: false, error: "Invalid request body" },
          400,
        );
      }
    }

    // Determine bot endpoint and perform action-specific validation
    let botEndpoint: string;

    if (action === "create_session") {
      // Creating a new session - send to /start endpoint on bot
      botEndpoint = botStartUrl.endsWith("/start")
        ? botStartUrl
        : `${botStartUrl}/start`;

      // Extract character_id from nested body object
      const characterId = requestData?.body?.character_id;

      // Validate required field for creating session
      if (!characterId || typeof characterId !== "string") {
        return corsResponse(
          {
            success: false,
            error:
              "character_id is required in body.character_id to create session",
          },
          400,
        );
      }

      // Verify character belongs to authenticated user via junction table
      const { data: characterData, error: characterError } = await supabase
        .from("user_characters")
        .select("character_id")
        .eq("user_id", user.id)
        .eq("character_id", characterId)
        .maybeSingle();

      if (characterError) {
        console.error("start.character_lookup", characterError);
        return corsResponse(
          { success: false, error: "Failed to verify character ownership" },
          500,
        );
      }

      if (!characterData) {
        return corsResponse(
          {
            success: false,
            error: "Character not found or does not belong to user",
          },
          404,
        );
      }
    } else if (action === "proxy_session") {
      // Proxying to existing session - forward as /sessions/{id} on bot
      // e.g., /functions/v1/start/abc/api/offer -> http://bot/sessions/abc/api/offer
      const pathMatch = pathname.match(/^\/start\/([^/]+)(\/.*)?$/);
      if (pathMatch) {
        const sessionId = pathMatch[1];
        const rest = pathMatch[2] ?? "";
        const baseUrl = botStartUrl.replace(/\/start$/, "");
        botEndpoint = `${baseUrl}/sessions/${sessionId}${rest}`;
      } else {
        return corsResponse(
          { success: false, error: "Invalid start path" },
          400,
        );
      }
      // No character validation needed for proxying sessions
    }

    // Forward request to bot service with original method
    let botResponse;
    try {
      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };

      const botApiKey = Deno.env.get("BOT_START_API_KEY");
      if (botApiKey) {
        headers["Authorization"] = `Bearer ${botApiKey}`;
      }

      const fetchOptions: RequestInit = {
        method: req.method, // Use original HTTP method
        headers,
      };

      // Only add body for methods that support it
      if (requestData) {
        fetchOptions.body = JSON.stringify(requestData);
      }

      botResponse = await fetch(botEndpoint, fetchOptions);

      if (!botResponse.ok) {
        console.error(
          "start.bot_request_failed",
          `Bot returned status ${botResponse.status} for action: ${action}`,
        );
        return corsResponse(
          { success: false, error: "Bot request failed" },
          502,
        );
      }
    } catch (err) {
      console.error("start.bot_request_error", err);
      return corsResponse(
        {
          success: false,
          error: "Failed to communicate with bot service" + botStartUrl,
        },
        502,
      );
    }

    // Return exactly what the bot endpoint returns
    try {
      const botResponseData = await botResponse.json();
      console.log("start.bot_request_success", {
        action,
        data: botResponseData,
      });
      return corsResponse(botResponseData, botResponse.status);
    } catch (err) {
      console.error("start.bot_response_parse_error", err);
      return corsResponse(
        { success: false, error: "Invalid response from bot service" },
        502,
      );
    }
  } catch (err) {
    console.error("start.unhandled", err);
    return corsResponse(
      { success: false, error: "Internal server error" },
      500,
    );
  }
});
