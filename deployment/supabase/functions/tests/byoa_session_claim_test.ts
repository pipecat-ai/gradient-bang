/**
 * byoa_session_claim edge-function tests.
 *
 * Covers the BYOA discovery flow: HS256 token auth, character-ship
 * authorization (private vs shared corp ship), and the channel/lifecycle
 * response shape. Pre-allocates sessions by calling wake_agent so the
 * tests exercise the real wake → claim handoff.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { Client } from "postgres";

import {
  getBaseUrl,
  getPgUrl,
  resetDatabase,
  startServerInProcess,
} from "./harness.ts";
import {
  apiOk,
  characterIdFor,
  createCorpShip,
  setShipCredits,
  shipIdFor,
  withPg,
} from "./helpers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const OWNER = "test_claim_owner";
const MEMBER = "test_claim_member";
const STRANGER = "test_claim_stranger";

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
  const { data: session, error: signinErr } = await anon.auth.signInWithPassword(
    { email, password },
  );
  if (signinErr || !session.session?.access_token) {
    throw new Error(`signInWithPassword failed: ${signinErr?.message}`);
  }
  return { userId, accessToken: session.session.access_token };
}

async function mintToken(
  user: TestUser,
  characterId: string,
): Promise<string> {
  const resp = await fetch(`${getBaseUrl()}/byoa_token_mint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${user.accessToken}`,
    },
    body: JSON.stringify({
      character_id: characterId,
      label: "claim-test",
      ttl_days: 1,
    }),
  });
  const body = await resp.json();
  if (resp.status !== 200) {
    throw new Error(`mint failed: ${JSON.stringify(body)}`);
  }
  return body.token as string;
}

async function callClaim(
  token: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetch(`${getBaseUrl()}/byoa_session_claim`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json() };
}

async function acquireLockOn(shipId: string, taskId: string, actorId: string) {
  await withPg(async (pg) => {
    await pg.queryObject(
      `SELECT acquire_ship_task_lock($1::uuid, $2::uuid, $3::uuid, 180, 30)`,
      [shipId, taskId, actorId],
    );
  });
}

let ownerCharId = "";
let memberCharId = "";
let strangerCharId = "";
let ownerUser: TestUser;
let memberUser: TestUser;
let strangerUser: TestUser;

let ownerToken = "";
let memberToken = "";
let strangerToken = "";

let corpShipId = "";

Deno.test({
  name: "byoa_session_claim — setup",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
    await resetDatabase([OWNER, MEMBER, STRANGER]);
    ownerCharId = await characterIdFor(OWNER);
    memberCharId = await characterIdFor(MEMBER);
    strangerCharId = await characterIdFor(STRANGER);
    await apiOk("join", { character_id: ownerCharId });
    await apiOk("join", { character_id: memberCharId });
    await apiOk("join", { character_id: strangerCharId });
    const ownerShipId = await shipIdFor(OWNER);
    await setShipCredits(ownerShipId, 50_000);

    // Owner founds a corp, member joins.
    const corp = await apiOk("corporation_create", {
      character_id: ownerCharId,
      name: "Claim Test Corp",
    });
    const corpId = (corp as Record<string, unknown>).corp_id as string;
    await withPg(async (pg) => {
      await pg.queryObject(
        `INSERT INTO corporation_members (corp_id, character_id, joined_at)
         VALUES ($1, $2, NOW())`,
        [corpId, memberCharId],
      );
    });
    const ship = await createCorpShip(corpId, 0, "Claim Probe");
    corpShipId = ship.pseudoCharacterId;

    // Owner claims as BYOA (private by default).
    await apiOk("ship_byoa_configure", {
      character_id: ownerCharId,
      ship_id: corpShipId,
      action: "claim",
      mode: "private",
    });

    ownerUser = await provisionUser("claim-owner", ownerCharId);
    memberUser = await provisionUser("claim-member", memberCharId);
    strangerUser = await provisionUser("claim-stranger", strangerCharId);

    ownerToken = await mintToken(ownerUser, ownerCharId);
    memberToken = await mintToken(memberUser, memberCharId);
    strangerToken = await mintToken(strangerUser, strangerCharId);
  },
});

Deno.test({
  name: "byoa_session_claim — owner gets channel after wake_agent allocates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const taskId = crypto.randomUUID();
    const channel = "bot_session_claim_1";
    await acquireLockOn(corpShipId, taskId, ownerCharId);
    await apiOk("wake_agent", {
      ship_id: corpShipId,
      character_id: ownerCharId,
      task_id: taskId,
      channel,
    });

    const result = await callClaim(ownerToken, { ship_id: corpShipId });
    assertEquals(result.status, 200);
    assertEquals(result.body.channel, channel);
    assertEquals(result.body.current_task_id, taskId);
    assert(typeof result.body.lifecycle_hint === "string");
  },
});

Deno.test({
  name: "byoa_session_claim — no session allocated returns channel:null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Clear any allocated session from the previous test by releasing the lock.
    await withPg(async (pg) => {
      await pg.queryObject(
        `UPDATE ship_instances
            SET current_task_id            = NULL,
                task_started_at            = NULL,
                task_actor_character_id    = NULL,
                task_last_heartbeat_at     = NULL,
                byoa_session_channel       = NULL,
                byoa_session_allocated_at  = NULL
          WHERE ship_id = $1::uuid`,
        [corpShipId],
      );
    });
    const result = await callClaim(ownerToken, { ship_id: corpShipId });
    assertEquals(result.status, 200);
    assertEquals(result.body.channel, null);
    assertEquals(result.body.current_task_id, null);
  },
});

Deno.test({
  name: "byoa_session_claim — missing token returns 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const result = await callClaim(null, { ship_id: corpShipId });
    assertEquals(result.status, 401);
  },
});

Deno.test({
  name: "byoa_session_claim — invalid token returns 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const result = await callClaim("not-a-real-jwt", { ship_id: corpShipId });
    assertEquals(result.status, 401);
  },
});

Deno.test({
  name: "byoa_session_claim — stranger on private ship returns 403",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const result = await callClaim(strangerToken, { ship_id: corpShipId });
    assertEquals(result.status, 403);
  },
});

Deno.test({
  name: "byoa_session_claim — corp member on private ship returns 403",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Private mode = only the BYOA owner character can claim.
    const result = await callClaim(memberToken, { ship_id: corpShipId });
    assertEquals(result.status, 403);
  },
});

Deno.test({
  name: "byoa_session_claim — corp member on shared ship can claim",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Flip the ship to shared mode.
    await apiOk("ship_byoa_configure", {
      character_id: ownerCharId,
      ship_id: corpShipId,
      action: "configure",
      mode: "shared",
    });

    // Allocate a session so the claim has something to return.
    const taskId = crypto.randomUUID();
    const channel = "bot_session_claim_shared";
    await acquireLockOn(corpShipId, taskId, ownerCharId);
    await apiOk("wake_agent", {
      ship_id: corpShipId,
      character_id: ownerCharId,
      task_id: taskId,
      channel,
    });

    const result = await callClaim(memberToken, { ship_id: corpShipId });
    assertEquals(result.status, 200);
    assertEquals(result.body.channel, channel);

    // Stranger (not a corp member) still 403 even in shared mode.
    const strangerResult = await callClaim(strangerToken, {
      ship_id: corpShipId,
    });
    assertEquals(strangerResult.status, 403);
  },
});

Deno.test({
  name: "byoa_session_claim — invalid ship_id returns 400",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const result = await callClaim(ownerToken, { ship_id: "not-a-uuid" });
    assertEquals(result.status, 400);
  },
});

Deno.test({
  name: "byoa_session_claim — unknown ship_id returns 404",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const result = await callClaim(ownerToken, {
      ship_id: crypto.randomUUID(),
    });
    assertEquals(result.status, 404);
  },
});
