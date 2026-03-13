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

Deno.serve(traced("register", async (req, trace) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const serviceClient = createServiceRoleClient();

  // Apply IP-based rate limiting
  const sRateLimit = trace.span("rate_limit");
  try {
    await enforcePublicRateLimit(serviceClient, req, "register");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
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
    console.error("register.parse", err);
    return corsResponse({ success: false, error: "Invalid JSON payload" }, 400);
  }

  try {
    // Parse and validate request
    const sValidate = trace.span("validate_input");
    const email = requireString(payload, "email");
    const password = requireString(payload, "password");

    trace.setInput({});

    // Basic email validation
    if (!email.includes("@") || email.length < 3) {
      sValidate.end({ error: "Invalid email address" });
      return corsResponse(
        { success: false, error: "Invalid email address" },
        400,
      );
    }

    // Password validation
    if (password.length < 6) {
      sValidate.end({ error: "Password too short" });
      return corsResponse(
        { success: false, error: "Password must be at least 6 characters" },
        400,
      );
    }
    sValidate.end();

    // Create Supabase auth client (public)
    const publicClient = createPublicClient();

    // Sign up user with Supabase Auth
    const sSignup = trace.span("auth_signup");
    const { data, error } = await publicClient.auth.signUp({
      email,
      password,
    });

    if (error) {
      sSignup.end({ error: error.message });
      console.error("register.signup", error);
      return corsResponse({ success: false, error: error.message }, 400);
    }

    if (!data.user) {
      sSignup.end({ error: "Failed to create user account" });
      return corsResponse(
        { success: false, error: "Failed to create user account" },
        500,
      );
    }
    sSignup.end({ user_id: data.user.id });

    // Check if email confirmation is required
    const confirmationRequired = !data.user.email_confirmed_at;

    trace.setOutput({ user_id: data.user.id });

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
}));
