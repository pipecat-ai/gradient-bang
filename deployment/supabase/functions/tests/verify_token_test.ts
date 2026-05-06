/**
 * Integration tests for the verify_token edge function.
 *
 * Tests the JWT exchange path: real Supabase Auth user → access_token →
 * verify_token → internal HS256 token → SQL roundtrip via subscribe_my_events.
 *
 * Setup creates a test user in auth.users, links them to a test character via
 * user_characters, and signs in to get a real access_token (so we exercise
 * the actual ES256/HS256 verification path inside getAuthenticatedUser).
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { Client } from "postgres";

import {
  getBaseUrl,
  getPgUrl,
  resetDatabase,
  startServerInProcess,
} from "./harness.ts";
import { characterIdFor, queryCharacter } from "./helpers.ts";

// SUPABASE_URL is the real Supabase API (Auth lives there). TEST_BASE_URL
// is the in-process server (where verify_token runs with PUBSUB_INTERNAL_SECRET
// available in the test process env).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const OWNER = "test_verify_owner";
const STRANGER = "test_verify_stranger";

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("not a 3-part JWT");
  const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  return JSON.parse(json);
}

interface TestUser {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
}

/**
 * Create an auth.users row + sign in to get a real access_token. Links the
 * user to `characterId` via user_characters so can_user_access_character
 * returns true.
 */
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
    throw new Error(
      `admin.createUser failed: ${createErr?.message ?? "no user"}`,
    );
  }
  const userId = created.user.id;

  // Link user to the test character via user_characters
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

  // Sign in (anon client) to get an access_token
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: session, error: signinErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signinErr || !session.session?.access_token) {
    throw new Error(
      `signInWithPassword failed: ${signinErr?.message ?? "no session"}`,
    );
  }

  return { userId, email, password, accessToken: session.session.access_token };
}

async function callVerifyToken(
  characterId: string | undefined,
  authHeader: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Hit the in-process server so PUBSUB_INTERNAL_SECRET (set in the test
  // process env by run_tests.sh) is visible to the verify_token handler.
  const url = `${getBaseUrl()}/verify_token`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== null) headers["Authorization"] = authHeader;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(characterId !== undefined ? { character_id: characterId } : {}),
  });
  return { status: resp.status, body: await resp.json() };
}

let ownerId = "";
let strangerId = "";
let owner: TestUser;

Deno.test({
  name: "verify_token: setup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await startServerInProcess();
    await resetDatabase([OWNER, STRANGER]);
    ownerId = await characterIdFor(OWNER);
    strangerId = await characterIdFor(STRANGER);
    // Confirm test_reset created the characters
    await queryCharacter(ownerId);
    await queryCharacter(strangerId);
    owner = await provisionUser("verify-owner", ownerId);
  },
});

Deno.test({
  name: "verify_token: happy path returns internal HS256 token with correct claims",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await callVerifyToken(
      ownerId,
      `Bearer ${owner.accessToken}`,
    );
    assertEquals(result.status, 200, `body=${JSON.stringify(result.body)}`);
    assert(result.body.success === true);
    const token = result.body.token as string;
    const expiresAt = result.body.expires_at as number;
    assertExists(token, "missing token in response");
    assertExists(expiresAt, "missing expires_at in response");

    const claims = decodeJwtPayload(token);
    assertEquals(claims.sub, owner.userId);
    assertEquals(claims.character_id, ownerId);
    assertEquals(claims.iss, "verify_token");
    assert(typeof claims.exp === "number");
    assert((claims.exp as number) > Math.floor(Date.now() / 1000));
  },
});

Deno.test({
  name: "verify_token: missing Authorization → 401",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await callVerifyToken(ownerId, null);
    assertEquals(result.status, 401);
    assert(result.body.success === false);
  },
});

Deno.test({
  name: "verify_token: stranger character (not owned) → 403 forbidden",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await callVerifyToken(
      strangerId,
      `Bearer ${owner.accessToken}`,
    );
    assertEquals(result.status, 403);
    assert(result.body.success === false);
    assertStringIncludes(String(result.body.error), "forbidden");
  },
});

Deno.test({
  name:
    "verify_token: SQL roundtrip — returned token is accepted by subscribe_my_events",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const minted = await callVerifyToken(
      ownerId,
      `Bearer ${owner.accessToken}`,
    );
    assertEquals(minted.status, 200);
    const internalToken = minted.body.token as string;

    // Call subscribe_my_events directly with a tiny poll window. Should
    // return zero rows but NOT raise — proving the edge-minted token
    // verifies cleanly inside the SQL function.
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      const result = await pg.queryObject(
        "SELECT * FROM public.subscribe_my_events($1, $2, $3, $4)",
        [ownerId, internalToken, 1 /* max_seconds */, 1 /* qty */],
      );
      // Empty queue → zero rows. No exception is the assertion.
      assert(Array.isArray(result.rows));
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name:
    "verify_token: SQL rejects token used against a different character",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Owner mints a token for THEIR character, then tries to use it against
    // the stranger's queue. SQL function should raise `forbidden` because of
    // the character_id claim check.
    const minted = await callVerifyToken(
      ownerId,
      `Bearer ${owner.accessToken}`,
    );
    const internalToken = minted.body.token as string;

    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      let raised = false;
      let message = "";
      try {
        await pg.queryObject(
          "SELECT * FROM public.subscribe_my_events($1, $2, $3, $4)",
          [strangerId, internalToken, 1, 1],
        );
      } catch (err) {
        raised = true;
        message = err instanceof Error ? err.message : String(err);
      }
      assert(raised, "expected SQL function to raise");
      assertStringIncludes(message, "forbidden");
    } finally {
      await pg.end();
    }
  },
});
