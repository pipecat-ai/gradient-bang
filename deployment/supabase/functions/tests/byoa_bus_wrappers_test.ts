/**
 * Integration tests for byoa_bus_authorize SQL function (migration
 * 20260512000000_ship_task_lock_and_byoa.sql).
 *
 * Phase 3 (3/N) replaced the per-call byoa_bus_* wrapper family with a
 * single one-shot authorize call. This test exercises:
 *
 *   - Invalid / revoked tokens raise `invalid_token`.
 *   - A bound character that owns a BYOA ship can authorize that ship's
 *     currently-allocated channel.
 *   - A bound character cannot authorize a channel allocated to another
 *     character's BYOA ship (`channel_not_authorized`).
 *   - A bound character cannot authorize a channel that is not currently
 *     allocated to any ship (`channel_not_allocated`).
 *   - Shared-mode corp ships authorize any active corp member.
 *
 * Mints real BYOA tokens via byoa_token_mint (uses the live edge fn).
 */

import {
  assert,
  assertEquals,
  assertRejects,
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

const OWNER = "test_bus_owner";
const MEMBER = "test_bus_member";
const STRANGER = "test_bus_stranger";

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

async function mintToken(user: TestUser, characterId: string): Promise<string> {
  const resp = await fetch(`${getBaseUrl()}/byoa_token_mint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${user.accessToken}`,
    },
    body: JSON.stringify({
      character_id: characterId,
      label: "bus-test",
      ttl_days: 1,
    }),
  });
  const body = await resp.json();
  if (resp.status !== 200) {
    throw new Error(`mint failed: ${JSON.stringify(body)}`);
  }
  return body.token as string;
}

async function authorize(token: string, channel: string): Promise<unknown> {
  return await withPg(async (pg) => {
    const rows = await pg.queryObject<{ byoa_bus_authorize: unknown }>(
      "SELECT public.byoa_bus_authorize($1, $2) AS byoa_bus_authorize",
      [token, channel],
    );
    return rows.rows[0].byoa_bus_authorize;
  });
}

async function acquireLockOn(shipId: string, taskId: string, actorId: string) {
  await withPg(async (pg) => {
    await pg.queryObject(
      `SELECT acquire_ship_task_lock($1::uuid, $2::uuid, $3::uuid, 180, 30)`,
      [shipId, taskId, actorId],
    );
  });
}

async function allocateChannel(shipId: string, channel: string) {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances
          SET byoa_session_channel       = $1,
              byoa_session_allocated_at  = NOW()
        WHERE ship_id = $2::uuid`,
      [channel, shipId],
    );
  });
}

let ownerCharId = "";
let memberCharId = "";
let strangerCharId = "";
let ownerToken = "";
let memberToken = "";
let strangerToken = "";
let corpShipId = "";

Deno.test({
  name: "byoa_bus_authorize — setup",
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

    const corp = await apiOk("corporation_create", {
      character_id: ownerCharId,
      name: "Bus Auth Corp",
    });
    const corpId = (corp as Record<string, unknown>).corp_id as string;
    await withPg(async (pg) => {
      await pg.queryObject(
        `INSERT INTO corporation_members (corp_id, character_id, joined_at)
         VALUES ($1, $2, NOW())`,
        [corpId, memberCharId],
      );
    });
    const ship = await createCorpShip(corpId, 0, "Bus Auth Probe");
    corpShipId = ship.pseudoCharacterId;
    await apiOk("ship_byoa_configure", {
      character_id: ownerCharId,
      ship_id: corpShipId,
      action: "claim",
      mode: "private",
    });

    const ownerUser = await provisionUser("bus-owner", ownerCharId);
    const memberUser = await provisionUser("bus-member", memberCharId);
    const strangerUser = await provisionUser("bus-stranger", strangerCharId);
    ownerToken = await mintToken(ownerUser, ownerCharId);
    memberToken = await mintToken(memberUser, memberCharId);
    strangerToken = await mintToken(strangerUser, strangerCharId);
  },
});

Deno.test({
  name: "byoa_bus_authorize — owner authorizes their allocated channel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const channel = "bot_bus_auth_1";
    const taskId = crypto.randomUUID();
    await acquireLockOn(corpShipId, taskId, ownerCharId);
    await allocateChannel(corpShipId, channel);

    const result = (await authorize(ownerToken, channel)) as Record<
      string,
      unknown
    >;
    assertEquals(result.character_id, ownerCharId);
    assertEquals(result.ship_id, corpShipId);
    assertEquals(result.channel, channel);
    assert(typeof result.current_task_id === "string");
  },
});

Deno.test({
  name: "byoa_bus_authorize — invalid token raises",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertRejects(
      () => authorize("not-a-real-jwt", "bot_bus_auth_1"),
      Error,
      "invalid_token",
    );
  },
});

Deno.test({
  name: "byoa_bus_authorize — unallocated channel raises",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertRejects(
      () => authorize(ownerToken, "never_allocated"),
      Error,
      "channel_not_allocated",
    );
  },
});

Deno.test({
  name: "byoa_bus_authorize — stranger raises channel_not_authorized on private",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertRejects(
      () => authorize(strangerToken, "bot_bus_auth_1"),
      Error,
      "channel_not_authorized",
    );
  },
});

Deno.test({
  name: "byoa_bus_authorize — corp member on shared ship can authorize",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await apiOk("ship_byoa_configure", {
      character_id: ownerCharId,
      ship_id: corpShipId,
      action: "configure",
      mode: "shared",
    });
    const result = (await authorize(memberToken, "bot_bus_auth_1")) as Record<
      string,
      unknown
    >;
    assertEquals(result.character_id, memberCharId);
    assertEquals(result.ship_id, corpShipId);

    await assertRejects(
      () => authorize(strangerToken, "bot_bus_auth_1"),
      Error,
      "channel_not_authorized",
    );
  },
});
