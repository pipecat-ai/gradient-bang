/**
 * wake_agent edge-function tests.
 *
 * Covers the per-session channel allocation flow: standard authenticate +
 * canActOnCharacter, BYOA-ship guard, atomic write of byoa_session_channel
 * gated by the active task lock, and the {channel, spawn_target,
 * lifecycle_hint} response shape.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiOk,
  characterIdFor,
  createCorpShip,
  setShipCredits,
  shipIdFor,
  withPg,
} from "./helpers.ts";

const P1 = "test_wake_p1";
const P2 = "test_wake_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;

async function seedCorpWithMembers(
  founderId: string,
  members: string[],
  corpName: string,
): Promise<{ corpId: string; corpShipId: string }> {
  const createResult = await apiOk("corporation_create", {
    character_id: founderId,
    name: corpName,
  });
  const corpId = (createResult as Record<string, unknown>).corp_id as string;
  for (const memberId of members) {
    await withPg(async (pg) => {
      await pg.queryObject(
        `INSERT INTO corporation_members (corp_id, character_id, joined_at)
         VALUES ($1, $2, NOW())`,
        [corpId, memberId],
      );
    });
  }
  const ship = await createCorpShip(corpId, 0, `${corpName} Probe`);
  return { corpId, corpShipId: ship.pseudoCharacterId };
}

async function acquireLockOn(shipId: string, taskId: string, actorId: string) {
  await withPg(async (pg) => {
    await pg.queryObject(
      `SELECT force_release_ship_task_lock($1::uuid)`,
      [shipId],
    );
    await pg.queryObject(
      `SELECT acquire_ship_task_lock($1::uuid, $2::uuid, $3::uuid, 180, 30)`,
      [shipId, taskId, actorId],
    );
  });
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

Deno.test({
  name: "wake_agent — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

Deno.test({
  name: "wake_agent — allocates session channel on lock row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);

    let corpShipId: string;
    const taskId = crypto.randomUUID();
    const channel = "bot_session_abc";

    await t.step("seed corp + claim BYOA + acquire lock", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Wake Alloc Corp");
      corpShipId = seeded.corpShipId;
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      await acquireLockOn(corpShipId, taskId, p1Id);
    });

    await t.step(
      "idle registration without task_id → 200, channel recorded on row",
      async () => {
        const result = await apiOk("wake_agent", {
          ship_id: corpShipId,
          character_id: p1Id,
          channel,
        });
        const body = result as Record<string, unknown>;
        assertEquals(body.ship_id, corpShipId);
        assertEquals(body.channel, channel);
        assertEquals(body.spawn_target, "noop");
        assertEquals(body.spawn_status, "registered");

        await withPg(async (pg) => {
          const rows = await pg.queryObject<
            { byoa_session_channel: string | null }
          >(
            `SELECT byoa_session_channel FROM ship_instances WHERE ship_id = $1::uuid`,
            [corpShipId],
          );
          assertEquals(rows.rows[0].byoa_session_channel, channel);
        });
      },
    );

    await t.step("task wake → 200, channel refreshed on row", async () => {
      const result = await apiOk("wake_agent", {
        ship_id: corpShipId,
        character_id: p1Id,
        task_id: taskId,
        channel,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.ship_id, corpShipId);
      assertEquals(body.channel, channel);
      // lifecycle_hint reflects WAKE_TARGET (default noop in tests).
      assert(
        ["single_task", "idle_loop"].includes(body.lifecycle_hint as string),
      );
      assertEquals(body.spawn_target, "noop");
      assertEquals(body.spawn_status, "noop");

      // The session channel was actually written.
      await withPg(async (pg) => {
        const rows = await pg.queryObject<
          { byoa_session_channel: string | null }
        >(
          `SELECT byoa_session_channel FROM ship_instances WHERE ship_id = $1::uuid`,
          [corpShipId],
        );
        assertEquals(rows.rows[0].byoa_session_channel, channel);
      });
    });

    await t.step("invalid channel format → 400", async () => {
      const result = await api("wake_agent", {
        ship_id: corpShipId,
        character_id: p1Id,
        task_id: taskId,
        channel: "has spaces",
      });
      assertEquals(result.status, 400);
    });

    await t.step(
      "stale task_id (lock not held) → 409 lock_not_held",
      async () => {
        const result = await api("wake_agent", {
          ship_id: corpShipId,
          character_id: p1Id,
          task_id: crypto.randomUUID(),
          channel,
        });
        assertEquals(result.status, 409);
        assertEquals(
          (result.body as Record<string, unknown>).error,
          "lock_not_held",
        );
      },
    );

    await t.step("non-BYOA ship → 400 not_a_byoa_ship", async () => {
      const result = await api("wake_agent", {
        ship_id: p1ShipId,
        character_id: p1Id,
        channel,
      });
      assertEquals(result.status, 400);
      assertEquals(
        (result.body as Record<string, unknown>).error,
        "not_a_byoa_ship",
      );
    });

    await t.step("unknown ship_id → 404 ship_not_found", async () => {
      const result = await api("wake_agent", {
        ship_id: crypto.randomUUID(),
        character_id: p1Id,
        channel,
      });
      assertEquals(result.status, 404);
    });

    await t.step("invalid ship_id → 400", async () => {
      const result = await api("wake_agent", {
        ship_id: "not-a-uuid",
        character_id: p1Id,
        channel,
      });
      assertEquals(result.status, 400);
    });
  },
});

Deno.test({
  name: "wake_agent — http wake provider",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await startServerInProcess();
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);

    let corpShipId: string;
    let taskId = crypto.randomUUID();
    const channel = "bot_http_abc";

    await t.step("seed corp + claim BYOA + acquire lock", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Wake HTTP Corp");
      corpShipId = seeded.corpShipId;
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      await acquireLockOn(corpShipId, taskId, p1Id);
    });

    const envSnapshot = {
      WAKE_TARGET: Deno.env.get("WAKE_TARGET"),
      BYOA_WAKE_URL: Deno.env.get("BYOA_WAKE_URL"),
      EDGE_API_TOKEN: Deno.env.get("EDGE_API_TOKEN"),
      BYOA_BUS_DATABASE_URL: Deno.env.get("BYOA_BUS_DATABASE_URL"),
    };

    await t.step(
      "missing http provider env → visible spawn failure",
      async () => {
        try {
          Deno.env.set("WAKE_TARGET", "http");
          Deno.env.delete("BYOA_WAKE_URL");
          Deno.env.set("EDGE_API_TOKEN", "test-secret");
          Deno.env.set(
            "BYOA_BUS_DATABASE_URL",
            "postgresql://byoa_login:test@db/postgres",
          );

          const result = await apiOk("wake_agent", {
            ship_id: corpShipId,
            character_id: p1Id,
            task_id: taskId,
            channel,
          });
          const body = result as Record<string, unknown>;
          assertEquals(body.spawn_target, "http");
          assertEquals(body.spawn_status, "missing_byoa_wake_url");
        } finally {
          restoreEnv(envSnapshot);
        }
      },
    );

    await t.step(
      "http provider receives wake payload + bearer auth",
      async () => {
        taskId = crypto.randomUUID();
        await acquireLockOn(corpShipId, taskId, p1Id);

        let received = false;
        let receivedAuth = "";
        let receivedPayload: Record<string, unknown> = {};
        const provider = Deno.serve(
          { hostname: "127.0.0.1", port: 0 },
          async (req) => {
            received = true;
            receivedAuth = req.headers.get("Authorization") ?? "";
            receivedPayload = await req.json();
            return new Response(JSON.stringify({ success: true }), {
              status: 202,
              headers: { "Content-Type": "application/json" },
            });
          },
        );

        try {
          Deno.env.set("WAKE_TARGET", "http");
          Deno.env.set(
            "BYOA_WAKE_URL",
            `http://127.0.0.1:${provider.addr.port}/wake`,
          );
          Deno.env.set("EDGE_API_TOKEN", "test-secret");
          Deno.env.set(
            "BYOA_BUS_DATABASE_URL",
            "postgresql://byoa_login:test@db/postgres",
          );

          const result = await apiOk("wake_agent", {
            ship_id: corpShipId,
            character_id: p1Id,
            task_id: taskId,
            channel,
          });
          const body = result as Record<string, unknown>;
          assertEquals(body.spawn_target, "http");
          assertEquals(body.spawn_status, "accepted");
          assertEquals(receivedAuth, "Bearer test-secret");
          assert(received, "provider should receive wake payload");
          assertEquals(receivedPayload.ship_id, corpShipId);
          assertEquals(receivedPayload.channel, channel);
          assertEquals(receivedPayload.task_id, taskId);
          const env = receivedPayload.env as Record<string, unknown>;
          assertEquals(env.BYOA_CHANNEL, channel);
          assertEquals(env.BYOA_SHIP_ID, corpShipId);
          assertEquals(
            env.BYOA_BUS_DATABASE_URL,
            "postgresql://byoa_login:test@db/postgres",
          );
        } finally {
          await provider.shutdown();
          restoreEnv(envSnapshot);
        }
      },
    );

    await t.step("http provider non-2xx → visible spawn failure", async () => {
      taskId = crypto.randomUUID();
      await acquireLockOn(corpShipId, taskId, p1Id);

      const provider = Deno.serve(
        { hostname: "127.0.0.1", port: 0 },
        () => new Response("nope", { status: 503 }),
      );

      try {
        Deno.env.set("WAKE_TARGET", "http");
        Deno.env.set(
          "BYOA_WAKE_URL",
          `http://127.0.0.1:${provider.addr.port}/wake`,
        );
        Deno.env.set("EDGE_API_TOKEN", "test-secret");
        Deno.env.set(
          "BYOA_BUS_DATABASE_URL",
          "postgresql://byoa_login:test@db/postgres",
        );

        const result = await apiOk("wake_agent", {
          ship_id: corpShipId,
          character_id: p1Id,
          task_id: taskId,
          channel,
        });
        const body = result as Record<string, unknown>;
        assertEquals(body.spawn_target, "http");
        assertEquals(body.spawn_status, "http_503");
      } finally {
        await provider.shutdown();
        restoreEnv(envSnapshot);
      }
    });
  },
});
