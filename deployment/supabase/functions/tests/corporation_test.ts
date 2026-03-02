/**
 * Integration tests for corporations.
 *
 * Tests cover:
 *   - Create corporation (cost, event, DB state)
 *   - Join corporation (invite code, corp-wide event)
 *   - Non-member does not see corp events
 *   - Kick member
 *   - Leave corporation
 *   - Disband (last member leaves)
 *   - Regenerate invite code
 *   - Corporation info (member vs non-member view)
 *   - Corporation list
 *   - Invalid invite code
 *
 * Setup: 3 players, all in sector 0.
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
  queryCharacter,
  queryShip,
  assertNoEventsOfType,
  setShipCredits,
} from "./helpers.ts";

const P1 = "test_corp_p1";
const P2 = "test_corp_p2";
const P3 = "test_corp_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p1ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "corporation — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Create corporation
// ============================================================================

Deno.test({
  name: "corporation — create",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p3Id = await characterIdFor(P3);
    p1ShipId = await shipIdFor(P1);

    await t.step("reset database", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      // Corp creation costs 10,000 credits; test ships start with only 1,000
      await setShipCredits(p1ShipId, 50000);
    });

    let cursorP1: number;

    await t.step("capture P1 cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    let corpId: string;
    let inviteCode: string;

    await t.step("P1 creates corporation", async () => {
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Alpha",
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.corp_id, "Response should have corp_id");
      assertExists(body.invite_code, "Response should have invite_code");
      assertEquals(body.member_count, 1);
      corpId = body.corp_id as string;
      inviteCode = body.invite_code as string;
    });

    await t.step("P1 receives corporation.created event", async () => {
      const events = await eventsOfType(p1Id, "corporation.created", cursorP1);
      assert(events.length >= 1, `Expected >= 1 corporation.created, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.corp_id, corpId);
      assertEquals(payload.name, "Test Corp Alpha");
      assertExists(payload.invite_code);
    });

    await t.step("DB: character has corporation_id set", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpId);
    });

    await t.step("DB: ship credits decreased by 10000", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // Started with 50000, cost is 10000
      assert(
        (ship.credits as number) <= 40000,
        `Credits should have decreased: ${ship.credits}`,
      );
    });
  },
});

// ============================================================================
// Group 2: Join corporation + corp-wide event routing
// ============================================================================

Deno.test({
  name: "corporation — join and event routing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      // Give P1 enough credits to create corp
      await setShipCredits(p1ShipId, 50000);
    });

    let corpId: string;
    let inviteCode: string;

    await t.step("P1 creates corporation", async () => {
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Beta",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      inviteCode = (result as Record<string, unknown>).invite_code as string;
    });

    let cursorP1: number;
    let cursorP2: number;
    let cursorP3: number;

    await t.step("capture cursors before join", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P2 joins corporation", async () => {
      const result = await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertEquals(body.member_count, 2);
    });

    await t.step("P1 receives corporation.member_joined (corp-wide)", async () => {
      // Corp events are stored with corp_id, so pass corpId to see them
      const events = await eventsOfType(p1Id, "corporation.member_joined", cursorP1, corpId);
      assert(events.length >= 1, `Expected >= 1 corporation.member_joined for P1, got ${events.length}`);
    });

    await t.step("P2 receives corporation.member_joined", async () => {
      const events = await eventsOfType(p2Id, "corporation.member_joined", cursorP2, corpId);
      assert(events.length >= 1, `Expected >= 1 corporation.member_joined for P2, got ${events.length}`);
    });

    await t.step("P3 does NOT receive corporation.member_joined", async () => {
      // P3 is not in the corp so should NOT see corp events even if they query
      await assertNoEventsOfType(p3Id, "corporation.member_joined", cursorP3);
    });

    await t.step("DB: P2 has corporation_id set", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpId);
    });
  },
});

// ============================================================================
// Group 3: Kick member
// ============================================================================

Deno.test({
  name: "corporation — kick member",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp with P1+P2", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Kick",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      const inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    let cursorP1: number;
    let cursorP3: number;

    await t.step("capture cursors before kick", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 kicks P2", async () => {
      const result = await apiOk("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
      });
      assert(result.success);
    });

    await t.step("P1 receives corporation.member_kicked", async () => {
      const events = await eventsOfType(p1Id, "corporation.member_kicked", cursorP1, corpId);
      assert(events.length >= 1, `Expected >= 1 corporation.member_kicked for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.kicked_member_id, "payload.kicked_member_id");
    });

    await t.step("P3 does NOT receive corporation.member_kicked", async () => {
      await assertNoEventsOfType(p3Id, "corporation.member_kicked", cursorP3);
    });

    await t.step("DB: P2 no longer in corporation", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, null);
    });
  },
});

// ============================================================================
// Group 4: Leave corporation
// ============================================================================

Deno.test({
  name: "corporation — leave",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp with P1+P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Leave",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      const inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    let cursorP1: number;

    await t.step("capture P1 cursor before P2 leaves", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P2 leaves corporation", async () => {
      const result = await apiOk("corporation_leave", {
        character_id: p2Id,
      });
      assert(result.success);
    });

    await t.step("P1 receives corporation.member_left", async () => {
      const events = await eventsOfType(p1Id, "corporation.member_left", cursorP1, corpId);
      assert(events.length >= 1, `Expected >= 1 corporation.member_left for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.departed_member_id);
    });

    await t.step("DB: P2 no longer in corporation", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, null);
    });
  },
});

// ============================================================================
// Group 5: Disband (last member leaves)
// ============================================================================

Deno.test({
  name: "corporation — disband when last member leaves",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp with P1 only", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Disband",
      });
    });

    let cursorP1: number;

    await t.step("capture P1 cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 leaves corporation (last member)", async () => {
      const result = await apiOk("corporation_leave", {
        character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("P1 receives corporation.disbanded", async () => {
      const events = await eventsOfType(p1Id, "corporation.disbanded", cursorP1);
      assert(events.length >= 1, `Expected >= 1 corporation.disbanded, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.reason, "last_member_left");
    });

    await t.step("DB: P1 no longer in corporation", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.corporation_id, null);
    });
  },
});

// ============================================================================
// Group 6: Regenerate invite code
// ============================================================================

Deno.test({
  name: "corporation — regenerate invite code",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp with P1+P2", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Regen",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      const inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    let cursorP1: number;
    let cursorP2: number;
    let cursorP3: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 regenerates invite code", async () => {
      const result = await apiOk("corporation_regenerate_invite_code", {
        character_id: p1Id,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.new_invite_code, "Response should have new_invite_code");
    });

    await t.step("P1 receives corporation.invite_code_regenerated", async () => {
      const events = await eventsOfType(p1Id, "corporation.invite_code_regenerated", cursorP1, corpId);
      assert(events.length >= 1, `Expected >= 1 for P1, got ${events.length}`);
    });

    await t.step("P2 receives corporation.invite_code_regenerated", async () => {
      const events = await eventsOfType(p2Id, "corporation.invite_code_regenerated", cursorP2, corpId);
      assert(events.length >= 1, `Expected >= 1 for P2, got ${events.length}`);
    });

    await t.step("P3 does NOT receive corporation.invite_code_regenerated", async () => {
      await assertNoEventsOfType(p3Id, "corporation.invite_code_regenerated", cursorP3);
    });
  },
});

// ============================================================================
// Group 7: Corporation info (member vs non-member)
// ============================================================================

Deno.test({
  name: "corporation — info (member vs non-member view)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp with P1", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Info",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
    });

    await t.step("member (P1) sees detailed info", async () => {
      const result = await apiOk("corporation_info", {
        character_id: p1Id,
        corp_id: corpId,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.invite_code, "Member should see invite_code");
      assertExists(body.members, "Member should see members list");
    });

    await t.step("non-member (P3) sees public info only", async () => {
      const result = await apiOk("corporation_info", {
        character_id: p3Id,
        corp_id: corpId,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertEquals(body.name, "Test Corp Info");
      assertExists(body.member_count, "Non-member should see member_count");
      // Non-member should NOT see invite_code
      assertEquals(body.invite_code, undefined, "Non-member should not see invite_code");
    });
  },
});

// ============================================================================
// Group 8: Corporation list
// ============================================================================

Deno.test({
  name: "corporation — list",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create a corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp List",
      });
    });

    await t.step("corporation_list returns the corp", async () => {
      const result = await apiOk("corporation_list", {
        character_id: p1Id,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.corporations, "Response should have corporations");
      const corps = body.corporations as unknown[];
      assert(corps.length >= 1, "Should find at least 1 corporation");
      const corp = corps[0] as Record<string, unknown>;
      assertEquals(corp.name, "Test Corp List");
    });
  },
});

// ============================================================================
// Group 9: Invalid invite code
// ============================================================================

Deno.test({
  name: "corporation — invalid invite code",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Invite",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
    });

    await t.step("join with wrong invite code fails", async () => {
      const result = await api("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: "DEADBEEF",
      });
      assert(!result.ok || !result.body.success, "Expected join with wrong code to fail");
    });

    await t.step("DB: P2 still not in corporation", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, null);
    });
  },
});

// ============================================================================
// Group 10: Already in corporation cannot create another
// ============================================================================

Deno.test({
  name: "corporation — cannot create while in one",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp for P1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 100000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Dup",
      });
    });

    await t.step("P1 cannot create second corporation", async () => {
      const result = await api("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Dup 2",
      });
      assert(!result.ok || !result.body.success, "Expected create to fail when already in corp");
    });
  },
});
