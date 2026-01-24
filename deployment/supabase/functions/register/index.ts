/**
 * Public Edge Function: register
 *
 * Allows users to register a new account with email and password.
 * Sends email confirmation link (email must be verified before character creation).
 * No EDGE_API_TOKEN required - this is a public endpoint.
 */

import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
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

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const serviceClient = createServiceRoleClient();

  // Apply IP-based rate limiting
  try {
    await enforcePublicRateLimit(serviceClient, req, "register");
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn("register.rate_limit", err.message);
      return corsResponse(
        {
          success: false,
          error: "Too many registration attempts. Please try again later.",
        },
        429,
      );
    }
    console.error("register.rate_limit", err);
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
    console.error("register.parse", err);
    return corsResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  try {
    // Parse and validate request
    const email = requireString(payload, "email");
    const password = requireString(payload, "password");

    // Basic email validation
    if (!email.includes("@") || email.length < 3) {
      return corsResponse(
        { success: false, error: "Invalid email address" },
        400,
      );
    }

    // Password validation
    if (password.length < 6) {
      return corsResponse(
        { success: false, error: "Password must be at least 6 characters" },
        400,
      );
    }

    // Create Supabase auth client (public)
    const publicClient = createPublicClient();

    // Sign up user with Supabase Auth
    const { data, error } = await publicClient.auth.signUp({
      email,
      password,
    });

    if (error) {
      console.error("register.signup", error);
      return corsResponse({ success: false, error: error.message }, 400);
    }

    if (!data.user) {
      return corsResponse(
        { success: false, error: "Failed to create user account" },
        500,
      );
    }

    // Check if email confirmation is required
    const confirmationRequired = !data.user.email_confirmed_at;

    return corsResponse(
      {
        success: true,
        user_id: data.user.id,
        email: data.user.email,
        email_confirmed: !confirmationRequired,
        message: confirmationRequired
          ? "Registration successful! Please check your email to confirm your account."
          : "Registration successful! You can now create a character.",
      },
      201,
    );
  } catch (err) {
    console.error("register.unhandled", err);
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Internal server error",
      },
      500,
    );
  }
});
