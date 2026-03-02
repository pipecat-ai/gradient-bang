/**
 * Integration tests for messaging (send_message).
 *
 * Tests cover:
 *   - Broadcast message (all players receive)
 *   - Direct message (only sender + recipient, not third party)
 *   - Message content validation (too long)
 *
 * Setup: 3 players in sector 0.
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
  eventsOfType,
  getEventCursor,
  assertNoEventsOfType,
} from "./helpers.ts";

const P1 = "test_msg_p1";
const P2 = "test_msg_p2";
const P3 = "test_msg_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "messaging — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Broadcast message
// ============================================================================

Deno.test({
  name: "messaging — broadcast",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p3Id = await characterIdFor(P3);

    await t.step("reset database", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
    });

    let cursorP1: number;
    let cursorP2: number;
    let cursorP3: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 sends broadcast message", async () => {
      const result = await apiOk("send_message", {
        character_id: p1Id,
        type: "broadcast",
        content: "Hello everyone!",
      });
      assert(result.success);
    });

    await t.step("P1 receives chat.message (own broadcast)", async () => {
      const events = await eventsOfType(p1Id, "chat.message", cursorP1);
      assert(events.length >= 1, `Expected >= 1 chat.message for P1, got ${events.length}`);
    });

    await t.step("P2 receives chat.message", async () => {
      const events = await eventsOfType(p2Id, "chat.message", cursorP2);
      assert(events.length >= 1, `Expected >= 1 chat.message for P2, got ${events.length}`);
    });

    await t.step("P3 receives chat.message", async () => {
      const events = await eventsOfType(p3Id, "chat.message", cursorP3);
      assert(events.length >= 1, `Expected >= 1 chat.message for P3, got ${events.length}`);
    });
  },
});

// ============================================================================
// Group 2: Direct message (DM privacy)
// ============================================================================

Deno.test({
  name: "messaging — direct message privacy",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
    });

    let cursorP1: number;
    let cursorP2: number;
    let cursorP3: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 sends direct message to P2", async () => {
      const result = await apiOk("send_message", {
        character_id: p1Id,
        type: "direct",
        content: "Secret message for P2",
        to_name: P2,
      });
      assert(result.success);
    });

    await t.step("P1 receives chat.message (sender echo)", async () => {
      const events = await eventsOfType(p1Id, "chat.message", cursorP1);
      assert(events.length >= 1, `Expected >= 1 chat.message for P1, got ${events.length}`);
    });

    await t.step("P2 receives chat.message (recipient)", async () => {
      const events = await eventsOfType(p2Id, "chat.message", cursorP2);
      assert(events.length >= 1, `Expected >= 1 chat.message for P2, got ${events.length}`);
    });

    await t.step("P3 does NOT receive the direct message", async () => {
      await assertNoEventsOfType(p3Id, "chat.message", cursorP3);
    });
  },
});

// ============================================================================
// Group 3: Message content validation (too long)
// ============================================================================

Deno.test({
  name: "messaging — content validation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("message exceeding 512 chars handled", async () => {
      const longContent = "A".repeat(600);
      const result = await api("send_message", {
        character_id: p1Id,
        type: "broadcast",
        content: longContent,
      });
      // Server should either reject (400) or truncate — either way it handles it
      // Check that it doesn't crash (500)
      assert(result.status !== 500, "Server should not crash on long message");
    });
  },
});
