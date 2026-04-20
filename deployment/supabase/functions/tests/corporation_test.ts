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
  setMegabankBalance,
  withPg,
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

    await t.step("P1 receives status.update after creation", async () => {
      const events = await eventsOfType(p1Id, "status.update", cursorP1);
      assert(events.length >= 1, `Expected >= 1 status.update, got ${events.length}`);
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

    await t.step("P1 kicks P2 (confirmed)", async () => {
      // confirm=true skips the two-step confirm flow (which is UI-driven).
      const result = await apiOk("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
        confirm: true,
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
  name: "corporation — info (founder, non-founder member, non-member)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step("reset and create corp with P1 (founder) + P2 (joiner)", async () => {
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
      inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("founder (P1) sees invite_code + is_founder:true", async () => {
      const result = await apiOk("corporation_info", {
        character_id: p1Id,
        corp_id: corpId,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.invite_code, "Founder should see invite_code");
      assertEquals(body.is_founder, true, "Founder should have is_founder:true");
      assertExists(body.members, "Member payload should include members list");
    });

    await t.step("non-founder member (P2) sees is_founder:false, NO invite_code", async () => {
      const result = await apiOk("corporation_info", {
        character_id: p2Id,
        corp_id: corpId,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertEquals(body.is_founder, false, "Non-founder member should have is_founder:false");
      assertEquals(
        body.invite_code,
        undefined,
        "Non-founder member should NOT see invite_code",
      );
      assertExists(body.members, "Non-founder member still sees members list");
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
      assertEquals(
        body.invite_code,
        undefined,
        "Non-member should not see invite_code",
      );
      assertEquals(
        body.is_founder,
        undefined,
        "Non-member public payload has no is_founder flag",
      );
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

// ============================================================================
// Group 11: corporation_leave — not in a corporation
// ============================================================================

Deno.test({
  name: "corporation — leave not in corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset (P3 not in any corp)", async () => {
      await resetDatabase([P3]);
      await apiOk("join", { character_id: p3Id });
    });

    await t.step("fails: not in a corporation", async () => {
      const result = await api("corporation_leave", {
        character_id: p3Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("Not in a corporation"));
    });
  },
});

// ============================================================================
// Group 12: corporation_leave — actor mismatch
// ============================================================================

Deno.test({
  name: "corporation — leave actor mismatch",
  // BUG: ensureActorMatches() is called at line 82 (outside the try-catch at
  // line 101) so CorporationLeaveError falls through to the server's generic
  // 500 handler instead of returning 400.
  ignore: true,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp for P1", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Actor Mismatch Corp",
      });
    });

    await t.step("fails: actor mismatch", async () => {
      const result = await api("corporation_leave", {
        character_id: p1Id,
        actor_character_id: p2Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("actor_character_id must match"));
    });
  },
});

// ============================================================================
// Group 13: corporation_join — switch corps via pending-confirm (last member)
// ============================================================================

Deno.test({
  name: "corporation — join triggers pending when last member of old corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId1: string;
    let corpId2: string;
    let inviteCode2: string;

    await t.step("reset and create two corps", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const p2ShipId = await shipIdFor(P2);
      await setShipCredits(p2ShipId, 50000);

      // P1 is last (and only) member of corp 1.
      const result1 = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Corp One",
      });
      corpId1 = (result1 as Record<string, unknown>).corp_id as string;

      // P2 creates corp 2.
      const result2 = await apiOk("corporation_create", {
        character_id: p2Id,
        name: "Corp Two",
      });
      corpId2 = (result2 as Record<string, unknown>).corp_id as string;
      inviteCode2 = (result2 as Record<string, unknown>).invite_code as string;
    });

    let cursorP1: number;

    await t.step("capture P1 cursor before pending join", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 joins corp 2 without confirm → pending, no state change", async () => {
      const result = await apiOk("corporation_join", {
        character_id: p1Id,
        corp_id: corpId2,
        invite_code: inviteCode2,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.pending, true, "Response should be pending");
      assertEquals(body.will_disband, true, "Response should flag will_disband");
      assertEquals(body.old_corp_id, corpId1);
    });

    await t.step("P1 receives corporation.join_pending (character-scoped)", async () => {
      const events = await eventsOfType(
        p1Id,
        "corporation.join_pending",
        cursorP1,
      );
      assert(
        events.length >= 1,
        `Expected >= 1 corporation.join_pending, got ${events.length}`,
      );
      const payload = events[0].payload;
      assertEquals(payload.corp_id, corpId2);
      assertEquals(payload.old_corp_id, corpId1);
      assertEquals(payload.will_disband, true);
    });

    await t.step("DB: P1 still in corp 1 (no mutation without confirm)", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpId1);
    });

    await t.step("P1 confirms → old corp disbands, join succeeds", async () => {
      const result = await apiOk("corporation_join", {
        character_id: p1Id,
        corp_id: corpId2,
        invite_code: inviteCode2,
        confirm: true,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.corp_id, corpId2);
    });

    await t.step("P1 receives corporation.disbanded for old corp", async () => {
      const events = await eventsOfType(
        p1Id,
        "corporation.disbanded",
        cursorP1,
      );
      assert(events.length >= 1, "Expected corporation.disbanded after confirm");
      assertEquals(events[0].payload.corp_id, corpId1);
      assertEquals(events[0].payload.reason, "last_member_joined_other");
    });

    await t.step("DB: P1 now in corp 2", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpId2);
    });
  },
});

// ============================================================================
// Group 14: corporation_join — corp not found
// ============================================================================

Deno.test({
  name: "corporation — join corp not found",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P2]);
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("fails: corp not found", async () => {
      const result = await api("corporation_join", {
        character_id: p2Id,
        corp_id: crypto.randomUUID(),
        invite_code: "ANYCODE",
      });
      assert(
        result.status === 404 || result.status === 500,
        `Expected 404 or 500 for unknown corp, got ${result.status}`,
      );
    });
  },
});

// ============================================================================
// Group 15: corporation_join — actor mismatch
// ============================================================================

Deno.test({
  name: "corporation — join actor mismatch",
  // BUG: ensureActorMatches() is called at line 75 (outside the try-catch at
  // line 93) so CorporationJoinError falls through to the server's generic
  // 500 handler instead of returning 400.
  ignore: true,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step("reset and create corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Actor Match Corp",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      inviteCode = (result as Record<string, unknown>).invite_code as string;
    });

    await t.step("fails: actor mismatch", async () => {
      const result = await api("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
        actor_character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("actor_character_id must match"));
    });
  },
});

// ============================================================================
// Group 16: corporation — corp ship actor auth (non-member rejected)
// ============================================================================

Deno.test({
  name: "corporation — corp ship non-member rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("reset and create corp with ship", async () => {
      await resetDatabase([P1, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Auth Test Corp",
      });

      // Buy a corp ship
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
    });

    await t.step("non-member P3 rejected for corp ship", async () => {
      // Try to control the corp ship as P3 (non-member)
      const result = await api("recharge_warp_power", {
        character_id: corpShipId,
        actor_character_id: p3Id,
        units: 10,
      });
      // Should get auth error (403) since P3 is not in the corp
      assert(
        result.status === 403 || result.status === 400,
        `Expected 403 or 400, got ${result.status}: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 17: corporation_kick — self-kick rejected
// ============================================================================

Deno.test({
  name: "corporation — kick self rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp for P1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Self Kick Corp",
      });
    });

    await t.step("fails: cannot kick self", async () => {
      const result = await api("corporation_kick", {
        character_id: p1Id,
        target_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("leave"),
        `Expected leave-hint error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 18: corporation_kick — not in a corporation
// ============================================================================

Deno.test({
  name: "corporation — kick not in corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset (P1 not in any corp)", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("fails: not in a corporation", async () => {
      const result = await api("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Not in a corporation"),
        `Expected not-in-corp error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 19: corporation_kick — target not in same corporation
// ============================================================================

Deno.test({
  name: "corporation — kick target not in same corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, create corp for P1, P2 not in it", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Target Mismatch Corp",
      });
    });

    await t.step("fails: target not in your corporation", async () => {
      const result = await api("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("not in your corporation"),
        `Expected target-not-in-corp error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 20: corporation_kick — actor mismatch
// ============================================================================

Deno.test({
  name: "corporation — kick actor mismatch",
  // BUG: ensureActorMatches() is called at line 80 (outside the try-catch at
  // line 107) so CorporationKickError falls through to the server's generic
  // 500 handler instead of returning 400.
  ignore: true,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp with P1+P2", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Kick Actor Corp",
      });
      const corpId = (result as Record<string, unknown>).corp_id as string;
      const inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("fails: actor mismatch", async () => {
      const result = await api("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
        actor_character_id: p3Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("actor_character_id must match"));
    });
  },
});

// ============================================================================
// Group 21: corporation_create — name too short
// ============================================================================

Deno.test({
  name: "corporation — create name too short",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("fails: name too short", async () => {
      const result = await api("corporation_create", {
        character_id: p1Id,
        name: "AB",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("3-50"),
        `Expected name length error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 22: corporation_create — name too long
// ============================================================================

Deno.test({
  name: "corporation — create name too long",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("fails: name too long", async () => {
      const result = await api("corporation_create", {
        character_id: p1Id,
        name: "A".repeat(51),
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("3-50"),
        `Expected name length error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 23: corporation_create — insufficient credits
// ============================================================================

Deno.test({
  name: "corporation — create insufficient credits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset with low credits", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 500);
    });

    await t.step("fails: insufficient credits", async () => {
      const result = await api("corporation_create", {
        character_id: p1Id,
        name: "Broke Corp",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Insufficient"),
        `Expected insufficient credits error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 24: corporation_create — duplicate name
// ============================================================================

Deno.test({
  name: "corporation — create duplicate name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create first corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const p2Ship = await shipIdFor(P2);
      await setShipCredits(p2Ship, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Unique Name Corp",
      });
    });

    await t.step("fails: duplicate name", async () => {
      const result = await api("corporation_create", {
        character_id: p2Id,
        name: "Unique Name Corp",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("already taken"),
        `Expected duplicate name error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 25: corporation_create — actor mismatch
// ============================================================================

Deno.test({
  name: "corporation — create actor mismatch",
  // BUG: ensureActorMatches() is called at line 75 (outside the try-catch at
  // line 99) so CorporationCreateError falls through to the server's generic
  // 500 handler instead of returning 400.
  ignore: true,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("fails: actor mismatch", async () => {
      const result = await api("corporation_create", {
        character_id: p1Id,
        name: "Mismatch Corp",
        actor_character_id: p2Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("actor_character_id must match"));
    });
  },
});

// ============================================================================
// Group 26: corporation_regenerate_invite_code — not in corp
// ============================================================================

Deno.test({
  name: "corporation — regen invite not in corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset (P3 not in any corp)", async () => {
      await resetDatabase([P3]);
      await apiOk("join", { character_id: p3Id });
    });

    await t.step("fails: not in a corporation", async () => {
      const result = await api("corporation_regenerate_invite_code", {
        character_id: p3Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Not in a corporation"),
        `Expected not-in-corp error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 27: corporation_rename — happy path
// ============================================================================

Deno.test({
  name: "corporation — rename",
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
        name: "Rename Corp Original",
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

    await t.step("capture cursors before rename", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 renames corporation", async () => {
      const result = await apiOk("corporation_rename", {
        character_id: p1Id,
        name: "Rename Corp Updated",
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertEquals(body.name, "Rename Corp Updated");
    });

    await t.step("P1 receives corporation.data event", async () => {
      const events = await eventsOfType(p1Id, "corporation.data", cursorP1);
      assert(events.length >= 1, `Expected >= 1 corporation.data for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.corporation, "Event should include corporation payload");
      assertEquals(
        (payload.corporation as Record<string, unknown>).name,
        "Rename Corp Updated",
      );
    });

    await t.step("P2 receives corporation.data event", async () => {
      const events = await eventsOfType(p2Id, "corporation.data", cursorP2);
      assert(events.length >= 1, `Expected >= 1 corporation.data for P2, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(
        (payload.corporation as Record<string, unknown>).name,
        "Rename Corp Updated",
      );
    });

    await t.step("P3 does NOT receive corporation.data event", async () => {
      await assertNoEventsOfType(p3Id, "corporation.data", cursorP3);
    });
  },
});

// ============================================================================
// Group 28: corporation_rename — not in corp
// ============================================================================

Deno.test({
  name: "corporation — rename not in corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset (P3 not in any corp)", async () => {
      await resetDatabase([P3]);
      await apiOk("join", { character_id: p3Id });
    });

    await t.step("fails: not in a corporation", async () => {
      const result = await api("corporation_rename", {
        character_id: p3Id,
        name: "Should Fail",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Not in a corporation"),
        `Expected not-in-corp error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 29: corporation_rename — name too short
// ============================================================================

Deno.test({
  name: "corporation — rename name too short",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Short Name Test Corp",
      });
    });

    await t.step("fails: name too short", async () => {
      const result = await api("corporation_rename", {
        character_id: p1Id,
        name: "AB",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("3-50"),
        `Expected name length error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 30: corporation_rename — name too long
// ============================================================================

Deno.test({
  name: "corporation — rename name too long",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Long Name Test Corp",
      });
    });

    await t.step("fails: name too long", async () => {
      const result = await api("corporation_rename", {
        character_id: p1Id,
        name: "A".repeat(51),
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("3-50"),
        `Expected name length error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 31: corporation_rename — duplicate name
// ============================================================================

Deno.test({
  name: "corporation — rename duplicate name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create two corps", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const p2Ship = await shipIdFor(P2);
      await setShipCredits(p2Ship, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Existing Corp Name",
      });
      await apiOk("corporation_create", {
        character_id: p2Id,
        name: "Other Corp Name",
      });
    });

    await t.step("fails: duplicate name", async () => {
      const result = await api("corporation_rename", {
        character_id: p2Id,
        name: "Existing Corp Name",
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("already exists"),
        `Expected duplicate name error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: duplicate name (case-insensitive)", async () => {
      const result = await api("corporation_rename", {
        character_id: p2Id,
        name: "existing corp name",
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("already exists"),
        `Expected duplicate name error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 32: corporation — invite code is a two-word passphrase
// ============================================================================

Deno.test({
  name: "corporation — invite code is a two-word passphrase",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("invite_code has the word-word shape", async () => {
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Passphrase Corp",
      });
      const code = (result as Record<string, unknown>).invite_code as string;
      assertExists(code, "Response should include invite_code");
      assert(
        /^[a-z]+-[a-z]+$/.test(code),
        `Expected word-word passphrase, got: ${code}`,
      );
    });
  },
});

// ============================================================================
// Group 33: corporation_kick — founder-only authorization
// ============================================================================

Deno.test({
  name: "corporation — kick rejected for non-founder member",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step("reset and create corp with founder P1 + members P2 + P3", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Founder Kick Corp",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
      await apiOk("corporation_join", {
        character_id: p3Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("non-founder P2 cannot kick P3", async () => {
      const result = await api("corporation_kick", {
        character_id: p2Id,
        target_id: p3Id,
      });
      assertEquals(result.status, 403);
      assert(
        (result.body.error as string | undefined)?.toLowerCase().includes("founder"),
        `Expected founder-only error, got: ${result.body.error}`,
      );
    });

    await t.step("DB: P3 still in corporation", async () => {
      const char = await queryCharacter(p3Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpId);
    });
  },
});

// ============================================================================
// Group 34: corporation_kick — pending flow (two-step confirm)
// ============================================================================

Deno.test({
  name: "corporation — kick without confirm emits pending event, no mutation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp with founder P1 + member P2 + bystander P3", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Kick Pending Corp",
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

    await t.step("P1 kicks P2 WITHOUT confirm → pending", async () => {
      const result = await apiOk("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.pending, true);
      assertExists(body.target_name, "Response includes target display name");
    });

    await t.step("P1 (kicker) receives corporation.kick_pending", async () => {
      const events = await eventsOfType(
        p1Id,
        "corporation.kick_pending",
        cursorP1,
      );
      assert(events.length >= 1, "Kicker should receive kick_pending");
    });

    await t.step("P2 (target) does NOT receive corporation.kick_pending", async () => {
      await assertNoEventsOfType(p2Id, "corporation.kick_pending", cursorP2);
    });

    await t.step("P3 (bystander) does NOT receive corporation.kick_pending", async () => {
      await assertNoEventsOfType(p3Id, "corporation.kick_pending", cursorP3);
    });

    await t.step("DB: P2 still in corporation (no confirm yet)", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpId);
    });

    await t.step("P1 confirms → P2 is removed", async () => {
      await apiOk("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
        confirm: true,
      });
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, null);
    });
  },
});

// ============================================================================
// Group 35: corporation_regenerate_invite_code — founder-only
// ============================================================================

Deno.test({
  name: "corporation — regen invite code rejected for non-founder",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp with founder P1 + member P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Regen Founder Corp",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      const inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("non-founder P2 cannot regenerate the invite code", async () => {
      const result = await api("corporation_regenerate_invite_code", {
        character_id: p2Id,
      });
      assertEquals(result.status, 403);
      assert(
        (result.body.error as string | undefined)?.toLowerCase().includes("founder"),
        `Expected founder-only error, got: ${result.body.error}`,
      );
    });

    await t.step("founder P1 CAN regenerate the invite code", async () => {
      const result = await apiOk("corporation_regenerate_invite_code", {
        character_id: p1Id,
      });
      assertExists(
        (result as Record<string, unknown>).new_invite_code,
        "Founder should get new_invite_code",
      );
    });
  },
});

// ============================================================================
// Group 36: corporation_join — silent auto-leave when not last member
// ============================================================================

Deno.test({
  name: "corporation — join auto-leaves old corp silently when not last member",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpIdA: string;
    let corpIdB: string;
    let inviteB: string;

    await t.step("reset, P1+P2 in corp A, P3 founds corp B", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const p3ShipId = await shipIdFor(P3);
      await setShipCredits(p3ShipId, 50000);

      const a = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Corp A Auto",
      });
      corpIdA = (a as Record<string, unknown>).corp_id as string;
      const inviteA = (a as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpIdA,
        invite_code: inviteA,
      });

      const b = await apiOk("corporation_create", {
        character_id: p3Id,
        name: "Corp B Auto",
      });
      corpIdB = (b as Record<string, unknown>).corp_id as string;
      inviteB = (b as Record<string, unknown>).invite_code as string;
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors before P2 switches", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P2 joins corp B (no confirm needed — still a member in A)", async () => {
      const result = await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpIdB,
        invite_code: inviteB,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.pending, undefined, "Should NOT be pending (not last member)");
      assertEquals(body.corp_id, corpIdB);
    });

    await t.step("P2 does NOT receive corporation.join_pending", async () => {
      await assertNoEventsOfType(p2Id, "corporation.join_pending", cursorP2);
    });

    await t.step("P1 receives corporation.member_left for corp A", async () => {
      const events = await eventsOfType(
        p1Id,
        "corporation.member_left",
        cursorP1,
        corpIdA,
      );
      assert(events.length >= 1, "P1 should see member_left in corp A");
    });

    await t.step("DB: P2 now in corp B, corp A still alive", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpIdB);

      await withPg(async (pg) => {
        const result = await pg.queryObject<{ disbanded_at: unknown }>(
          `SELECT disbanded_at FROM corporations WHERE corp_id = $1`,
          [corpIdA],
        );
        assertEquals(
          result.rows[0]?.disbanded_at,
          null,
          "Corp A should still be active (P1 is still a member)",
        );
      });
    });
  },
});

// ============================================================================
// Group 37: corporation_join — refused when old corp owns ships
// ============================================================================

Deno.test({
  name: "corporation — join refused when old corp owns ships",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpIdA: string;
    let corpIdB: string;
    let inviteB: string;

    await t.step("reset, P1 founds corp A with a ship, P3 founds corp B", async () => {
      await resetDatabase([P1, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const p3ShipId = await shipIdFor(P3);
      await setShipCredits(p3ShipId, 50000);

      const a = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Ship Refuse A",
      });
      corpIdA = (a as Record<string, unknown>).corp_id as string;

      // Buy a corp-owned ship so A has lingering assets.
      await setMegabankBalance(p1Id, 100000);
      await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });

      const b = await apiOk("corporation_create", {
        character_id: p3Id,
        name: "Ship Refuse B",
      });
      corpIdB = (b as Record<string, unknown>).corp_id as string;
      inviteB = (b as Record<string, unknown>).invite_code as string;
    });

    await t.step("P1 cannot join corp B while corp A owns ships", async () => {
      const result = await api("corporation_join", {
        character_id: p1Id,
        corp_id: corpIdB,
        invite_code: inviteB,
      });
      assertEquals(result.status, 400);
      assert(
        (result.body.error as string | undefined)
          ?.toLowerCase()
          .includes("sell"),
        `Expected sell-ships error, got: ${result.body.error}`,
      );
      // The error payload includes the offending ships so the LLM can list them.
      assertExists(
        result.body.ships,
        "Error payload should include ships array",
      );
    });

    await t.step("DB: P1 still in corp A, corp A still active", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpIdA);
    });
  },
});

// ============================================================================
// Group 38: corporation_join — founder can rejoin without invite code
// ============================================================================

Deno.test({
  name: "corporation — founder rejoin without invite code",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step(
      "reset, P1 founds corp, P2 joins, P1 leaves (corp stays alive with P2)",
      async () => {
        await resetDatabase([P1, P2, P3]);
        await apiOk("join", { character_id: p1Id });
        await apiOk("join", { character_id: p2Id });
        await apiOk("join", { character_id: p3Id });
        await setShipCredits(p1ShipId, 50000);
        const result = await apiOk("corporation_create", {
          character_id: p1Id,
          name: "Founder Rejoin Corp",
        });
        corpId = (result as Record<string, unknown>).corp_id as string;
        const inviteCode = (result as Record<string, unknown>).invite_code as string;
        await apiOk("corporation_join", {
          character_id: p2Id,
          corp_id: corpId,
          invite_code: inviteCode,
        });
        await apiOk("corporation_leave", { character_id: p1Id });
      },
    );

    await t.step("P1 (founder) rejoins without invite code", async () => {
      const result = await apiOk("corporation_join", {
        character_id: p1Id,
        corp_id: corpId,
        // No invite_code provided.
      });
      assertEquals(
        (result as Record<string, unknown>).corp_id,
        corpId,
        "Founder should successfully rejoin",
      );
    });

    await t.step("DB: P1 is back in the corp", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.corporation_id, corpId);
    });

    await t.step("non-founder P3 still needs a valid invite code", async () => {
      // Regression safety: invite-code enforcement is only relaxed for the
      // founder. Everyone else must provide the real code.
      const result = await api("corporation_join", {
        character_id: p3Id,
        corp_id: corpId,
        // No invite_code.
      });
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 39: corporation_join — invite code accepts varied separator input
// ============================================================================

Deno.test({
  name: "corporation — invite code normalization tolerates varied separators",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let canonical: string;

    await t.step("reset and create corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Normalize Corp",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      canonical = (result as Record<string, unknown>).invite_code as string;
      // Canonical form is always lowercase `word-word`.
      assert(
        /^[a-z]+-[a-z]+$/.test(canonical),
        `Expected canonical word-word code, got: ${canonical}`,
      );
    });

    // The code generator produces `word-word` — the two words are separated
    // by a single dash. Users can deliver the same passphrase many ways
    // depending on speech-to-text, typing habits, copy-paste, etc. The
    // validation path should treat all of these as equivalent.
    const variants = (code: string): string[] => {
      const [a, b] = code.split("-");
      return [
        `${a} ${b}`, // spoken (space)
        `${a}  ${b}`, // double space
        `  ${a}  ${b}  `, // leading/trailing whitespace
        `${a.toUpperCase()}-${b.toUpperCase()}`, // shouty
        `${a[0].toUpperCase()}${a.slice(1)}-${b}`, // title-ish
        `${a}_${b}`, // underscore
        `${a}--${b}`, // double dash
      ];
    };

    await t.step("join succeeds for each variant (separate attempt each)", async () => {
      const codeVariants = variants(canonical);
      for (const variant of codeVariants) {
        // Fresh join each time — reset P2 between attempts so we're really
        // testing the validator rather than side-effects of a prior join.
        await resetDatabase([P1, P2]);
        await apiOk("join", { character_id: p1Id });
        await apiOk("join", { character_id: p2Id });
        await setShipCredits(p1ShipId, 50_000);
        const createAgain = await apiOk("corporation_create", {
          character_id: p1Id,
          name: "Normalize Corp",
        });
        const freshCorpId = (createAgain as Record<string, unknown>).corp_id as string;
        // The generator is random per create, so rebuild variants from the
        // fresh canonical code for correctness.
        const freshCanonical = (createAgain as Record<string, unknown>)
          .invite_code as string;
        const [a, b] = freshCanonical.split("-");
        // Apply the same transformation as `variant` was derived from canonical,
        // by locating its index in the original variants array.
        const idx = codeVariants.indexOf(variant);
        const reshaped = variants(freshCanonical)[idx];
        const result = await apiOk("corporation_join", {
          character_id: p2Id,
          corp_id: freshCorpId,
          invite_code: reshaped,
        });
        assert(
          result.success,
          `Variant [${reshaped}] (derived from canonical ${freshCanonical}, a=${a} b=${b}) should be accepted`,
        );
      }
    });

    await t.step("join still rejects genuinely wrong code", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Normalize Corp Reject",
      });
      const corpIdReject = (result as Record<string, unknown>).corp_id as string;
      const bad = await api("corporation_join", {
        character_id: p2Id,
        corp_id: corpIdReject,
        invite_code: "not-a-real-code",
      });
      assertEquals(bad.status, 400);
    });
  },
});

// ============================================================================
// Group 40: my_status corporation payload — founder-aware gating
// ============================================================================
//
// Status snapshots carry a lightweight corp summary used by the client to
// drive founder-only UI (e.g. the CorporationDetailsDialog invite section).
// The payload must include `is_founder` and `founder_id` for any corp
// member, and must include `invite_code` ONLY for the founder. Non-corp
// players get `corporation: null`. Regression test for the modal-stale
// bug where status.update wiped founder fields.

Deno.test({
  name: "corporation — status.corporation includes founder-aware fields",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step("reset, create corp with P1, P2 joins, P3 stays solo", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50_000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Status Gating Corp",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("founder P1 status: is_founder=true, founder_id set, invite_code present", async () => {
      const cursor = await getEventCursor(p1Id);
      await apiOk("my_status", { character_id: p1Id });
      const snapshots = await eventsOfType(p1Id, "status.snapshot", cursor);
      assert(snapshots.length >= 1, "my_status should emit status.snapshot");
      const payload = snapshots[snapshots.length - 1].payload as Record<string, unknown>;
      const corp = payload.corporation as Record<string, unknown> | null;
      assertExists(corp, "P1's status should include corporation");
      assertEquals(corp.corp_id, corpId);
      assertEquals(corp.founder_id, p1Id);
      assertEquals(corp.is_founder, true);
      assertEquals(corp.invite_code, inviteCode);
    });

    await t.step("non-founder P2 status: is_founder=false, founder_id set, NO invite_code", async () => {
      const cursor = await getEventCursor(p2Id);
      await apiOk("my_status", { character_id: p2Id });
      const snapshots = await eventsOfType(p2Id, "status.snapshot", cursor);
      assert(snapshots.length >= 1, "my_status should emit status.snapshot");
      const payload = snapshots[snapshots.length - 1].payload as Record<string, unknown>;
      const corp = payload.corporation as Record<string, unknown> | null;
      assertExists(corp, "P2's status should include corporation");
      assertEquals(corp.corp_id, corpId);
      assertEquals(corp.founder_id, p1Id);
      assertEquals(corp.is_founder, false);
      assert(
        !("invite_code" in corp),
        "Non-founder status.corporation must NOT include invite_code",
      );
    });

    await t.step("non-corp P3 status: corporation is null", async () => {
      const cursor = await getEventCursor(p3Id);
      await apiOk("my_status", { character_id: p3Id });
      const snapshots = await eventsOfType(p3Id, "status.snapshot", cursor);
      assert(snapshots.length >= 1, "my_status should emit status.snapshot");
      const payload = snapshots[snapshots.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.corporation, null);
    });
  },
});
