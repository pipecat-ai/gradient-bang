/**
 * Server-side ship-task lock tests.
 *
 * Covers the atomic acquire/release/heartbeat semantics implemented in the
 * 20260512000000 migration, as exercised through task_lifecycle, task_cancel,
 * and task_heartbeat edge functions.
 *
 * Setup:
 *   - P1, P2: two players in the same corporation
 *   - P3: a third player not in any corporation
 *   - Corp ship: a corp-owned ship that both P1 and P2 can control
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiOk,
  characterIdFor,
  createCorpShip,
  eventsOfType,
  getEventCursor,
  setShipCredits,
  shipIdFor,
  withPg,
} from "./helpers.ts";

const P1 = "test_lock_p1";
const P2 = "test_lock_p2";
const P3 = "test_lock_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p1ShipId: string;

async function setShipHeartbeatAt(
  shipId: string,
  iso: string | null,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances
         SET task_last_heartbeat_at = $1::timestamptz,
             task_started_at = $1::timestamptz
       WHERE ship_id = $2`,
      [iso, shipId],
    );
  });
}

async function readShipLockState(
  shipId: string,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT current_task_id, task_started_at, task_actor_character_id,
              task_last_heartbeat_at
         FROM ship_instances
        WHERE ship_id = $1`,
      [shipId],
    );
    return result.rows[0] ?? null;
  });
}

async function seedCorpWithShip(
  founderId: string,
  corpName: string,
): Promise<{ corpId: string; corpShipId: string }> {
  const createResult = await apiOk("corporation_create", {
    character_id: founderId,
    name: corpName,
  });
  const corpId = (createResult as Record<string, unknown>).corp_id as string;
  const ship = await createCorpShip(corpId, 0, `${corpName} Probe`);
  return { corpId, corpShipId: ship.pseudoCharacterId };
}

// ============================================================================
// Bootstrap: in-process server
// ============================================================================

Deno.test({
  name: "ship_task_lock — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Acquire-time mutual exclusion
// ============================================================================

Deno.test({
  name: "ship_task_lock — second start on busy ship → 409 ship_busy",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);

    let corpId: string;
    let corpShipId: string;

    await t.step("seed corp + corp ship; invite P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithShip(p1Id, "Lock Test Corp");
      corpId = seeded.corpId;
      corpShipId = seeded.corpShipId;

      // Add P2 to the same corp.
      await withPg(async (pg) => {
        await pg.queryObject(
          `INSERT INTO corporation_members (corp_id, character_id, joined_at)
           VALUES ($1, $2, NOW())`,
          [corpId, p2Id],
        );
      });
    });

    const task1 = crypto.randomUUID();
    const task2 = crypto.randomUUID();

    await t.step("P1 acquires lock via task.start", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: task1,
        event_type: "start",
        task_description: "first task",
      });
      assertEquals(
        (result as Record<string, unknown>).task_id,
        task1,
      );

      const row = await readShipLockState(corpShipId);
      assertEquals(row?.current_task_id, task1);
      assertEquals(row?.task_actor_character_id, p1Id);
      assertExists(row?.task_started_at);
    });

    await t.step("P2's start on same ship returns 409 ship_busy", async () => {
      const result = await api("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p2Id,
        task_id: task2,
        event_type: "start",
        task_description: "should be rejected",
      });
      assertEquals(result.status, 409);
      const body = result.body as Record<string, unknown>;
      assertEquals(body.error, "ship_busy");
      assertEquals(body.current_task_id, task1);
      // Truncated actor prefix — 12 chars of UUID hex, no dashes.
      const expectedPrefix = p1Id.replace(/-/g, "").slice(0, 12);
      assertEquals(body.task_actor_character_id_prefix, expectedPrefix);

      // No second task.start event should have been recorded.
      const startEvents = await eventsOfType(corpShipId, "task.start", 0);
      const matches = startEvents.filter(
        (e) => (e.payload as Record<string, unknown>).task_id === task2,
      );
      assertEquals(matches.length, 0, "no task.start for rejected task_id");
    });

    await t.step(
      "finish releases the lock; second start now succeeds",
      async () => {
        await apiOk("task_lifecycle", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          task_id: task1,
          event_type: "finish",
          task_status: "completed",
        });

        const cleared = await readShipLockState(corpShipId);
        assertEquals(cleared?.current_task_id, null);
        assertEquals(cleared?.task_actor_character_id, null);

        // P2 can now acquire.
        const second = await apiOk("task_lifecycle", {
          character_id: corpShipId,
          actor_character_id: p2Id,
          task_id: task2,
          event_type: "start",
          task_description: "p2 takes over",
        });
        assertEquals(
          (second as Record<string, unknown>).task_id,
          task2,
        );

        const held = await readShipLockState(corpShipId);
        assertEquals(held?.current_task_id, task2);
        assertEquals(held?.task_actor_character_id, p2Id);
      },
    );
  },
});

// ============================================================================
// Group 2: Heartbeat refresh
// ============================================================================

Deno.test({
  name: "ship_task_lock — task_heartbeat refreshes matching pair only",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("seed corp + corp ship; start a task", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithShip(p1Id, "HB Test Corp");
      corpShipId = seeded.corpShipId;
    });

    const taskId = crypto.randomUUID();

    await t.step("acquire", async () => {
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "hb test",
      });
    });

    let heartbeatBefore: string;
    await t.step("backdate heartbeat", async () => {
      const past = new Date(Date.now() - 30_000).toISOString();
      await setShipHeartbeatAt(corpShipId, past);
      heartbeatBefore = past;
    });

    await t.step("heartbeat with matching pair refreshes", async () => {
      const result = await apiOk("task_heartbeat", {
        locks: [{ ship_id: corpShipId, task_id: taskId }],
      });
      assertEquals((result as Record<string, unknown>).refreshed, 1);

      const row = await readShipLockState(corpShipId);
      const after = String(row?.task_last_heartbeat_at ?? "");
      assert(
        after > heartbeatBefore,
        `heartbeat should have advanced (${heartbeatBefore} -> ${after})`,
      );
    });

    await t.step(
      "heartbeat with mismatched task_id is no-op",
      async () => {
        const wrongTask = crypto.randomUUID();
        const result = await apiOk("task_heartbeat", {
          locks: [{ ship_id: corpShipId, task_id: wrongTask }],
        });
        assertEquals((result as Record<string, unknown>).refreshed, 0);
      },
    );

    await t.step("malformed heartbeat UUID → 400", async () => {
      const result = await api("task_heartbeat", {
        locks: [{ ship_id: corpShipId, task_id: "not-a-uuid" }],
      });
      assertEquals(result.status, 400);
      assertEquals(
        (result.body as Record<string, unknown>).error,
        "each lock must include valid UUID ship_id and task_id",
      );
    });
  },
});

// ============================================================================
// Group 3: Stale-lock recovery — Layer 2 (heartbeat staleness)
// ============================================================================

Deno.test({
  name: "ship_task_lock — stale heartbeat → acquire steals and emits task.cancel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("seed corp + corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithShip(p1Id, "Stale Test Corp");
      const corpId = seeded.corpId;
      corpShipId = seeded.corpShipId;
      await withPg(async (pg) => {
        await pg.queryObject(
          `INSERT INTO corporation_members (corp_id, character_id, joined_at)
           VALUES ($1, $2, NOW())`,
          [corpId, p2Id],
        );
      });
    });

    const staleTask = crypto.randomUUID();
    const newTask = crypto.randomUUID();
    let cursorBeforeSteal: number;

    await t.step("P1 acquires the lock", async () => {
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: staleTask,
        event_type: "start",
        task_description: "will go stale",
      });
    });

    await t.step("backdate heartbeat past the stale window", async () => {
      // Stale default is 180s; jump back 10 minutes to be safe.
      const past = new Date(Date.now() - 10 * 60_000).toISOString();
      await setShipHeartbeatAt(corpShipId, past);
    });

    await t.step("capture cursor", async () => {
      cursorBeforeSteal = await getEventCursor(corpShipId);
    });

    await t.step("P2 acquires — succeeds by stealing", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p2Id,
        task_id: newTask,
        event_type: "start",
        task_description: "steals stale lock",
      });
      assertEquals((result as Record<string, unknown>).task_id, newTask);

      const row = await readShipLockState(corpShipId);
      assertEquals(row?.current_task_id, newTask);
      assertEquals(row?.task_actor_character_id, p2Id);
    });

    await t.step(
      "task.cancel emitted for the stolen task with cancelled_by: 'stale_lock'",
      async () => {
        const cancels = await eventsOfType(
          corpShipId,
          "task.cancel",
          cursorBeforeSteal,
        );
        const stolenCancel = cancels.find(
          (e) =>
            (e.payload as Record<string, unknown>).task_id === staleTask &&
            (e.payload as Record<string, unknown>).cancelled_by ===
              "stale_lock",
        );
        assertExists(
          stolenCancel,
          `expected task.cancel for ${staleTask} with cancelled_by stale_lock`,
        );
      },
    );
  },
});

// ============================================================================
// Group 4: task_cancel atomic release + force=true bypass
// ============================================================================

Deno.test({
  name: "ship_task_lock — task_cancel releases atomically",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("seed corp + corp ship; acquire lock", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithShip(p1Id, "Cancel Test Corp");
      corpShipId = seeded.corpShipId;
    });

    const taskId = crypto.randomUUID();

    await t.step("start task", async () => {
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "to be cancelled",
      });
    });

    await t.step("cancel releases the lock", async () => {
      await apiOk("task_cancel", {
        character_id: p1Id,
        task_id: taskId,
      });
      const row = await readShipLockState(corpShipId);
      assertEquals(row?.current_task_id, null);
    });

    await t.step("second cancel is idempotent (event still emits)", async () => {
      const result = await api("task_cancel", {
        character_id: p1Id,
        task_id: taskId,
      });
      // task_cancel still emits the cancel event even if lock already gone;
      // current behavior is event-based, so this is a 200.
      assertEquals(result.status, 200);
    });
  },
});

Deno.test({
  name: "ship_task_lock — task_cancel force=true bypasses owner/actor check",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("seed corp; P2 joins; P3 outside corp", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      p3Id = await characterIdFor(P3);
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithShip(p1Id, "Force Test Corp");
      corpId = seeded.corpId;
      corpShipId = seeded.corpShipId;
      await withPg(async (pg) => {
        await pg.queryObject(
          `INSERT INTO corporation_members (corp_id, character_id, joined_at)
           VALUES ($1, $2, NOW())`,
          [corpId, p2Id],
        );
      });
    });

    const taskId = crypto.randomUUID();

    await t.step("P1 acquires", async () => {
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "p1 task",
      });
    });

    await t.step(
      "P3 (non-corp) force=true → 403",
      async () => {
        const result = await api("task_cancel", {
          character_id: p3Id,
          task_id: taskId,
          force: true,
        });
        assertEquals(result.status, 403);
      },
    );

    await t.step(
      "P2 (corp member, not actor) force=true → 200, lock released",
      async () => {
        const result = await api("task_cancel", {
          character_id: p2Id,
          task_id: taskId,
          force: true,
        });
        assertEquals(result.status, 200);
        const row = await readShipLockState(corpShipId);
        assertEquals(row?.current_task_id, null);
      },
    );
  },
});

