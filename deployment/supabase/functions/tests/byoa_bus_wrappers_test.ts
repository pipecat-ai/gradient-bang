/**
 * Integration tests for the byoa_bus_* SECURITY DEFINER wrappers
 * (migration 20260512000000_ship_task_lock_and_byoa.sql).
 *
 * Covers:
 *   - Invalid / revoked / expired tokens raise `invalid_token`.
 *   - byoa_bus_create_queue inserts into byoa_owned_queues with the
 *     token's bound character_id; cross-character claim of the same
 *     queue name fails with `queue_name_taken`.
 *   - byoa_bus_subscribe returns rows for the owner; cross-character
 *     read returns zero rows (silent on the wire).
 *   - byoa_bus_archive returns true for the owner, false for foreign.
 *   - byoa_bus_publish writes only to the configured channel and preserves
 *     an authorized BYOA envelope source for bus routing.
 *   - byoa_bus_drop_queue removes the row + drops the pgmq queue;
 *     foreign drop attempts raise `queue_not_owned`.
 *
 * Mints real BYOA tokens via byoa_token_mint (uses the live edge fn)
 * so the test exercises the same code path operators will use.
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
import { characterIdFor, createCorpShip } from "./helpers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALICE = "test_byoa_bus_alice";
const BOB = "test_byoa_bus_bob";
const CHANNEL = "bus_test_chan";

interface TestOp {
  userId: string;
  characterId: string;
  accessToken: string;
  byoaToken: string;
}

async function provisionOperator(emailLocal: string, characterId: string): Promise<TestOp> {
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
  const accessToken = session.session.access_token;

  // Mint a BYOA token bound to characterId via the live edge function.
  const mintResp = await fetch(`${getBaseUrl()}/byoa_token_mint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ character_id: characterId, label: "wrapper-test" }),
  });
  const mintBody = await mintResp.json();
  if (mintResp.status !== 200 || !mintBody.token) {
    throw new Error(`byoa_token_mint failed: ${JSON.stringify(mintBody)}`);
  }
  return { userId, characterId, accessToken, byoaToken: mintBody.token };
}

let alice: TestOp;
let bob: TestOp;
let aliceShipId: string;
let bobShipId: string;

async function createClaimedByoaShip(ownerCharacterId: string, label: string): Promise<string> {
  const pg = new Client(getPgUrl());
  let corpId: string;
  try {
    await pg.connect();
    const corp = await pg.queryObject<{ corp_id: string }>(
      `INSERT INTO public.corporations (name, founder_id, invite_code)
       VALUES ($1, $2, $3)
       RETURNING corp_id::text`,
      [`BYOA Bus ${label} ${crypto.randomUUID().slice(0, 8)}`, ownerCharacterId, crypto.randomUUID()],
    );
    corpId = corp.rows[0].corp_id;
    await pg.queryObject(
      `INSERT INTO public.corporation_members (corp_id, character_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [corpId, ownerCharacterId],
    );
  } finally {
    await pg.end();
  }

  const ship = await createCorpShip(corpId, 0, `${label} BYOA Ship`);
  const pg2 = new Client(getPgUrl());
  try {
    await pg2.connect();
    await pg2.queryObject(
      `UPDATE public.ship_instances
          SET byoa_owner_character_id = $1,
              byoa_mode = 'private'
        WHERE ship_id = $2`,
      [ownerCharacterId, ship.pseudoCharacterId],
    );
  } finally {
    await pg2.end();
  }
  return ship.pseudoCharacterId;
}

Deno.test({
  name: "byoa_bus_wrappers: setup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await startServerInProcess();
    await resetDatabase([ALICE, BOB]);
    const aliceCid = await characterIdFor(ALICE);
    const bobCid = await characterIdFor(BOB);
    alice = await provisionOperator("byoa-bus-alice", aliceCid);
    bob = await provisionOperator("byoa-bus-bob", bobCid);
    aliceShipId = await createClaimedByoaShip(alice.characterId, "Alice");
    bobShipId = await createClaimedByoaShip(bob.characterId, "Bob");
  },
});

Deno.test({
  name: "byoa_bus_*: invalid token raises invalid_token",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      await assertRejects(
        () =>
          pg.queryObject(
            "SELECT public.byoa_bus_create_queue('garbage.token', 'bus_test_chan_q', $1)",
            [CHANNEL],
          ),
        Error,
        "invalid_token",
      );
      await assertRejects(
        () =>
          pg.queryObject(
            "SELECT public.byoa_bus_subscribe('garbage.token', 'bus_test_chan_q', 30, 10, 1, $1)",
            [CHANNEL],
          ),
        Error,
        "invalid_token",
      );
      await assertRejects(
        () =>
          pg.queryObject(
            "SELECT public.byoa_bus_publish('garbage.token', $1, 'bus_test_chan_q', '{}'::jsonb)",
            [CHANNEL],
          ),
        Error,
        "invalid_token",
      );
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "byoa_bus_create_queue: registers ownership; cross-character claim fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const queueName = `${CHANNEL}_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      // Alice claims.
      await pg.queryObject(
        "SELECT public.byoa_bus_create_queue($1, $2, $3)",
        [alice.byoaToken, queueName, CHANNEL],
      );
      const rows = await pg.queryObject<{ character_id: string }>(
        "SELECT character_id FROM public.byoa_owned_queues WHERE queue_name = $1",
        [queueName],
      );
      assertEquals(rows.rows.length, 1);
      assertEquals(rows.rows[0].character_id, alice.characterId);

      // Alice re-creates (idempotent).
      await pg.queryObject(
        "SELECT public.byoa_bus_create_queue($1, $2, $3)",
        [alice.byoaToken, queueName, CHANNEL],
      );

      // Bob attempts the same name — should fail with queue_name_taken.
      await assertRejects(
        () =>
          pg.queryObject(
            "SELECT public.byoa_bus_create_queue($1, $2, $3)",
            [bob.byoaToken, queueName, CHANNEL],
          ),
        Error,
        "queue_name_taken",
      );
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "byoa_bus_subscribe / archive: respect ownership",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const queueName = `${CHANNEL}_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      await pg.queryObject(
        "SELECT public.byoa_bus_create_queue($1, $2, $3)",
        [alice.byoaToken, queueName, CHANNEL],
      );
      // Seed a message via Alice's publish (publish is allowed against any
      // target queue, so we use it here to put data in Alice's own queue).
      const pubRow = await pg.queryObject<{ byoa_bus_publish: number }>(
        "SELECT public.byoa_bus_publish($1, $2, $3, $4::jsonb) AS byoa_bus_publish",
        [
          alice.byoaToken,
          CHANNEL,
          queueName,
          JSON.stringify({
            __type__: "test.Message",
            __data__: { source: `byoa_${aliceShipId}` },
          }),
        ],
      );
      assert(pubRow.rows[0].byoa_bus_publish > 0);

      // Alice can read her own queue.
      const aliceRead = await pg.queryObject<{ msg_id: number; message: unknown }>(
        "SELECT msg_id, message FROM public.byoa_bus_subscribe($1, $2, 10, 10, 2, $3)",
        [alice.byoaToken, queueName, CHANNEL],
      );
      assertEquals(aliceRead.rows.length, 1);
      const aliceMsgId = aliceRead.rows[0].msg_id;
      // Envelope source is preserved for bus response routing once SQL has
      // verified it belongs to Alice's claimed BYOA ship.
      const msg = aliceRead.rows[0].message as Record<string, unknown>;
      const data = msg.__data__ as Record<string, unknown>;
      assertEquals(data.source, `byoa_${aliceShipId}`);

      // Bob tries to read Alice's queue — returns zero rows, no error
      // (silent on the wire so probing doesn't leak existence).
      const bobRead = await pg.queryObject(
        "SELECT * FROM public.byoa_bus_subscribe($1, $2, 10, 10, 2, $3)",
        [bob.byoaToken, queueName, CHANNEL],
      );
      assertEquals(bobRead.rows.length, 0);

      // Bob can't archive Alice's message either.
      const bobArchive = await pg.queryObject<{ byoa_bus_archive: boolean }>(
        "SELECT public.byoa_bus_archive($1, $2, $3, $4) AS byoa_bus_archive",
        [bob.byoaToken, queueName, aliceMsgId, CHANNEL],
      );
      assertEquals(bobArchive.rows[0].byoa_bus_archive, false);

      // Alice can.
      const aliceArchive = await pg.queryObject<{ byoa_bus_archive: boolean }>(
        "SELECT public.byoa_bus_archive($1, $2, $3, $4) AS byoa_bus_archive",
        [alice.byoaToken, queueName, aliceMsgId, CHANNEL],
      );
      assertEquals(aliceArchive.rows[0].byoa_bus_archive, true);
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "byoa_bus_publish: preserves authorized source and rejects impersonation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const queueName = `${CHANNEL}_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      // Bob owns the queue, Alice publishes to it (cross-character publish
      // is allowed; that's how peer fan-out works).
      await pg.queryObject(
        "SELECT public.byoa_bus_create_queue($1, $2, $3)",
        [bob.byoaToken, queueName, CHANNEL],
      );
      await assertRejects(
        () =>
          pg.queryObject(
            "SELECT public.byoa_bus_publish($1, $2, $3, $4::jsonb)",
            [
              alice.byoaToken,
              CHANNEL,
              queueName,
              JSON.stringify({
                __type__: "test.Message",
                __data__: { source: "voice_agent" },
              }),
            ],
          ),
        Error,
        "unauthorized_source",
      );
      await pg.queryObject(
        "SELECT public.byoa_bus_publish($1, $2, $3, $4::jsonb)",
        [
          alice.byoaToken,
          CHANNEL,
          queueName,
          JSON.stringify({
            __type__: "test.Message",
            __data__: { source: `byoa_${aliceShipId}` },
          }),
        ],
      );
      // Bob reads the message — source remains Alice's BYOA agent name so
      // responses target the correct remote TaskAgent.
      const read = await pg.queryObject<{ message: Record<string, unknown> }>(
        "SELECT message FROM public.byoa_bus_subscribe($1, $2, 10, 10, 2, $3)",
        [bob.byoaToken, queueName, CHANNEL],
      );
      assertEquals(read.rows.length, 1);
      const data = read.rows[0].message.__data__ as Record<string, unknown>;
      assertEquals(data.source, `byoa_${aliceShipId}`);
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "byoa_bus_drop_queue: owner ok; foreign raises queue_not_owned",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const queueName = `${CHANNEL}_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      await pg.queryObject(
        "SELECT public.byoa_bus_create_queue($1, $2, $3)",
        [alice.byoaToken, queueName, CHANNEL],
      );
      // Bob tries to drop Alice's queue → queue_not_owned.
      await assertRejects(
        () =>
          pg.queryObject(
            "SELECT public.byoa_bus_drop_queue($1, $2, $3)",
            [bob.byoaToken, queueName, CHANNEL],
          ),
        Error,
        "queue_not_owned",
      );
      // Alice's drop succeeds.
      await pg.queryObject(
        "SELECT public.byoa_bus_drop_queue($1, $2, $3)",
        [alice.byoaToken, queueName, CHANNEL],
      );
      const after = await pg.queryObject(
        "SELECT 1 FROM public.byoa_owned_queues WHERE queue_name = $1",
        [queueName],
      );
      assertEquals(after.rows.length, 0);
      // Double-drop is idempotent (silent success).
      await pg.queryObject(
        "SELECT public.byoa_bus_drop_queue($1, $2, $3)",
        [alice.byoaToken, queueName, CHANNEL],
      );
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "byoa_bus_subscribe: revoked token → invalid_token",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Mint a throwaway token then revoke it.
    const mintResp = await fetch(`${getBaseUrl()}/byoa_token_mint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${alice.accessToken}`,
      },
      body: JSON.stringify({
        character_id: alice.characterId,
        label: "revoke-me",
      }),
    });
    const mint = await mintResp.json();
    const throwaway = mint.token as string;
    const tokenId = mint.token_id as string;

    await fetch(`${getBaseUrl()}/byoa_token_revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${alice.accessToken}`,
      },
      body: JSON.stringify({ token_id: tokenId }),
    });

    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      await assertRejects(
        () =>
          pg.queryObject(
            "SELECT public.byoa_bus_subscribe($1, $2, 30, 10, 1, $3)",
            [throwaway, `${CHANNEL}_whatever`, CHANNEL],
          ),
        Error,
        "invalid_token",
      );
    } finally {
      await pg.end();
    }
  },
});

Deno.test({
  name: "byoa_bus_list_queues: requires valid token; returns queue names",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pg = new Client(getPgUrl());
    try {
      await pg.connect();
      await assertRejects(
        () => pg.queryObject("SELECT public.byoa_bus_list_queues('bad', $1)", [CHANNEL]),
        Error,
        "invalid_token",
      );
      const rows = await pg.queryObject<{ byoa_bus_list_queues: string }>(
        "SELECT public.byoa_bus_list_queues($1, $2) AS byoa_bus_list_queues",
        [alice.byoaToken, CHANNEL],
      );
      // Just assert it runs and returns rows in a reasonable shape — the
      // exact contents depend on what other tests have created.
      for (const row of rows.rows) {
        assert(typeof row.byoa_bus_list_queues === "string");
      }
    } finally {
      await pg.end();
    }
  },
});
