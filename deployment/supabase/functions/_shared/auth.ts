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

function readEdgeAuth(req: Request): string | null {
  return (
    req.headers.get("x-edge-auth") ??
    req.headers.get("X-Edge-Auth") ??
    null
  );
}

/**
 * Backward-compatible boolean check. Returns true if the request passes
 * ``authenticate()`` (i.e. ``X-Edge-Auth`` matches the admin token, with
 * an optional valid user JWT in ``X-API-Token``). Used by edge functions
 * that have not yet adopted the typed ``AuthContext``.
 *
 * NOTE: this only validates *that* the caller is authenticated; it does NOT
 * verify ownership of any character_id in the request body. Functions that
 * mutate per-character state should use ``authenticate()`` +
 * ``canActOnCharacter()`` instead. Endpoints that must be admin-only
 * (cron jobs, test-reset, internal webhooks) should use
 * ``requireAdminToken()`` instead — this helper accepts bot callers.
 */
export async function validateApiToken(req: Request): Promise<boolean> {
  try {
    await authenticate(req);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict admin-only token check. Returns true ONLY when the caller presents
 * the shared ``EDGE_API_TOKEN`` in ``X-Edge-Auth``. Use this for endpoints
 * that should never be reachable by an end user (cron jobs, test_reset,
 * internal webhooks).
 *
 * ``options.headerName`` lets callers read from a non-default header (e.g.
 * ``X-CEKURA-SECRET`` for the eval webhook). Defaults to ``X-Edge-Auth``.
 *
 * Local-dev convenience: when ``EDGE_API_TOKEN`` is unset and
 * ``ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1`` is set, a request with no token is
 * treated as admin. Both env vars must be present to opt in. Production
 * always sets ``EDGE_API_TOKEN``, so the bypass cannot fire there.
 */
export async function requireAdminToken(
  req: Request,
  options?: { headerName?: string },
): Promise<boolean> {
  const token = options?.headerName
    ? req.headers.get(options.headerName)
    : readEdgeAuth(req);
  const adminToken = getApiToken();

  if (adminToken) {
    return Boolean(token) && token === adminToken;
  }

  // EDGE_API_TOKEN unset. Only allow when explicit dev opt-in is set AND no
  // token was presented (a presented token in this state is suspicious —
  // fail closed rather than silently accept anything).
  if (
    Deno.env.get("ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV") === "1" &&
    !token
  ) {
    return true;
  }
  return false;
}

// ============================================================================
// Typed authentication context
// ============================================================================

/**
 * Discriminated auth context returned by ``authenticate()``.
 *
 * - ``admin``: caller presented ``X-Edge-Auth: <EDGE_API_TOKEN>`` only (no
 *   user JWT). Used by NPCs, cron jobs (combat_tick), pg_net invocations,
 *   and other internal services. Bypasses per-character ownership checks.
 * - ``bot``: caller presented BOTH ``X-Edge-Auth: <EDGE_API_TOKEN>`` AND
 *   ``X-API-Token: <user JWT>``. The platform voice agent (bot.py) acting
 *   on behalf of a user. ``userId`` is the ``auth.users.id`` from the JWT's
 *   ``sub`` claim. Per-character authorization must be checked via
 *   ``canActOnCharacter()``.
 * - ``byoa``: future. Reserved for per-operator API tokens once we ship
 *   the bring-your-own-agent integration. Not issued today.
 */
export type AuthContext =
  | { kind: "admin" }
  | { kind: "bot"; userId: string; email: string | null }
  | { kind: "byoa"; userId: string; tokenId: string };

export class AuthError extends Error {
  readonly code:
    | "no_token"
    | "invalid_token"
    | "token_expired"
    | "auth_unavailable"
    | "admin_token_required";
  readonly status: number;

  constructor(
    code:
      | "no_token"
      | "invalid_token"
      | "token_expired"
      | "auth_unavailable"
      | "admin_token_required",
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
 * Resolve the caller's auth context.
 *
 * Two headers are inspected:
 *   - ``X-Edge-Auth``: must equal ``EDGE_API_TOKEN``. Proves the request
 *     came through a trusted backend (bot.py, NPC scripts, cron). REQUIRED.
 *   - ``X-API-Token``: optional user JWT. When present and valid, the
 *     caller is the platform bot acting on behalf of that user (``bot``
 *     context). When absent, the caller is internal (``admin`` context).
 *
 * A bare ``X-API-Token`` (JWT) without ``X-Edge-Auth`` is rejected with
 * ``admin_token_required`` — closes the gap where any logged-in user could
 * invoke gameplay edge functions directly with their JWT alone.
 *
 * Local-dev convenience: when ``EDGE_API_TOKEN`` is unset *and*
 * ``ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1`` is set *and* no headers are
 * presented, the caller is treated as admin. Both env vars must be
 * present to opt in. Production always sets EDGE_API_TOKEN, so this
 * branch cannot fire there even if the bypass env leaks in.
 */
export async function authenticate(req: Request): Promise<AuthContext> {
  const edgeAuth = readEdgeAuth(req);
  const apiToken = readCallerToken(req);
  const adminToken = getApiToken();
  const bypassEnabled =
    Deno.env.get("ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV") === "1";

  if (adminToken) {
    // Production / configured-with-secret: X-Edge-Auth is required and must
    // match. A bare JWT in X-API-Token is rejected — closes the gap where
    // any logged-in user could invoke gameplay edge functions directly.
    if (!edgeAuth) {
      throw new AuthError("admin_token_required");
    }
    if (edgeAuth !== adminToken) {
      throw new AuthError("invalid_token");
    }
  } else if (!bypassEnabled) {
    // No EDGE_API_TOKEN AND no bypass: fail closed. Production never sets
    // ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV, so missing-EDGE_API_TOKEN there hits
    // this branch and surfaces visibly instead of silently granting admin.
    throw new AuthError("auth_unavailable", "EDGE_API_TOKEN not configured");
  }
  // else: bypass mode (local-dev / tests). X-Edge-Auth gate skipped; JWT
  // (if presented) is still validated below.

  // If a user JWT is presented, validate it and return bot context. JWTs
  // are validated in every mode — never silently dropped.
  if (apiToken) {
    if (!looksLikeJwt(apiToken)) {
      throw new AuthError("invalid_token");
    }
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
    } = await supabase.auth.getUser(apiToken);
    if (error || !user) {
      // Distinguish expired vs other invalid for better client UX.
      const msg = error?.message ?? "no user";
      const code: AuthError["code"] = /expired/i.test(msg)
        ? "token_expired"
        : "invalid_token";
      throw new AuthError(code, msg);
    }
    return { kind: "bot", userId: user.id, email: user.email ?? null };
  }

  // No user JWT — internal/admin caller (NPC, cron, script).
  return { kind: "admin" };
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
 * Admin contexts bypass the check (true). BYOA contexts (future) will use
 * the same predicate with the BYOA-token-bound user_id.
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
