/**
 * wake_agent edge-function tests.
 *
 * Covers the BYOA wake dispatch: standard authenticate + canActOnCharacter,
 * BYOA-ship guard, and the {channel, spawn_target, lifecycle_hint} response
 * shape. The DB-persistent ship-task lock was removed; wake_agent no longer
 * writes to ship_instances and no longer validates a server-side lock.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiAsOk,
  apiOk,
  characterIdFor,
  createCorpShip,
  provisionUser,
  setShipCredits,
  shipIdFor,
  type TestUser,
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

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

async function setShipWakeConfig(
  shipId: string,
  sourceUrl: string | null,
  wakeSecret: string | null,
): Promise<void> {
  await withPg(async (pg) => {
    if (wakeSecret === null) {
      await pg.queryObject(
        `UPDATE ship_instances
           SET byoa_runtime_source_url = $1,
               byoa_wake_secret_enc = NULL
         WHERE ship_id = $2::uuid`,
        [sourceUrl, shipId],
      );
    } else {
      await pg.queryObject(
        `UPDATE ship_instances
           SET byoa_runtime_source_url = $1,
               byoa_wake_secret_enc = extensions.pgp_sym_encrypt(
                 $2,
                 public.byoa_operator_secret()
               )
         WHERE ship_id = $3::uuid`,
        [sourceUrl, wakeSecret, shipId],
      );
    }
  });
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
  name: "wake_agent — happy paths, validation, BYOA guard",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);

    let corpShipId: string;
    let p1User: TestUser;
    const taskId = crypto.randomUUID();
    const channel = "gb_" + "00112233445566778899aabbccddeeff";

    await t.step("seed corp + claim BYOA", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Wake Alloc Corp");
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("wake-p1", p1Id);
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
    });

    await t.step(
      "idle registration without task_id → 200, channel passed through",
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
      },
    );

    await t.step("task wake → 200", async () => {
      const result = await apiOk("wake_agent", {
        ship_id: corpShipId,
        character_id: p1Id,
        task_id: taskId,
        channel,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.ship_id, corpShipId);
      assertEquals(body.channel, channel);
      assert(
        ["single_task", "idle_loop"].includes(body.lifecycle_hint as string),
      );
      assertEquals(body.spawn_target, "noop");
      assertEquals(body.spawn_status, "noop");
    });

    await t.step("invalid channel format → 400", async () => {
      const result = await api("wake_agent", {
        ship_id: corpShipId,
        character_id: p1Id,
        task_id: taskId,
        channel: "bot_session_abc",
      });
      assertEquals(result.status, 400);
      const body = result.body as Record<string, unknown>;
      const errMsg = String(body.error ?? "");
      assert(
        errMsg.includes("/^gb_[0-9a-f]{32}$/"),
        `error should mention new channel pattern, got: ${errMsg}`,
      );
    });

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
    let p1User: TestUser;
    let taskId = crypto.randomUUID();
    const channel = "gb_" + "ffeeddccbbaa99887766554433221100";

    await t.step("seed corp + claim BYOA", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Wake HTTP Corp");
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("wake-http-p1", p1Id);
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
    });

    const envSnapshot = {
      BYOA_WAKE_TARGET: Deno.env.get("BYOA_WAKE_TARGET"),
      DEFAULT_BYOA_SOURCE_URL: Deno.env.get("DEFAULT_BYOA_SOURCE_URL"),
      BYOA_BUS_DATABASE_URL: Deno.env.get("BYOA_BUS_DATABASE_URL"),
    };

    await t.step(
      "missing per-ship wake secret → visible spawn failure",
      async () => {
        try {
          Deno.env.set("BYOA_WAKE_TARGET", "http");
          Deno.env.set(
            "BYOA_BUS_DATABASE_URL",
            "postgresql://byoa_login:test@db/postgres",
          );
          // URL set, secret unset — wake_agent must refuse rather than
          // POST without a bearer.
          await setShipWakeConfig(
            corpShipId,
            "http://example.invalid/wake",
            null,
          );

          const result = await api("wake_agent", {
            ship_id: corpShipId,
            character_id: p1Id,
            task_id: taskId,
            channel,
          });
          assertEquals(result.status, 500);
          const body = result.body as Record<string, unknown>;
          assertEquals(body.error, "wake_spawn_failed");
          assertEquals(body.spawn_target, "http");
          assertEquals(body.spawn_status, "missing_wake_secret");
        } finally {
          restoreEnv(envSnapshot);
          await setShipWakeConfig(corpShipId, null, null);
        }
      },
    );

    await t.step(
      "per-ship URL + secret are used as bearer and target",
      async () => {
        taskId = crypto.randomUUID();

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
          Deno.env.set("BYOA_WAKE_TARGET", "http");
          Deno.env.set(
            "BYOA_BUS_DATABASE_URL",
            "postgresql://byoa_login:test@db/postgres",
          );
          await setShipWakeConfig(
            corpShipId,
            `http://127.0.0.1:${provider.addr.port}/wake`,
            "test-secret",
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
          await setShipWakeConfig(corpShipId, null, null);
        }
      },
    );

    await t.step("http provider non-2xx → visible spawn failure", async () => {
      taskId = crypto.randomUUID();

      const provider = Deno.serve(
        { hostname: "127.0.0.1", port: 0 },
        () => new Response("nope", { status: 503 }),
      );

      try {
        Deno.env.set("BYOA_WAKE_TARGET", "http");
        Deno.env.set(
          "BYOA_BUS_DATABASE_URL",
          "postgresql://byoa_login:test@db/postgres",
        );
        await setShipWakeConfig(
          corpShipId,
          `http://127.0.0.1:${provider.addr.port}/wake`,
          "test-secret",
        );

        const result = await api("wake_agent", {
          ship_id: corpShipId,
          character_id: p1Id,
          task_id: taskId,
          channel,
        });
        assertEquals(result.status, 502);
        const body = result.body as Record<string, unknown>;
        assertEquals(body.error, "wake_spawn_failed");
        assertEquals(body.spawn_target, "http");
        assertEquals(body.spawn_status, "http_503");
      } finally {
        await provider.shutdown();
        restoreEnv(envSnapshot);
        await setShipWakeConfig(corpShipId, null, null);
      }
    });
  },
});
