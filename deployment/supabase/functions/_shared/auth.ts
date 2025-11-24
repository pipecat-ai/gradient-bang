import { timingSafeEqual } from "https://deno.land/std@0.197.0/crypto/timing_safe_equal.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function getApiToken(): string | undefined {
  return (
    Deno.env.get("EDGE_API_TOKEN") ??
    Deno.env.get("SUPABASE_API_TOKEN") ??
    undefined
  );
}

export function validateApiToken(req: Request): boolean {
  const apiToken = getApiToken();
  if (!apiToken) {
    // When the token is not configured we allow all requests (local dev convenience)
    return true;
  }

  const provided =
    req.headers.get("x-api-token") ?? req.headers.get("X-API-Token");
  return provided === apiToken;
}

export function unauthorizedResponse(): Response {
  return jsonResponse({ success: false, error: "unauthorized" }, 401);
}

export function successResponse<T>(data: T, status = 200): Response {
  return jsonResponse(
    { success: true, ...((data as Record<string, unknown>) ?? {}) },
    status
  );
}

export function errorResponse(
  message: string,
  status = 400,
  extra?: Record<string, unknown>
): Response {
  return jsonResponse(
    { success: false, error: message, ...(extra ?? {}) },
    status
  );
}

const ADMIN_PASSWORD =
  Deno.env.get("EDGE_ADMIN_PASSWORD") ?? Deno.env.get("ADMIN_PASSWORD") ?? "";
const ADMIN_PASSWORD_HASH =
  Deno.env.get("EDGE_ADMIN_PASSWORD_HASH") ??
  Deno.env.get("ADMIN_PASSWORD_HASH") ??
  "";

export function isAdminSecretConfigured(): boolean {
  return Boolean(ADMIN_PASSWORD || ADMIN_PASSWORD_HASH);
}

function timingSafeCompare(expected: string, provided: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(expected);
  const right = encoder.encode(provided);
  if (left.length !== right.length) {
    return false;
  }
  try {
    return timingSafeEqual(left, right);
  } catch (_err) {
    return false;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateAdminSecret(
  candidate: unknown
): Promise<boolean> {
  if (!isAdminSecretConfigured()) {
    return false;
  }
  if (typeof candidate !== "string" || !candidate.trim()) {
    return false;
  }
  if (ADMIN_PASSWORD) {
    return timingSafeCompare(ADMIN_PASSWORD, candidate);
  }
  const hashed = await sha256Hex(candidate);
  return timingSafeCompare(ADMIN_PASSWORD_HASH, hashed);
}

// ============================================================================
// Supabase Auth Integration (for public user authentication)
// ============================================================================

/**
 * Create Supabase client with user's auth context from Authorization header.
 * This allows RLS policies to work correctly with the authenticated user.
 */
export function createClientWithAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    }
  );
}

/**
 * Get authenticated user from request
 * Throws error if token is missing, invalid, or expired.
 */
export async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Error("No authorization token provided");
  }

  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    throw new Error("Invalid authorization header format");
  }

  const supabase = createClientWithAuth(req);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error) {
    throw new Error(`Authentication failed: ${error.message}`);
  }

  if (!user) {
    throw new Error("Invalid or expired token");
  }

  return user;
}

/**
 * Check if user's email is verified.
 * Throws error if email is not confirmed.
 */
export function requireEmailVerified(user: {
  email_confirmed_at?: string | null;
}) {
  if (!user.email_confirmed_at) {
    throw new Error(
      "Email not verified. Please check your email for confirmation link."
    );
  }
}

/**
 * Create a Supabase client for public (unauthenticated) operations.
 * Uses ANON_KEY which respects RLS policies.
 */
export function createPublicClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );
}
