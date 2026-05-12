/**
 * Public Edge Function: byoa_token_mint
 *
 * Mints a long-lived HS256 BYOA token bound to a single character_id.
 * The token's plaintext is returned exactly once; the DB stores only a
 * SHA-256 hash for revocation lookup. Operators invoke this once per
 * machine (typically via the `byoa-setup` Claude skill) and store the
 * plaintext locally; subsequent calls always require re-minting.
 *
 * Auth model:
 *   - Caller's `Authorization: Bearer <supabase-jwt>` is verified via
 *     `getAuthenticatedUser` (delegates to supabase-js, handles all algs).
 *   - Caller must own the requested character per
 *     `can_user_access_character`. Direct ownership only — corp-member
 *     access is intentionally NOT enough to mint a token bound to another
 *     corp member's character.
 *
 * Token payload:
 *   - `sub`: user_id (Supabase Auth) — for audit; not used for runtime auth.
 *   - `character_id`: bound character.
 *   - `token_type`: "byoa" (defense against cross-token-type reuse).
 *   - `iss`: "byoa_token_mint" (issuer guard).
 *   - `jti`: matches `byoa_tokens.token_id` so revocation lookup by id works.
 *   - `iat` / `exp`.
 *
 * The signing secret is the same `pubsub_internal_secret` provisioned by
 * the pgmq pubsub migration — one HS256 secret per database, shared with
 * the verify_token edge function. Rotating that secret invalidates all
 * outstanding BYOA tokens (which is the intended post-rotation behaviour).
 */

import {
  AuthError,
  getAuthenticatedUser,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  enforcePublicRateLimit,
  RateLimitError,
} from "../_shared/rate_limiting.ts";
import {
  optionalString,
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

// Long-lived but not infinite. Operators rotate via "mint new + revoke old."
const DEFAULT_TTL_DAYS = 90;
const MAX_TTL_DAYS = 365;

let _cachedSecret: string | null = null;

async function getSigningSecret(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string> {
  if (_cachedSecret) return _cachedSecret;
  const { data, error } = await supabase.rpc("pubsub_internal_secret");
  if (error) {
    throw new Error(`failed to fetch signing secret: ${error.message}`);
  }
  if (typeof data !== "string" || !data) {
    throw new Error("pubsub_internal_secret() returned no value");
  }
  _cachedSecret = data;
  return _cachedSecret;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signHs256(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64UrlEncodeJson(header)}.${
    base64UrlEncodeJson(payload)
  }`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(traced("byoa_token_mint", async (req, trace) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return corsResponse({ success: false, error: "POST required" }, 405);
  }

  const supabase = createServiceRoleClient();

  try {
    await enforcePublicRateLimit(supabase, req, "byoa_token_mint");
  } catch (err) {
    if (err instanceof RateLimitError) {
      return corsResponse(
        { success: false, error: "Too many requests. Please try again later." },
        429,
      );
    }
    console.error("byoa_token_mint.rate_limit", err);
  }

  let user;
  try {
    user = await getAuthenticatedUser(req);
  } catch (err) {
    if (err instanceof AuthError) {
      return corsResponse({ success: false, error: err.code }, err.status);
    }
    return corsResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "Authentication failed",
      },
      401,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) return corsResponse(await response.json(), response.status);
    return corsResponse(
      { success: false, error: "Invalid JSON payload" },
      400,
    );
  }

  let characterId: string;
  let label: string;
  let ttlDays: number;
  try {
    characterId = requireString(payload, "character_id");
    label = requireString(payload, "label").trim();
    if (label.length === 0) {
      return corsResponse(
        { success: false, error: "label must be non-empty" },
        400,
      );
    }
    if (label.length > 100) {
      return corsResponse(
        { success: false, error: "label must be at most 100 characters" },
        400,
      );
    }
    const ttlRaw = optionalString(payload, "ttl_days");
    ttlDays = ttlRaw === null || ttlRaw === undefined
      ? DEFAULT_TTL_DAYS
      : Number.parseInt(ttlRaw, 10);
    if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > MAX_TTL_DAYS) {
      return corsResponse(
        {
          success: false,
          error: `ttl_days must be a positive integer ≤ ${MAX_TTL_DAYS}`,
        },
        400,
      );
    }
  } catch (err) {
    const response = respondWithError(err);
    if (response) return corsResponse(await response.json(), response.status);
    return corsResponse(
      { success: false, error: "invalid request" },
      400,
    );
  }

  trace.setInput({ user_id: user.id, character_id: characterId, ttl_days: ttlDays });

  // Direct-ownership only for token mint. `can_user_access_character`
  // permits corp-ship access too, but we don't want a corp member minting
  // a token bound to another member's character.
  const { data: ownsCharacter, error: ownsErr } = await supabase.rpc(
    "can_user_access_character",
    { p_user_id: user.id, p_character_id: characterId },
  );
  if (ownsErr) {
    console.error("byoa_token_mint.ownership_rpc", ownsErr);
    return corsResponse(
      { success: false, error: "Failed to verify character ownership" },
      500,
    );
  }
  if (ownsCharacter !== true) {
    return corsResponse({ success: false, error: "forbidden" }, 403);
  }

  // Reserve the token_id up-front so it can land in the JWT as `jti`.
  const tokenId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlDays * 24 * 60 * 60;

  let secret: string;
  try {
    secret = await getSigningSecret(supabase);
  } catch (err) {
    console.error("byoa_token_mint.signing_secret", err);
    return corsResponse(
      { success: false, error: "Server misconfigured" },
      500,
    );
  }

  const token = await signHs256(
    {
      sub: user.id,
      character_id: characterId,
      token_type: "byoa",
      iss: "byoa_token_mint",
      jti: tokenId,
      iat: now,
      exp,
    },
    secret,
  );
  const tokenHash = await sha256Hex(token);

  const { error: insertErr } = await supabase
    .from("byoa_tokens")
    .insert({
      token_id: tokenId,
      character_id: characterId,
      token_hash: tokenHash,
      label,
      expires_at: new Date(exp * 1000).toISOString(),
    });
  if (insertErr) {
    console.error("byoa_token_mint.insert", insertErr);
    return corsResponse(
      { success: false, error: "Failed to record token" },
      500,
    );
  }

  trace.setOutput({ token_id: tokenId, expires_at: exp });
  return corsResponse(
    {
      success: true,
      token,
      token_id: tokenId,
      character_id: characterId,
      label,
      expires_at: exp,
    },
    200,
  );
}));
