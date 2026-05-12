/**
 * Integration tests for byoa_token_mint + byoa_token_revoke and the
 * verify_byoa_token SQL helper.
 *
 * Covers:
 *   - Mint happy path: JWT claims correct (token_type, iss, jti, character_id),
 *     row inserted with matching SHA-256 hash, plaintext returned once.
 *   - Mint authorization: a stranger can't mint a token for another user's
 *     character (403 forbidden via can_user_access_character).
 *   - Mint validation: ttl_days bounds, non-empty label.
 *   - Revoke happy path: revoked_at flips; subsequent verify_byoa_token returns NULL.
 *   - Revoke idempotence: second revoke returns changed=false.
 *   - Revoke authorization: stranger can't revoke another user's token.
 *   - verify_byoa_token SQL: returns character_id on valid token and NULL
 *     after revocation.
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { Client } from "postgres";

import {
  getBaseUrl,
  getPgUrl,
  resetDatabase,
  startServerInProcess,
} from "./harness.ts";
import { characterIdFor } from "./helpers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const OWNER = "test_byoa_token_owner";
const STRANGER = "test_byoa_token_stranger";

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("not a 3-part JWT");
  const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(padded + "=".repeat((4 - padded.length % 4) % 4)));
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

interface TestUser {
  userId: string;
  accessToken: string;
}

async function provisionUser(
  emailLocal: string,
  characterId: string,
): Promise<TestUser> {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `${emailLocal}+${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${crypto.randomUUID()}`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`admin.createUser failed: ${createErr?.message}`);
  }
  const userId = created.user.id;

  const pg = new Client(getPgUrl());
  try {
    await pg.connect();
    await pg.queryObject(
      "INSERT INTO public.user_characters (user_id, character_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, characterId],
    );
  } finally {
    await pg.end();
  }

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: session, error: signinErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signinErr || !session.session?.access_token) {
    throw new Error(`signInWithPassword failed: ${signinErr?.message}`);
  }

  return { userId, accessToken: session.session.access_token };
}

async function callMint(
  authHeader: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== null) headers["Authorization"] = authHeader;
  const resp = await fetch(`${getBaseUrl()}/byoa_token_mint`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json() };
}

async function callRevoke(
  authHeader: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== null) headers["Authorization"] = authHeader;
  const resp = await fetch(`${getBaseUrl()}/byoa_token_revoke`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json() };
}

let ownerCharacterId = "";
let strangerCharacterId = "";
let owner: TestUser;
let stranger: TestUser;

Deno.test({
  name: "byoa_token: setup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await startServerInProcess();
    await resetDatabase([OWNER, STRANGER]);
    ownerCharacterId = await characterIdFor(OWNER);
    strangerCharacterId = await characterIdFor(STRANGER);
    owner = await provisionUser("byoa-token-owner", ownerCharacterId);
    stranger = await provisionUser("byoa-token-stranger", strangerCharacterId);
  },
});

Deno.test({
  name: "byoa_token_mint: happy path returns token with correct claims + hash row",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await callMint(`Bearer ${owner.accessToken}`, {
      character_id: ownerCharacterId,
      label: "first-vercel-fn",
      ttl_days: 30,
    });
    assertEquals(result.status, 200, `body=${JSON.stringify(result.body)}`);
    assert(result.body.success === true);

    const token = result.body.token as string;
    const tokenId = result.body.token_id as string;
    const expiresAt = result.body.expires_at as number;
    assertExists(token);
    assertExists(tokenId);
    assertExists(expiresAt);

    const claims = decodeJwtPayload(token);
    assertEquals(claims.sub, owner.userId);
    assertEquals(claims.character_id, ownerCharacterId);
    assertEquals(claims.token_type, "byoa");
    assertEquals(claims.iss, "byoa_token_mint");
    assertEquals(claims.jti, tokenId);
    assertEquals(claims.exp, expiresAt);

    // The stored hash matches a fresh SHA-256 of the plaintext.
    const expectedHash = await sha256Hex(token);
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      const rows = await pg.queryObject<
        { token_hash: string; character_id: string; label: string }
      >(
        "SELECT token_hash, character_id, label FROM public.byoa_tokens WHERE token_id = $1",
        [tokenId],
      );
      assertEquals(rows.rows.length, 1);
      assertEquals(rows.rows[0].token_hash, expectedHash);
      assertEquals(rows.rows[0].character_id, ownerCharacterId);
      assertEquals(rows.rows[0].label, "first-vercel-fn");
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "byoa_token_mint: stranger forbidden for unrelated character",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await callMint(`Bearer ${stranger.accessToken}`, {
      character_id: ownerCharacterId, // not theirs
      label: "stolen",
    });
    assertEquals(result.status, 403);
    assertEquals(result.body.error, "forbidden");
  },
});

Deno.test({
  name: "byoa_token_mint: validates ttl_days and label",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    for (
      const body of [
        { character_id: ownerCharacterId, label: "long", ttl_days: "10000" },
        { character_id: ownerCharacterId, label: "zero", ttl_days: "0" },
        { character_id: ownerCharacterId, label: "   " },
      ]
    ) {
      const result = await callMint(`Bearer ${owner.accessToken}`, body);
      assertEquals(result.status, 400);
    }
  },
});

let revokeTargetTokenId = "";

Deno.test({
  name: "byoa_token_revoke: mint then revoke flips revoked_at",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const mint = await callMint(`Bearer ${owner.accessToken}`, {
      character_id: ownerCharacterId,
      label: "to-revoke",
    });
    assertEquals(mint.status, 200);
    revokeTargetTokenId = mint.body.token_id as string;

    const result = await callRevoke(`Bearer ${owner.accessToken}`, {
      token_id: revokeTargetTokenId,
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.changed, true);
    assertExists(result.body.revoked_at);
  },
});

Deno.test({
  name: "byoa_token_revoke: idempotent (second call returns changed=false)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await callRevoke(`Bearer ${owner.accessToken}`, {
      token_id: revokeTargetTokenId,
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.changed, false);
  },
});

Deno.test({
  name: "byoa_token_revoke: stranger forbidden",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const mint = await callMint(`Bearer ${owner.accessToken}`, {
      character_id: ownerCharacterId,
      label: "stranger-tries-to-revoke",
    });
    const tokenId = mint.body.token_id as string;

    const result = await callRevoke(`Bearer ${stranger.accessToken}`, {
      token_id: tokenId,
    });
    assertEquals(result.status, 403);
  },
});

Deno.test({
  name: "byoa_token_revoke: missing token → 404",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await callRevoke(`Bearer ${owner.accessToken}`, {
      token_id: crypto.randomUUID(),
    });
    assertEquals(result.status, 404);
  },
});

Deno.test({
  name: "verify_byoa_token (SQL): valid token → character_id, revoked → NULL",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Mint a fresh token so we can verify-before-revoke and verify-after-revoke.
    const mint = await callMint(`Bearer ${owner.accessToken}`, {
      character_id: ownerCharacterId,
      label: "sql-verify",
    });
    const token = mint.body.token as string;
    const tokenId = mint.body.token_id as string;

    const pg = new Client(getPgUrl());
    try {
      await pg.connect();

      const okRows = await pg.queryObject<{ verify_byoa_token: string | null }>(
        "SELECT public.verify_byoa_token($1) AS verify_byoa_token",
        [token],
      );
      assertEquals(okRows.rows[0].verify_byoa_token, ownerCharacterId);

      // The previous call should have updated last_used_at.
      const lastUsedRows = await pg.queryObject<{ last_used_at: Date | null }>(
        "SELECT last_used_at FROM public.byoa_tokens WHERE token_id = $1",
        [tokenId],
      );
      assertExists(lastUsedRows.rows[0].last_used_at);

      // Now revoke and re-verify — should return NULL.
      await callRevoke(`Bearer ${owner.accessToken}`, { token_id: tokenId });
      const revokedRows = await pg.queryObject<{ verify_byoa_token: string | null }>(
        "SELECT public.verify_byoa_token($1) AS verify_byoa_token",
        [token],
      );
      assertEquals(revokedRows.rows[0].verify_byoa_token, null);
    } finally {
      await pg.end();
    }
  },
});
