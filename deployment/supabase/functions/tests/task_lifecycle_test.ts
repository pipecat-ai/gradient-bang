/**
 * Integration tests for task_lifecycle and task_cancel endpoints.
 *
 * Tests cover:
 *   - task.start event emission
 *   - task.finish event emission
 *   - Invalid event_type rejected
 *   - task_cancel endpoint
 *   - task_cancel with non-existent task
 *
 * Setup: P1, P2 in sector 0 (mega-port).
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
  shipIdFor,
  eventsOfType,
  getEventCursor,
  queryEvents,
  createCorpShip,
  setShipCredits,
} from "./helpers.ts";

const P1 = "test_task_p1";
const P2 = "test_task_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "task_lifecycle — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: task.start event emission
// ============================================================================

Deno.test({
  name: "task_lifecycle — task.start event",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);
    p2ShipId = await shipIdFor(P2);

    await t.step("reset database", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    const taskId = crypto.randomUUID();
    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("emit task.start", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Test task for coverage",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.task_id, taskId);
      assertEquals(body.event_type, "start");
    });

    await t.step("P1 receives task.start event", async () => {
      const events = await eventsOfType(p1Id, "task.start", cursorP1);
      assert(events.length >= 1, `Expected >= 1 task.start, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.task_id, taskId);
    });
  },
});

// ============================================================================
// Group 2: task.finish event emission
// ============================================================================

Deno.test({
  name: "task_lifecycle — task.finish event",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    const taskId = crypto.randomUUID();
    let cursorP1: number;

    await t.step("emit task.start first", async () => {
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Task to be finished",
      });
    });

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("emit task.finish", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "finish",
        task_summary: "Task completed successfully",
        task_status: "completed",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.task_id, taskId);
      assertEquals(body.event_type, "finish");
    });

    await t.step("P1 receives task.finish event", async () => {
      const events = await eventsOfType(p1Id, "task.finish", cursorP1);
      assert(events.length >= 1, `Expected >= 1 task.finish, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.task_id, taskId);
    });
  },
});

// ============================================================================
// Group 3: Invalid event_type rejected (400)
// ============================================================================

Deno.test({
  name: "task_lifecycle — invalid event_type → 400",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("invalid event_type fails", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "invalid_event",
      });
      assertEquals(result.status, 400, "Expected 400 for invalid event_type");
    });
  },
});

// ============================================================================
// Group 4: task_cancel — cancel an existing task
// ============================================================================

Deno.test({
  name: "task_lifecycle — task_cancel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    const taskId = crypto.randomUUID();

    await t.step("start a task first", async () => {
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Task to cancel",
      });
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("cancel the task", async () => {
      const result = await apiOk("task_cancel", {
        character_id: p1Id,
        task_id: taskId,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.message, "Should have message");
    });

    await t.step("P1 receives task.cancel event", async () => {
      const events = await eventsOfType(p1Id, "task.cancel", cursorP1);
      assert(events.length >= 1, `Expected >= 1 task.cancel, got ${events.length}`);
    });
  },
});

// ============================================================================
// Group 5: task_cancel — task not found (404)
// ============================================================================

Deno.test({
  name: "task_lifecycle — task_cancel not found → 404",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("cancel non-existent task fails", async () => {
      const result = await api("task_cancel", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 404, "Expected 404 for unknown task");
    });
  },
});

// ============================================================================
// Group 6: task start → finish → verify lifecycle
// ============================================================================

Deno.test({
  name: "task_lifecycle — full start-finish cycle",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    const taskId = crypto.randomUUID();
    let cursorP1: number;

    await t.step("start task", async () => {
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Lifecycle test task",
      });
    });

    await t.step("capture cursor after start", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("finish task", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "finish",
        task_summary: "All done",
        task_status: "completed",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.event_type, "finish");
    });

    await t.step("P1 receives task.finish", async () => {
      const events = await eventsOfType(p1Id, "task.finish", cursorP1);
      assert(events.length >= 1, `Expected >= 1 task.finish, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.task_id, taskId);
      assertEquals(payload.task_status, "completed");
    });
  },
});

// ============================================================================
// Group 7: task_cancel — permission denied
// ============================================================================

Deno.test({
  name: "task_lifecycle — task_cancel permission denied",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const taskId = crypto.randomUUID();

    await t.step("reset and start a task owned by P1", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "P1-only task",
      });
    });

    await t.step("P2 cannot cancel P1's task", async () => {
      const result = await api("task_cancel", {
        character_id: p2Id,
        task_id: taskId,
      });
      assertEquals(result.status, 403);
      assert(result.body.error?.includes("permission"));
    });
  },
});

// ============================================================================
// Group 8: task_cancel — short task_id prefix
// ============================================================================

Deno.test({
  name: "task_lifecycle — task_cancel with short prefix",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const taskId = crypto.randomUUID();

    await t.step("reset and start a task", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Short prefix task",
      });
    });

    await t.step("cancel with short prefix works", async () => {
      const prefix = taskId.slice(0, 8);
      const result = await apiOk("task_cancel", {
        character_id: p1Id,
        task_id: prefix,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.task_id, taskId, "Full task_id returned");
    });
  },
});

// ============================================================================
// Group 9: task_lifecycle with ship_id = player's own ship ID
// ============================================================================

Deno.test({
  name: "task_lifecycle — ship_id = player's own ship → treated as player task",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    const taskId = crypto.randomUUID();
    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("emit task.start with ship_id = player ship", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Task with player ship_id",
        ship_id: p1ShipId,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.task_id, taskId);
      assertEquals(body.event_type, "start");
    });

    await t.step("P1 receives task.start with correct ship metadata", async () => {
      const events = await eventsOfType(p1Id, "task.start", cursorP1);
      assert(events.length >= 1, `Expected >= 1 task.start, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.task_id, taskId);
      assertEquals(payload.task_scope, "player_ship", "Should be player_ship scope");
      assertEquals(payload.ship_id, p1ShipId, "Event payload should have correct ship_id");
      assertExists(payload.ship_name, "Event payload should include ship_name");
    });
  },
});

// ============================================================================
// Group 10: task_lifecycle with ship_id = player's character ID
// ============================================================================

Deno.test({
  name: "task_lifecycle — ship_id = player character ID → resolves to player ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    const taskId = crypto.randomUUID();
    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("emit task.start with ship_id = character ID", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Task with character ID as ship_id",
        ship_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.task_id, taskId);
    });

    await t.step("P1 receives task.start with resolved ship metadata", async () => {
      const events = await eventsOfType(p1Id, "task.start", cursorP1);
      assert(events.length >= 1, `Expected >= 1 task.start, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.task_id, taskId);
      assertEquals(
        payload.ship_id,
        p1ShipId,
        "ship_id should resolve to player's actual ship, not character ID",
      );
      assertExists(payload.ship_name, "Event payload should include ship_name");
      assertEquals(payload.task_scope, "player_ship", "Should be player_ship scope");
    });

    await t.step("event row ship_id column is the real ship ID", async () => {
      const rows = await queryEvents(
        "task_id = $1 AND event_type = 'task.start'",
        [taskId],
      );
      assert(rows.length >= 1, "Expected at least one task.start event row");
      assertEquals(
        rows[0].ship_id,
        p1ShipId,
        "events.ship_id column should be the player's actual ship_id",
      );
    });
  },
});

// ============================================================================
// Group 11: unknown ship_id → 404
// ============================================================================

Deno.test({
  name: "task_lifecycle — unknown ship_id → 404",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("random UUID ship_id → 404", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Unknown ship",
        ship_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 404, "Expected 404 for unknown ship_id");
    });

    await t.step("random hex prefix → 404", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        ship_id: "deadbeef",
      });
      assertEquals(result.status, 404, "Expected 404 for unknown prefix");
    });
  },
});

// ============================================================================
// Group 12: can't control other player's ship
// ============================================================================

Deno.test({
  name: "task_lifecycle — can't use another player's ship_id",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("P1 with P2's ship_id → 404", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Steal P2's ship",
        ship_id: p2ShipId,
      });
      assertEquals(result.status, 404, "Should not resolve another player's ship");
    });

    await t.step("P1 with P2's character ID as ship_id → 404", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        ship_id: p2Id,
      });
      assertEquals(result.status, 404, "Should not resolve another player's character ID");
    });
  },
});

// ============================================================================
// Group 13: can't control ships from another corporation
// ============================================================================

Deno.test({
  name: "task_lifecycle — can't use another corp's ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpAId: string;
    let corpBId: string;
    let corpAShipId: string;
    let corpBShipId: string;

    await t.step("reset and set up two corps with ships", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      await setShipCredits(p2ShipId, 50000);

      // P1 creates corp A
      const corpAResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Task Test Corp A",
      });
      corpAId = (corpAResult as Record<string, unknown>).corp_id as string;

      // P2 creates corp B
      const corpBResult = await apiOk("corporation_create", {
        character_id: p2Id,
        name: "Task Test Corp B",
      });
      corpBId = (corpBResult as Record<string, unknown>).corp_id as string;

      // Create corp ships
      const shipA = await createCorpShip(corpAId, 0, "Alpha Scout");
      corpAShipId = shipA.shipId;
      const shipB = await createCorpShip(corpBId, 0, "Beta Scout");
      corpBShipId = shipB.shipId;
    });

    await t.step("P1 can use own corp's ship", async () => {
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Control own corp ship",
        ship_id: corpAShipId,
      });
    });

    await t.step("P1 cannot use corp B's ship → 404", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Steal corp B ship",
        ship_id: corpBShipId,
      });
      assertEquals(result.status, 404, "Should not resolve another corp's ship");
    });

    await t.step("P2 can use own corp's ship", async () => {
      await apiOk("task_lifecycle", {
        character_id: p2Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Control own corp ship",
        ship_id: corpBShipId,
      });
    });
  },
});

// ============================================================================
// Group 14: ship_id prefix resolution
// ============================================================================

Deno.test({
  name: "task_lifecycle — ship_id prefix resolution",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and set up corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const corpResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Prefix Test Corp",
      });
      corpId = (corpResult as Record<string, unknown>).corp_id as string;
      const ship = await createCorpShip(corpId, 0, "Prefix Probe");
      corpShipId = ship.shipId;
    });

    await t.step("6-char prefix of corp ship resolves", async () => {
      const prefix = corpShipId.slice(0, 6);
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Prefix 6",
        ship_id: prefix,
      });
      assertExists(result);
    });

    await t.step("7-char prefix of corp ship resolves", async () => {
      const prefix = corpShipId.slice(0, 7);
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Prefix 7",
        ship_id: prefix,
      });
      assertExists(result);
    });

    await t.step("8-char prefix of corp ship resolves", async () => {
      const prefix = corpShipId.slice(0, 8);
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Prefix 8",
        ship_id: prefix,
      });
      assertExists(result);
    });

    await t.step("6-char prefix of player ship resolves", async () => {
      const prefix = p1ShipId.slice(0, 6);
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Player ship prefix",
        ship_id: prefix,
      });
      assertExists(result);
    });

    await t.step("6-char prefix of character ID resolves to personal ship", async () => {
      // Character ID prefix matches via owner_character_id, resolving to
      // the player's personal ship.
      const prefix = p1Id.slice(0, 6);
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Char ID prefix",
        ship_id: prefix,
      });
      assertExists(result);
    });

    await t.step("5-char prefix → 400 (too short)", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        ship_id: "abcde",
      });
      assertEquals(result.status, 400, "Expected 400 for too-short prefix");
    });
  },
});

// ============================================================================
// Group 15: uppercase ship_id handling
// ============================================================================

Deno.test({
  name: "task_lifecycle — uppercase IDs resolve correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and set up corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const corpResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Case Test Corp",
      });
      corpId = (corpResult as Record<string, unknown>).corp_id as string;
      const ship = await createCorpShip(corpId, 0, "Case Probe");
      corpShipId = ship.shipId;
    });

    await t.step("uppercase full UUID of player ship resolves", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Uppercase player ship",
        ship_id: p1ShipId.toUpperCase(),
      });
      assertExists(result);
    });

    await t.step("uppercase full UUID of corp ship resolves", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Uppercase corp ship",
        ship_id: corpShipId.toUpperCase(),
      });
      assertExists(result);
    });

    await t.step("uppercase character ID as ship_id resolves", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Uppercase char ID",
        ship_id: p1Id.toUpperCase(),
      });
      assertExists(result);
    });

    await t.step("uppercase prefix of corp ship resolves", async () => {
      const prefix = corpShipId.slice(0, 8).toUpperCase();
      const result = await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Uppercase prefix",
        ship_id: prefix,
      });
      assertExists(result);
    });
  },
});

// ============================================================================
// Group 16: no ship_id → task started for player's current ship
// ============================================================================

Deno.test({
  name: "task_lifecycle — no ship_id → resolves to player's ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    const taskId = crypto.randomUUID();
    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("emit task.start with no ship_id", async () => {
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Default ship task",
      });
    });

    await t.step("event has player's ship_id and ship_name", async () => {
      const events = await eventsOfType(p1Id, "task.start", cursorP1);
      assert(events.length >= 1, `Expected >= 1 task.start, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.ship_id, p1ShipId, "Should resolve to player's ship");
      assertExists(payload.ship_name, "Should include ship_name");
      assertEquals(payload.task_scope, "player_ship");
    });

    await t.step("events row has correct ship_id", async () => {
      const rows = await queryEvents(
        "task_id = $1 AND event_type = 'task.start'",
        [taskId],
      );
      assert(rows.length >= 1);
      assertEquals(rows[0].ship_id, p1ShipId);
    });
  },
});

// ============================================================================
// Group 17: same-corp players can't control each other's personal ships
// ============================================================================

Deno.test({
  name: "task_lifecycle — same corp, can't use corpmate's personal ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and set up corp with both players", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);

      // P1 creates corp, P2 joins
      const corpResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Shared Corp",
      });
      const corpBody = corpResult as Record<string, unknown>;
      const corpId = corpBody.corp_id as string;
      const inviteCode = corpBody.invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("P1 can't use P2's personal ship_id → 404", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "Steal corpmate ship",
        ship_id: p2ShipId,
      });
      assertEquals(result.status, 404, "Should not control corpmate's personal ship");
    });

    await t.step("P1 can't use P2's character ID as ship_id → 404", async () => {
      const result = await api("task_lifecycle", {
        character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        ship_id: p2Id,
      });
      assertEquals(result.status, 404, "Should not resolve corpmate's character ID");
    });
  },
});

// ============================================================================
// Group 18: tasks are actor-private — no fan-out to corpmates
// ============================================================================
//
// Task events (task.start, task.finish, task.cancel) are per-player. Whether
// the ship is personal or corp-owned, only the acting character receives
// task lifecycle events in their UI and LLM context. Cross-member awareness
// of ship busyness is handled synchronously at start_task time, not by
// broadcasting events.

Deno.test({
  name: "task_lifecycle — personal-ship task does NOT reach corpmate",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and set up corp with P1 + P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Actor Private Personal Corp",
      });
      const corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    let cursorP2: number;
    const taskId = crypto.randomUUID();

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 starts a personal-ship task", async () => {
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Personal ship scout",
      });
    });

    await t.step("P2 receives NO task.start for P1's personal task", async () => {
      const events = await eventsOfType(p2Id, "task.start", cursorP2);
      assertEquals(
        events.length,
        0,
        `P2 should not see P1's personal task; got ${events.length} events`,
      );
    });

    await t.step("P1 finishes the task", async () => {
      await apiOk("task_lifecycle", {
        character_id: p1Id,
        task_id: taskId,
        event_type: "finish",
        task_status: "completed",
      });
    });

    await t.step("P2 receives NO task.finish either", async () => {
      const events = await eventsOfType(p2Id, "task.finish", cursorP2);
      assertEquals(
        events.length,
        0,
        `P2 should not see P1's task.finish; got ${events.length} events`,
      );
    });
  },
});

Deno.test({
  name: "task_lifecycle — corp-ship task does NOT reach corpmate either",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step(
      "P1 founds corp with P2 + buys corp ship, captures cursors",
      async () => {
        await resetDatabase([P1, P2]);
        await apiOk("join", { character_id: p1Id });
        await apiOk("join", { character_id: p2Id });
        await setShipCredits(p1ShipId, 50000);
        const createResult = await apiOk("corporation_create", {
          character_id: p1Id,
          name: "Actor Private Corp",
        });
        const corpId = (createResult as Record<string, unknown>).corp_id as string;
        const inviteCode = (createResult as Record<string, unknown>)
          .invite_code as string;
        await apiOk("corporation_join", {
          character_id: p2Id,
          corp_id: corpId,
          invite_code: inviteCode,
        });

        const { shipId } = await createCorpShip(corpId, 0, "ShareableProbe");
        corpShipId = shipId;
      },
    );

    let cursorP2: number;
    const taskId = crypto.randomUUID();

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 starts a corp-ship task", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Corp probe on errand",
      });
      assertEquals(
        (result as Record<string, unknown>).event_type,
        "start",
      );
    });

    await t.step("P2 receives NO task.start for the corp ship either", async () => {
      const events = await eventsOfType(p2Id, "task.start", cursorP2);
      assertEquals(
        events.length,
        0,
        `P2 should not see P1's corp-ship task; got ${events.length} events`,
      );
    });
  },
});
