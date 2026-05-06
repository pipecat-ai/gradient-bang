/**
 * Public Edge Function: verify_token
 *
 * Exchanges a Supabase Auth JWT for a short-lived internal HS256 token
 * scoped to a single character. The bot's pubsub adapter calls this once
 * per session and uses the returned token in `subscribe_my_events` /
 * `archive_my_events` SQL calls.
 *
 * Why this exists: the SQL functions verify with HS256 against a stable
 * secret we control end-to-end (`PUBSUB_INTERNAL_SECRET`). Supabase Auth
 * has moved to ES256 with rotating signing keys, which is hard to verify
 * inside Postgres. This edge function is the place that talks to Supabase
 * Auth (handles HS256/ES256 transparently), so the SQL side stays simple.
 *
 * Auth model:
 *   - Caller's Authorization: Bearer <supabase-jwt> is verified via
 *     `getAuthenticatedUser` (delegates to supabase-js, handles all algs).
 *   - Caller must own the requested character (or have corp-ship access)
 *     per `can_user_access_character`.
 *   - Internal token expiry is capped to the Supabase JWT's exp so the
 *     internal grant never outlives the underlying auth session.
 */

import { getAuthenticatedUser } from "../_shared/auth.ts";
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

// 24h hard cap on the internal token. Capped further down to the Supabase
// JWT's exp so we never extend the user's session beyond their auth window.
const INTERNAL_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// Module-scoped cache for the signing secret. Persists across invocations
// within a warm function instance — one DB roundtrip per cold start.
let _cachedSecret: string | null = null;

async function getSigningSecret(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string> {
  if (_cachedSecret) return _cachedSecret;
  const { data, error } = await supabase.rpc("pubsub_internal_secret");
  if (error) {
    throw new Error(`failed to fetch pubsub signing secret: ${error.message}`);
  }
  if (typeof data !== "string" || !data) {
    throw new Error("pubsub_internal_secret() returned no value");
  }
  _cachedSecret = data;
  return _cachedSecret;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  // RFC 7515 base64url: replace +/, strip =
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  return base64UrlEncode(new TextEncoder().encode(json));
}

/**
 * Sign a JWT (HS256) using `secret` as the HMAC key. Returns the encoded
 * header.payload.signature string. We don't pull in `jose` because this
 * function is the only place that signs internal tokens and `crypto.subtle`
 * is already in the runtime (used elsewhere in `_shared/auth.ts`).
 */
async function signHs256(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  const encodedSig = base64UrlEncode(new Uint8Array(sigBuffer));
  return `${signingInput}.${encodedSig}`;
}

/**
 * Decode a JWT payload without verifying — we only call this AFTER
 * `getAuthenticatedUser` has already verified the token, so this is just
 * pulling out claims (specifically `exp`) for cap calculations.
 */
function unsafeDecodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

Deno.serve(traced("verify_token", async (req, trace) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return corsResponse(
      { success: false, error: "POST required" },
      405,
    );
  }

  const supabase = createServiceRoleClient();

  // Per-user rate limiting (parity with login / start)
  const sRateLimit = trace.span("rate_limit");
  try {
    await enforcePublicRateLimit(supabase, req, "verify_token");
    sRateLimit.end();
  } catch (err) {
    sRateLimit.end({ error: err instanceof Error ? err.message : String(err) });
    if (err instanceof RateLimitError) {
      return corsResponse(
        { success: false, error: "Too many requests. Please try again later." },
        429,
      );
    }
    console.error("verify_token.rate_limit", err);
  }

  // Authenticate the Supabase Auth JWT (delegates to supabase-js, which
  // handles HS256 and ES256 transparently).
  const sAuth = trace.span("auth_check");
  let user;
  try {
    user = await getAuthenticatedUser(req);
    sAuth.end({ user_id: user.id });
  } catch (err) {
    sAuth.end({ error: err instanceof Error ? err.message : String(err) });
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Authentication failed",
      },
      401,
    );
  }

  // Parse request body
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return corsResponse(await response.json(), response.status);
    }
    return corsResponse(
      { success: false, error: "Invalid JSON payload" },
      400,
    );
  }

  let characterId: string;
  try {
    characterId = requireString(payload, "character_id");
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return corsResponse(await response.json(), response.status);
    }
    return corsResponse(
      { success: false, error: "character_id is required" },
      400,
    );
  }

  trace.setInput({ user_id: user.id, character_id: characterId });

  // Authorize: user must own character (or have corp-ship access)
  const sOwnership = trace.span("ownership_check");
  const { data: ownsCharacter, error: ownsErr } = await supabase.rpc(
    "can_user_access_character",
    { p_user_id: user.id, p_character_id: characterId },
  );
  if (ownsErr) {
    sOwnership.end({ error: ownsErr.message });
    console.error("verify_token.ownership_rpc", ownsErr);
    return corsResponse(
      { success: false, error: "Failed to verify character ownership" },
      500,
    );
  }
  if (ownsCharacter !== true) {
    sOwnership.end({ result: "forbidden" });
    return corsResponse(
      { success: false, error: "forbidden" },
      403,
    );
  }
  sOwnership.end({ result: "ok" });

  // Cap the internal token's exp to the Supabase JWT's exp so the grant
  // never outlives the user's auth session.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseJwt = authHeader.replace(/^Bearer\s+/i, "");
  const supabasePayload = unsafeDecodeJwtPayload(supabaseJwt);
  const supabaseExp =
    typeof supabasePayload?.exp === "number" ?
      (supabasePayload.exp as number) :
      undefined;

  const now = Math.floor(Date.now() / 1000);
  const maxExp = now + INTERNAL_TOKEN_TTL_SECONDS;
  const exp = supabaseExp && supabaseExp < maxExp ? supabaseExp : maxExp;

  let internalSecret: string;
  try {
    internalSecret = await getSigningSecret(supabase);
  } catch (err) {
    console.error("verify_token.signing_secret_fetch_failed", err);
    return corsResponse(
      { success: false, error: "Server misconfigured" },
      500,
    );
  }

  const internalToken = await signHs256(
    {
      sub: user.id,
      character_id: characterId,
      iat: now,
      exp,
      iss: "verify_token",
    },
    internalSecret,
  );

  trace.setOutput({ user_id: user.id, character_id: characterId, expires_at: exp });
  return corsResponse(
    {
      success: true,
      token: internalToken,
      expires_at: exp,
    },
    200,
  );
}));
