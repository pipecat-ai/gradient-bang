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
