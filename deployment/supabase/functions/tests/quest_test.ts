/**
 * Integration tests for quests.
 *
 * Tests cover:
 *   - Assign quest
 *   - Quest status
 *   - Duplicate quest assignment
 *
 * Setup: 2 players in sector 0.
 * Note: Quest system requires quest_definitions to be seeded.
 * These tests verify the endpoint behavior even if no quests are defined.
 */

import {
  assert,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiOk,
  characterIdFor,
  eventsOfType,
  getEventCursor,
  assertNoEventsOfType,
} from "./helpers.ts";

const P1 = "test_quest_p1";
const P2 = "test_quest_p2";

let p1Id: string;
let p2Id: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "quest — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Quest status (empty)
// ============================================================================

Deno.test({
  name: "quest — status returns empty when no quests",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);

    await t.step("reset database", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 checks quest status", async () => {
      const result = await apiOk("quest_status", {
        character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("P1 receives quest.status event", async () => {
      const events = await eventsOfType(p1Id, "quest.status", cursorP1);
      assert(events.length >= 1, `Expected >= 1 quest.status, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.quests, "payload.quests");
    });

    await t.step("P2 does NOT receive P1's quest.status", async () => {
      await assertNoEventsOfType(p2Id, "quest.status", cursorP2);
    });
  },
});

// ============================================================================
// Group 2: Quest assign — non-existent quest code
// ============================================================================

Deno.test({
  name: "quest — assign with non-existent code",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("assign non-existent quest returns error or not-assigned", async () => {
      const result = await api("quest_assign", {
        character_id: p1Id,
        quest_code: "nonexistent_quest_xyz",
      });
      // Should either return 400/404 or {assigned: false, reason: "..."}
      if (result.ok && result.body.success) {
        const body = result.body as Record<string, unknown>;
        assert(body.assigned === false, "Should not assign non-existent quest");
      }
      // Either way, it should not crash
      assert(result.status !== 500, "Should not crash on non-existent quest");
    });
  },
});
