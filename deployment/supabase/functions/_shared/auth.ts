import { timingSafeEqual } from "https://deno.land/std@0.197.0/crypto/timing_safe_equal.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

function readCallerToken(req: Request): string | null {
  return (
    req.headers.get("x-api-token") ??
    req.headers.get("X-API-Token") ??
    null
  );
}

/**
 * Backward-compatible boolean check. Returns true if the caller token is
 * either the shared admin token (`EDGE_API_TOKEN`) or a valid Supabase Auth
 * JWT. Used by edge functions that have not yet adopted ``authenticate()``.
 *
 * NOTE: this only validates *that* the caller is authenticated; it does NOT
 * verify ownership of any character_id in the request body. Functions that
 * mutate per-character state should use ``authenticate()`` +
 * ``canActOnCharacter()`` instead.
 */
export async function validateApiToken(req: Request): Promise<boolean> {
  try {
    await authenticate(req);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Typed authentication context
// ============================================================================

/**
 * Discriminated auth context returned by ``authenticate()``.
 *
 * - ``admin``: caller presented the shared ``EDGE_API_TOKEN``. Used by NPCs,
 *   cron jobs (combat_tick), pg_net invocations, and other internal services.
 *   Bypasses per-character ownership checks.
 * - ``user``: caller presented a valid Supabase Auth JWT. ``userId`` is the
 *   ``auth.users.id`` from the token's ``sub`` claim. Per-character
 *   authorization must be checked via ``canActOnCharacter()``.
 * - ``byoc``: future. Reserved for per-operator API tokens once we ship the
 *   bring-your-own-compute integration. Not issued today.
 */
export type AuthContext =
  | { kind: "admin" }
  | { kind: "user"; userId: string; email: string | null }
  | { kind: "byoc"; userId: string; tokenId: string };

export class AuthError extends Error {
  readonly code:
    | "no_token"
    | "invalid_token"
    | "token_expired"
    | "auth_unavailable";
  readonly status: number;

  constructor(
    code:
      | "no_token"
      | "invalid_token"
      | "token_expired"
      | "auth_unavailable",
    message?: string,
  ) {
    super(message ?? code);
    this.code = code;
    // Map auth failures to 401 (unauthenticated). Authorization failures
    // (caller is authenticated but not allowed for the requested character)
    // are 403 and surface from ``canActOnCharacter()``.
    this.status = 401;
  }
}

function looksLikeJwt(token: string): boolean {
  // JWTs have three base64url parts separated by dots. Fast pre-check that
  // saves a Supabase round-trip when the caller used the shared admin token.
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Resolve the caller's auth context from the ``X-API-Token`` header.
 *
 * Tries each credential type in priority order:
 *   1. JWT-shaped token → verify via Supabase Auth → user context.
 *   2. Exact match on ``EDGE_API_TOKEN`` env → admin context.
 *   3. Otherwise → throw ``AuthError``.
 *
 * Local-dev convenience: when ``EDGE_API_TOKEN`` is unset *and* the caller
 * presents no token, we treat it as admin. This preserves the pre-migration
 * behavior of ``validateApiToken`` for ``--no-verify-jwt`` local stacks.
 */
export async function authenticate(req: Request): Promise<AuthContext> {
  const token = readCallerToken(req);
  const adminToken = getApiToken();

  // Dev convenience: when EDGE_API_TOKEN is unset (e.g. local dev stack,
  // integration test harness) we bypass all auth checks and return admin.
  // This preserves the pre-migration `validateApiToken` semantics where
  // unset env meant "allow everything". Production environments always set
  // EDGE_API_TOKEN, so this branch is impossible there.
  if (!adminToken) {
    return { kind: "admin" };
  }

  if (!token) {
    throw new AuthError("no_token");
  }

  if (looksLikeJwt(token)) {
    let supabase;
    try {
      supabase = createPublicClient();
    } catch (err) {
      console.error("authenticate.client_init", err);
      throw new AuthError("auth_unavailable");
    }
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) {
      // Distinguish expired vs other invalid for better client UX.
      const msg = error?.message ?? "no user";
      const code: AuthError["code"] = /expired/i.test(msg)
        ? "token_expired"
        : "invalid_token";
      throw new AuthError(code, msg);
    }
    return { kind: "user", userId: user.id, email: user.email ?? null };
  }

  if (adminToken && token === adminToken) {
    return { kind: "admin" };
  }

  throw new AuthError("invalid_token");
}

/**
 * Convert an :class:`AuthError` to the standard ``unauthorizedResponse()``.
 * Edge functions can use this in their catch block to keep the response
 * shape consistent.
 */
export function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return jsonResponse(
      { success: false, error: err.code },
      err.status,
    );
  }
  return unauthorizedResponse();
}

/**
 * Per-character authorization check. Wraps the
 * ``can_user_access_character(user_id, character_id)`` SQL predicate (added
 * in the pgmq pubsub migration) which permits direct ownership via
 * ``user_characters`` OR corp ship access via corp membership.
 *
 * Admin contexts bypass the check (true). BYOC contexts (future) will use
 * the same predicate with the BYOC-token-bound user_id.
 */
export async function canActOnCharacter(
  auth: AuthContext,
  characterId: string,
  supabase: SupabaseClient,
): Promise<boolean> {
  if (auth.kind === "admin") return true;
  if (!characterId) return false;

  const { data, error } = await supabase.rpc("can_user_access_character", {
    p_user_id: auth.userId,
    p_character_id: characterId,
  });
  if (error) {
    console.error("canActOnCharacter.rpc", { error });
    return false;
  }
  return data === true;
}

export function unauthorizedResponse(): Response {
  return jsonResponse({ success: false, error: "unauthorized" }, 401);
}

export function successResponse<T>(data: T, status = 200): Response {
  return jsonResponse(
    { success: true, ...((data as Record<string, unknown>) ?? {}) },
    status,
  );
}

export function errorResponse(
  message: string,
  status = 400,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse(
    { success: false, error: message, ...(extra ?? {}) },
    status,
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
  candidate: unknown,
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
    },
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
      "Email not verified. Please check your email for confirmation link.",
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
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
}
