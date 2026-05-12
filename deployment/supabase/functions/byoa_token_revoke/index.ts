/**
 * Public Edge Function: byoa_token_revoke
 *
 * Revokes a BYOA token by `token_id`. Flips `revoked_at` on the row so
 * `verify_byoa_token` rejects any subsequent gateway request carrying that
 * token. Idempotent — already-revoked tokens return success with
 * `changed: false`.
 *
 * Auth: caller's Supabase JWT must own the character the token is bound
 * to (direct ownership, same rule as mint). Operators can only revoke
 * their own tokens.
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

Deno.serve(traced("byoa_token_revoke", async (req, trace) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return corsResponse({ success: false, error: "POST required" }, 405);
  }

  const supabase = createServiceRoleClient();

  try {
    await enforcePublicRateLimit(supabase, req, "byoa_token_revoke");
  } catch (err) {
    if (err instanceof RateLimitError) {
      return corsResponse(
        { success: false, error: "Too many requests. Please try again later." },
        429,
      );
    }
    console.error("byoa_token_revoke.rate_limit", err);
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

  let tokenId: string;
  try {
    tokenId = requireString(payload, "token_id");
  } catch (err) {
    const response = respondWithError(err);
    if (response) return corsResponse(await response.json(), response.status);
    return corsResponse(
      { success: false, error: "token_id is required" },
      400,
    );
  }

  trace.setInput({ user_id: user.id, token_id: tokenId });

  // Look up the token to learn its character_id, then check ownership
  // before touching the row. Avoids a race where the user revokes a
  // token they don't own.
  const { data: row, error: rowErr } = await supabase
    .from("byoa_tokens")
    .select("token_id, character_id, revoked_at")
    .eq("token_id", tokenId)
    .maybeSingle();
  if (rowErr) {
    console.error("byoa_token_revoke.lookup", rowErr);
    return corsResponse(
      { success: false, error: "Failed to look up token" },
      500,
    );
  }
  if (!row) {
    return corsResponse({ success: false, error: "not_found" }, 404);
  }

  const { data: ownsCharacter, error: ownsErr } = await supabase.rpc(
    "can_user_access_character",
    { p_user_id: user.id, p_character_id: row.character_id },
  );
  if (ownsErr) {
    console.error("byoa_token_revoke.ownership_rpc", ownsErr);
    return corsResponse(
      { success: false, error: "Failed to verify ownership" },
      500,
    );
  }
  if (ownsCharacter !== true) {
    return corsResponse({ success: false, error: "forbidden" }, 403);
  }

  if (row.revoked_at !== null) {
    trace.setOutput({ token_id: tokenId, changed: false });
    return corsResponse({
      success: true,
      token_id: tokenId,
      changed: false,
      revoked_at: row.revoked_at,
    });
  }

  const { data: updated, error: updateErr } = await supabase
    .from("byoa_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_id", tokenId)
    .is("revoked_at", null)
    .select("token_id, revoked_at")
    .maybeSingle();
  if (updateErr) {
    console.error("byoa_token_revoke.update", updateErr);
    return corsResponse(
      { success: false, error: "Failed to revoke token" },
      500,
    );
  }
  // Race-tolerance: someone else revoked between lookup and update.
  if (!updated) {
    return corsResponse({
      success: true,
      token_id: tokenId,
      changed: false,
    });
  }

  trace.setOutput({ token_id: tokenId, changed: true });
  return corsResponse({
    success: true,
    token_id: tokenId,
    changed: true,
    revoked_at: updated.revoked_at,
  });
}));
