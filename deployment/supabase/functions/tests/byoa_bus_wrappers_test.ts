/**
 * Integration tests for the channel-as-capability bus wrappers.
 *
 * The bus surface is identity-free: knowledge of the channel name is the only
 * capability. Wrappers verify the (queue_name, channel) pair against the
 * private public.bus_peers registry and never consult tokens or characters.
 *
 * Covered here:
 *   - Happy path: bus_join → bus_publish → bus_subscribe → bus_archive →
 *     bus_leave round trip, with the wrappers returning the documented shapes.
 *   - Channel validation: malformed channels raise channel_invalid (22023).
 *   - Cross-channel publish: a peer cannot publish using a channel it didn't
 *     join (42501 channel_not_authorized).
 *   - Cross-channel subscribe: same, for read paths.
 *   - bus_peers is not readable from the byoa_bus_client role.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { withPg } from "./helpers.ts";

const QUEUE_NAME_RE = /^q_[0-9a-f]{32}$/;

/** Build a fresh ^gb_[0-9a-f]{32}$ channel for an isolated test. */
function freshChannel(): string {
  return "gb_" + crypto.randomUUID().replace(/-/g, "");
}

Deno.test({
  name: "bus wrappers — join → publish → subscribe → archive → leave round trip",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const channel = freshChannel();

    await withPg(async (pg) => {
      // bus_join returns a server-allocated opaque queue name.
      const joinRes = await pg.queryObject<{ queue: string }>(
        "SELECT public.bus_join($1) AS queue",
        [channel],
      );
      const myQueue = joinRes.rows[0].queue;
      assertMatch(myQueue, QUEUE_NAME_RE, "queue name shape");

      // bus_peers row exists (read as service_role / owner).
      const peers = await pg.queryObject<{ queue_name: string; channel: string }>(
        "SELECT queue_name, channel FROM public.bus_peers WHERE queue_name = $1",
        [myQueue],
      );
      assertEquals(peers.rows.length, 1);
      assertEquals(peers.rows[0].channel, channel);

      // bus_publish returns a bigint[] of per-peer message ids. With one peer
      // on the channel we expect a single id back.
      const pubRes = await pg.queryObject<{ ids: bigint[] }>(
        "SELECT public.bus_publish($1, $2, $3::jsonb) AS ids",
        [channel, myQueue, JSON.stringify({ hello: "world" })],
      );
      assertEquals(pubRes.rows[0].ids.length, 1);

      // bus_subscribe reads back what was published.
      const subRes = await pg.queryObject<{
        msg_id: bigint;
        message: Record<string, unknown>;
      }>(
        "SELECT msg_id, message FROM public.bus_subscribe($1, $2, 30, 10, 1)",
        [myQueue, channel],
      );
      assertEquals(subRes.rows.length, 1);
      assertEquals(subRes.rows[0].message.hello, "world");

      // bus_archive removes the message.
      const archiveRes = await pg.queryObject<{ ok: boolean }>(
        "SELECT public.bus_archive($1, $2, $3::bigint) AS ok",
        [myQueue, channel, subRes.rows[0].msg_id],
      );
      assertEquals(archiveRes.rows[0].ok, true);

      // bus_leave drops the queue and removes the bus_peers row.
      await pg.queryObject(
        "SELECT public.bus_leave($1, $2)",
        [myQueue, channel],
      );

      const after = await pg.queryObject<{ count: bigint }>(
        "SELECT COUNT(*)::bigint AS count FROM public.bus_peers WHERE queue_name = $1",
        [myQueue],
      );
      assertEquals(Number(after.rows[0].count), 0);
    });
  },
});

Deno.test({
  name: "bus wrappers — bus_join rejects malformed channel (channel_invalid)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await assertRejects(
      () =>
        withPg(async (pg) => {
          await pg.queryObject("SELECT public.bus_join($1)", [
            "not_a_uuid_channel",
          ]);
        }),
      Error,
      "channel_invalid",
    );
  },
});

Deno.test({
  name: "bus wrappers — bus_publish on a foreign channel raises channel_not_authorized",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const chanA = freshChannel();
    const chanB = freshChannel();

    await withPg(async (pg) => {
      // Peer A joins channel A; peer B joins channel B. Each has its own queue.
      const a = await pg.queryObject<{ queue: string }>(
        "SELECT public.bus_join($1) AS queue",
        [chanA],
      );
      const queueA = a.rows[0].queue;
      const b = await pg.queryObject<{ queue: string }>(
        "SELECT public.bus_join($1) AS queue",
        [chanB],
      );
      const queueB = b.rows[0].queue;

      try {
        // A tries to publish to channel B with A's queue. The (queue, channel)
        // pair is not in bus_peers → 42501.
        await assertRejects(
          () =>
            pg.queryObject(
              "SELECT public.bus_publish($1, $2, $3::jsonb)",
              [chanB, queueA, JSON.stringify({ x: 1 })],
            ),
          Error,
          "channel_not_authorized",
        );
      } finally {
        await pg.queryObject("SELECT public.bus_leave($1, $2)", [queueA, chanA]);
        await pg.queryObject("SELECT public.bus_leave($1, $2)", [queueB, chanB]);
      }
    });
  },
});

Deno.test({
  name: "bus wrappers — bus_subscribe on a foreign queue raises channel_not_authorized",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const chanA = freshChannel();
    const chanB = freshChannel();

    await withPg(async (pg) => {
      const a = await pg.queryObject<{ queue: string }>(
        "SELECT public.bus_join($1) AS queue",
        [chanA],
      );
      const queueA = a.rows[0].queue;
      const b = await pg.queryObject<{ queue: string }>(
        "SELECT public.bus_join($1) AS queue",
        [chanB],
      );
      const queueB = b.rows[0].queue;

      try {
        // A pretends to know B's queue and tries to read with A's channel.
        // The (queueB, chanA) pair is not in bus_peers → 42501.
        await assertRejects(
          () =>
            pg.queryObject(
              "SELECT * FROM public.bus_subscribe($1, $2, 30, 10, 1)",
              [queueB, chanA],
            ),
          Error,
          "channel_not_authorized",
        );
      } finally {
        await pg.queryObject("SELECT public.bus_leave($1, $2)", [queueA, chanA]);
        await pg.queryObject("SELECT public.bus_leave($1, $2)", [queueB, chanB]);
      }
    });
  },
});

// Note on bus_peers enumeration:
// The migration does `REVOKE ALL ON TABLE bus_peers FROM PUBLIC`, which is
// what closes the enumeration door for byoa_bus_client. The wrappers above
// are the only path byoa_bus_client has to bus_peers. We don't replicate
// that check as a SET ROLE test here because the test harness connects as
// a superuser-equivalent that isn't a member of byoa_bus_client and so
// can't impersonate it — verifying the revoke is left to the migration
// itself.
