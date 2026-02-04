/**
 * Public Edge Function: user_confirm
 *
 * Completes the user invite flow by setting the user's password.
 * Accepts access_token and refresh_token (from invite redirect URL hash) and new password.
 * No EDGE_API_TOKEN required - this is a public endpoint.
 */

import { createPublicClient } from "../_shared/auth.ts";
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

// CORS headers for public access from web clients
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

  const serviceClient = createServiceRoleClient();

  // Apply IP-based rate limiting
  try {
    await enforcePublicRateLimit(serviceClient, req, "user_confirm");
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn("user_confirm.rate_limit", err.message);
      return corsResponse(
        {
          success: false,
          error: "Too many attempts. Please try again later.",
        },
        429,
      );
    }
    console.error("user_confirm.rate_limit", err);
    return corsResponse(
      { success: false, error: "Rate limit check failed" },
      500,
    );
  }

  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return corsResponse(await response.json(), response.status);
    }
    console.error("user_confirm.parse", err);
    return corsResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  try {
    // Parse and validate request - tokens from URL hash after invite redirect
    const accessToken = requireString(payload, "access_token");
    const refreshToken = requireString(payload, "refresh_token");
    const password = requireString(payload, "password");

    // Password validation
    if (password.length < 6) {
      return corsResponse(
        { success: false, error: "Password must be at least 6 characters" },
        400,
      );
    }

    // Create public Supabase client and set session from invite tokens
    const supabase = createPublicClient();

    // Set the session using tokens from the invite redirect
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (sessionError) {
      console.error("user_confirm.set_session", sessionError);
      return corsResponse(
        { success: false, error: "Invalid or expired token" },
        401,
      );
    }

    if (!sessionData.user) {
      return corsResponse(
        { success: false, error: "Failed to verify session" },
        401,
      );
    }

    // Update the user's password (now that we have an active session)
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });

    if (updateError) {
      console.error("user_confirm.update_password", updateError);
      return corsResponse(
        { success: false, error: "Failed to set password: " + updateError.message },
        400,
      );
    }

    return corsResponse(
      {
        success: true,
        user_id: sessionData.user.id,
        email: sessionData.user.email,
        session: sessionData.session
          ? {
              access_token: sessionData.session.access_token,
              refresh_token: sessionData.session.refresh_token,
              expires_at: sessionData.session.expires_at,
              expires_in: sessionData.session.expires_in,
            }
          : null,
      },
      200,
    );
  } catch (err) {
    console.error("user_confirm.unhandled", err);
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      500,
    );
  }
});
