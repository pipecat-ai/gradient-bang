/**
 * Integration tests for messaging (send_message).
 *
 * Tests cover:
 *   - Broadcast message (all players receive)
 *   - Direct message (only sender + recipient, not third party)
 *   - Empty content rejected
 *   - Invalid message type rejected
 *   - Direct message missing recipient
 *   - Content too long returns 400
 *   - DM recipient not found
 *   - Invalid to_ship_id format
 *
 * Setup: 3 players in sector 0.
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
// Group 3: Empty content rejected
// ============================================================================

Deno.test({
  name: "messaging — empty content",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("empty content fails with 400", async () => {
      const result = await api("send_message", {
        character_id: p1Id,
        type: "broadcast",
        content: "",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("Empty content"));
    });
  },
});

// ============================================================================
// Group 6: Invalid message type
// ============================================================================

Deno.test({
  name: "messaging — invalid type",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: invalid type", async () => {
      const result = await api("send_message", {
        character_id: p1Id,
        type: "whisper",
        content: "Hello",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("broadcast or direct"));
    });
  },
});

// ============================================================================
// Group 7: Direct message — missing recipient
// ============================================================================

Deno.test({
  name: "messaging — direct message missing recipient",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: no recipient for DM", async () => {
      const result = await api("send_message", {
        character_id: p1Id,
        type: "direct",
        content: "Hello no one",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("recipient"));
    });
  },
});

// ============================================================================
// Group 8: Content too long — exact status
// ============================================================================

Deno.test({
  name: "messaging — content too long returns 400",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: content exceeds 512 chars", async () => {
      const longContent = "A".repeat(600);
      const result = await api("send_message", {
        character_id: p1Id,
        type: "broadcast",
        content: longContent,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("too long"));
    });
  },
});

// ============================================================================
// Group 7: Direct message — recipient not found
// ============================================================================

Deno.test({
  name: "messaging — DM recipient not found",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: unknown recipient", async () => {
      const result = await api("send_message", {
        character_id: p1Id,
        type: "direct",
        content: "Hello stranger",
        to_name: "NonExistentPlayer12345",
      });
      assertEquals(result.status, 404);
    });
  },
});

// ============================================================================
// Group 12: Invalid to_ship_id format
// ============================================================================

Deno.test({
  name: "messaging — invalid to_ship_id format",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: invalid to_ship_id format", async () => {
      const result = await api("send_message", {
        character_id: p1Id,
        type: "direct",
        content: "Hello",
        to_ship_id: "xyz",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("UUID or 6-8 hex"));
    });
  },
});
