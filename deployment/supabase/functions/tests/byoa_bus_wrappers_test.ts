/**
 * Integration tests for BYOA bus SQL wrappers.
 *
 * This test exercises:
 *
 *   - Invalid / revoked tokens raise `invalid_token`.
 *   - A bound character that owns a BYOA ship can authorize a valid channel.
 *   - A bound character cannot authorize another character's BYOA ship.
 *   - Corp members who are not the BYOA owner are rejected.
 *   - Invalid channel names raise `channel_invalid`.
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
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

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
  const { data: created, error: createErr } = await admin.auth.admin.createUser(
    {
      email,
      password,
      email_confirm: true,
    },
  );
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
  const { data: session, error: signinErr } = await anon.auth
    .signInWithPassword(
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

async function authorize(
  token: string,
  channel: string,
  shipId = corpShipId,
): Promise<unknown> {
  return await withPg(async (pg) => {
    const rows = await pg.queryObject<{ byoa_bus_authorize: unknown }>(
      "SELECT public.byoa_bus_authorize($1, $2, $3::uuid) AS byoa_bus_authorize",
      [token, channel, shipId],
    );
    return rows.rows[0].byoa_bus_authorize;
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
  name: "byoa_bus_authorize — owner authorizes a valid session channel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const channel = "bot_bus_auth_1";
    const result = (await authorize(ownerToken, channel)) as Record<
      string,
      unknown
    >;
    assertEquals(result.character_id, ownerCharId);
    assertEquals(result.ship_id, corpShipId);
    assertEquals(result.channel, channel);
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
  name: "byoa_bus_authorize — invalid channel raises",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertRejects(
      () => authorize(ownerToken, "not allowed"),
      Error,
      "channel_invalid",
    );
  },
});

Deno.test({
  name:
    "byoa_bus_authorize — stranger raises channel_not_authorized on private",
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
  name: "byoa_bus_authorize — corp member who is not owner is rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertRejects(
      () => authorize(memberToken, "bot_bus_auth_1"),
      Error,
      "channel_not_authorized",
    );
  },
});
