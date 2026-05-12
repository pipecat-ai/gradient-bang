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
      `SELECT acquire_ship_task_lock($1::uuid, $2::uuid, $3::uuid, 180, 30)`,
      [shipId, taskId, actorId],
    );
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

    await t.step("happy path → 200, channel recorded on row", async () => {
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
      assert(["single_task", "idle_loop"].includes(body.lifecycle_hint as string));
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

    await t.step("stale task_id (lock not held) → 409 lock_not_held", async () => {
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
