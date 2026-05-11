/**
 * BYOA access control + ship_byoa_configure tests.
 *
 * Covers the access checks added in PR 2:
 *   - task_lifecycle blocks non-owners from starting a task on a
 *     BYOA-private corp ship (403 byoa_private_not_owner).
 *   - task_cancel blocks non-owners from cancelling a BYOA-private task,
 *     but force=true is still allowed for corp members.
 *   - ship_byoa_configure claim/set_mode/clear happy paths and rejections.
 *
 * Setup:
 *   - P1 (BYOA owner candidate), P2 (other corp member), P3 (non-corp)
 *   - One corp with a corp ship.
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
  eventsOfType,
  getEventCursor,
  setShipCredits,
  shipIdFor,
  withPg,
} from "./helpers.ts";

const P1 = "test_byoa_p1";
const P2 = "test_byoa_p2";
const P3 = "test_byoa_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
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

async function readShipByoa(
  shipId: string,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT byoa_owner_character_id, byoa_mode, current_task_id
         FROM ship_instances
        WHERE ship_id = $1`,
      [shipId],
    );
    return result.rows[0] ?? null;
  });
}

// ============================================================================
// Bootstrap
// ============================================================================

Deno.test({
  name: "byoa_access — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: task_lifecycle BYOA private check
// ============================================================================

Deno.test({
  name: "byoa_access — private ship blocks non-owner; owner succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);

    let corpShipId: string;

    await t.step("seed corp + members + corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "BYOA Test Corp");
      corpShipId = seeded.corpShipId;
    });

    await t.step("P1 claims BYOA private on the corp ship", async () => {
      const result = await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.byoa_owner_character_id, p1Id);
      assertEquals(body.byoa_mode, "private");
      assertEquals(body.changed, true);

      const row = await readShipByoa(corpShipId);
      assertEquals(row?.byoa_owner_character_id, p1Id);
      assertEquals(row?.byoa_mode, "private");
    });

    await t.step("P2 (non-owner) task.start → 403 byoa_private_not_owner", async () => {
      const result = await api("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p2Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "should be blocked",
      });
      assertEquals(result.status, 403);
      const body = result.body as Record<string, unknown>;
      assertEquals(body.error, "byoa_private_not_owner");
      assertEquals(
        body.byoa_owner_character_id_prefix,
        p1Id.replace(/-/g, "").slice(0, 12),
      );

      const row = await readShipByoa(corpShipId);
      // Lock was NOT acquired — fast-fail before the acquire RPC.
      assertEquals(row?.current_task_id, null);
    });

    await t.step("P1 (owner) task.start succeeds", async () => {
      const taskId = crypto.randomUUID();
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "owner task",
      });
      const row = await readShipByoa(corpShipId);
      assertEquals(row?.current_task_id, taskId);

      // Cleanup so subsequent tests don't see this lock.
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "finish",
      });
    });
  },
});

// ============================================================================
// Group 2: BYOA shared allows any corp member
// ============================================================================

Deno.test({
  name: "byoa_access — shared mode allows corp members",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("seed corp + claim shared", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Shared Test Corp");
      corpShipId = seeded.corpShipId;
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "shared",
      });
    });

    await t.step("P2 (non-owner corp member) task.start succeeds", async () => {
      const taskId = crypto.randomUUID();
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p2Id,
        task_id: taskId,
        event_type: "start",
        task_description: "shared mode task",
      });
      const row = await readShipByoa(corpShipId);
      assertEquals(row?.current_task_id, taskId);
    });
  },
});

// ============================================================================
// Group 3: Non-BYOA ships unchanged — corp members can still issue tasks
// ============================================================================

Deno.test({
  name: "byoa_access — non-BYOA corp ship: any corp member can task as today",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("seed corp; never claim BYOA", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(
        p1Id,
        [p2Id],
        "Non-BYOA Test Corp",
      );
      corpShipId = seeded.corpShipId;
    });

    await t.step("P2 starts a task — no BYOA, no blocking", async () => {
      const taskId = crypto.randomUUID();
      const result = await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p2Id,
        task_id: taskId,
        event_type: "start",
        task_description: "no byoa task",
      });
      assertEquals((result as Record<string, unknown>).task_id, taskId);

      const row = await readShipByoa(corpShipId);
      assertEquals(row?.byoa_owner_character_id, null);
      assertEquals(row?.current_task_id, taskId);
    });
  },
});

// ============================================================================
// Group 4: task_cancel respects BYOA-private; force=true escapes
// ============================================================================

Deno.test({
  name: "byoa_access — task_cancel blocks non-owner on private; force=true bypasses",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    const taskId = crypto.randomUUID();

    await t.step("seed corp + claim private + start task", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Cancel BYOA Corp");
      corpShipId = seeded.corpShipId;
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "owner task",
      });
    });

    await t.step("P2 normal cancel → 403 byoa_private_not_owner", async () => {
      const result = await api("task_cancel", {
        character_id: p2Id,
        task_id: taskId,
      });
      assertEquals(result.status, 403);
      assertEquals(
        (result.body as Record<string, unknown>).error,
        "byoa_private_not_owner",
      );

      const row = await readShipByoa(corpShipId);
      // Lock still held — cancel was rejected.
      assertEquals(row?.current_task_id, taskId);
    });

    await t.step("P2 force=true succeeds; lock released", async () => {
      const result = await api("task_cancel", {
        character_id: p2Id,
        task_id: taskId,
        force: true,
      });
      assertEquals(result.status, 200);
      const row = await readShipByoa(corpShipId);
      assertEquals(row?.current_task_id, null);
    });
  },
});

// ============================================================================
// Group 5: ship_byoa_configure happy paths + rejections
// ============================================================================

Deno.test({
  name: "byoa_access — ship_byoa_configure self-only claim",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("seed corp", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      p3Id = await characterIdFor(P3);
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Configure Corp");
      corpShipId = seeded.corpShipId;
    });

    await t.step("P3 (non-corp) cannot configure", async () => {
      const result = await api("ship_byoa_configure", {
        character_id: p3Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      assertEquals(result.status, 403);
    });

    await t.step("P1 claims", async () => {
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
    });

    await t.step("P2 cannot re-claim while P1 owns", async () => {
      const result = await api("ship_byoa_configure", {
        character_id: p2Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      assertEquals(result.status, 409);
    });

    await t.step("P2 cannot set_mode (not the owner)", async () => {
      const result = await api("ship_byoa_configure", {
        character_id: p2Id,
        ship_id: corpShipId,
        action: "set_mode",
        mode: "shared",
      });
      assertEquals(result.status, 403);
    });

    await t.step("P1 can toggle mode", async () => {
      const result = await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "set_mode",
        mode: "shared",
      });
      assertEquals((result as Record<string, unknown>).byoa_mode, "shared");
    });

    await t.step("P2 cannot clear (not the owner)", async () => {
      const result = await api("ship_byoa_configure", {
        character_id: p2Id,
        ship_id: corpShipId,
        action: "clear",
      });
      assertEquals(result.status, 403);
    });

    await t.step("P1 clears; row is back to defaults", async () => {
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "clear",
      });
      const row = await readShipByoa(corpShipId);
      assertEquals(row?.byoa_owner_character_id, null);
      assertEquals(row?.byoa_mode, "private"); // back to migration default
    });
  },
});

Deno.test({
  name: "byoa_access — ship_byoa_configure refuses while a task is running",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("seed corp + active task (non-BYOA)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [], "Locked Configure Corp");
      corpShipId = seeded.corpShipId;
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "blocks configure",
      });
    });

    await t.step("claim while held → 409 ship_busy", async () => {
      const result = await api("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      assertEquals(result.status, 409);
      assertEquals(
        (result.body as Record<string, unknown>).error,
        "ship_busy",
      );
    });
  },
});

// ============================================================================
// Group 6: Ship-list payload shape (BYOA + current_task_actor blocks)
// ============================================================================

Deno.test({
  name: "byoa_access — list_user_ships payload includes byoa + current_task_actor blocks",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    const taskId = crypto.randomUUID();

    await t.step("seed corp + claim BYOA + start a task", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [], "Payload Corp");
      corpShipId = seeded.corpShipId;
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "payload smoke",
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list_user_ships emits BYOA + actor blocks (truncated)", async () => {
      await apiOk("list_user_ships", { character_id: p1Id });
      const events = await eventsOfType(p1Id, "ships.list", cursor);
      assert(events.length >= 1);
      const ships = (events[0].payload as Record<string, unknown>)
        .ships as Array<Record<string, unknown>>;

      const corpShip = ships.find((s) => s.ship_id === corpShipId);
      assert(corpShip, "corp ship present in payload");

      // current_task_actor: truncated, 12 chars, no dashes
      const actor = corpShip.current_task_actor as Record<string, unknown> | null;
      assert(actor, "current_task_actor populated for active task");
      assertEquals(
        actor!.character_id_prefix,
        p1Id.replace(/-/g, "").slice(0, 12),
      );

      // byoa: truncated owner + mode
      const byoa = corpShip.byoa as Record<string, unknown> | null;
      assert(byoa, "byoa block populated for BYOA ship");
      assertEquals(
        byoa!.owner_character_id_prefix,
        p1Id.replace(/-/g, "").slice(0, 12),
      );
      assertEquals(byoa!.mode, "private");

      // Personal ship has no BYOA, no active task — both blocks null.
      const personalShip = ships.find((s) => s.ship_id === p1ShipId);
      assert(personalShip, "personal ship present");
      assertEquals(personalShip.byoa, null);
      assertEquals(personalShip.current_task_actor, null);

      // Regression: no full UUIDs of p1Id appear under any block alongside
      // a truncated prefix (full UUIDs stay server-side).
      const serialised = JSON.stringify(ships);
      // Pattern: 8-4-4-4-12 hex UUID.
      const fullUuidPattern = new RegExp(p1Id, "i");
      const truncatedPattern = new RegExp(
        p1Id.replace(/-/g, "").slice(0, 12),
        "i",
      );
      assert(truncatedPattern.test(serialised), "truncated prefix present");
      assert(
        !fullUuidPattern.test(serialised),
        "full character UUID should NOT appear in payload",
      );
    });
  },
});
