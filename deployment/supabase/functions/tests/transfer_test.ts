/**
 * Integration tests for player-to-player transfers.
 *
 * Tests cover:
 *   - Transfer credits (both players get events)
 *   - Transfer warp power
 *   - Transfer fails when in different sectors
 *   - Transfer fails with insufficient funds
 *   - Bank deposit (mega-port, same corp)
 *   - Bank withdraw (mega-port)
 *   - Warp transfer edge cases (Groups 7–11)
 *
 * Setup: 2 players in sector 0 (mega-port).
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
  setShipSector,
  setShipWarpPower,
  setShipHyperspace,
  setShipFighters,
} from "./helpers.ts";

const P1 = "test_xfer_p1";
const P2 = "test_xfer_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "transfer — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Transfer credits
// ============================================================================

Deno.test({
  name: "transfer — credits between players",
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
      await setShipCredits(p1ShipId, 5000);
      await setShipCredits(p2ShipId, 1000);
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 transfers 500 credits to P2", async () => {
      const result = await apiOk("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
        amount: 500,
      });
      assert(result.success);
    });

    await t.step("P1 receives credits.transfer (sent)", async () => {
      const events = await eventsOfType(p1Id, "credits.transfer", cursorP1);
      assert(events.length >= 1, `Expected >= 1 credits.transfer for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.transfer_direction, "sent");
    });

    await t.step("P2 receives credits.transfer (received)", async () => {
      const events = await eventsOfType(p2Id, "credits.transfer", cursorP2);
      assert(events.length >= 1, `Expected >= 1 credits.transfer for P2, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.transfer_direction, "received");
    });

    await t.step("both receive status.update", async () => {
      const p1Events = await eventsOfType(p1Id, "status.update", cursorP1);
      assert(p1Events.length >= 1, "P1 should receive status.update");
      const p2Events = await eventsOfType(p2Id, "status.update", cursorP2);
      assert(p2Events.length >= 1, "P2 should receive status.update");
    });

    await t.step("DB: credits moved correctly", async () => {
      const ship1 = await queryShip(p1ShipId);
      const ship2 = await queryShip(p2ShipId);
      assertExists(ship1);
      assertExists(ship2);
      assertEquals(ship1.credits, 4500);
      assertEquals(ship2.credits, 1500);
    });
  },
});

// ============================================================================
// Group 2: Transfer warp power
// ============================================================================

Deno.test({
  name: "transfer — warp power between players",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
      await setShipWarpPower(p2ShipId, 100);
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 transfers 50 warp to P2", async () => {
      const result = await apiOk("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assert(result.success);
    });

    await t.step("P1 receives warp.transfer (sent)", async () => {
      const events = await eventsOfType(p1Id, "warp.transfer", cursorP1);
      assert(events.length >= 1, `Expected >= 1 warp.transfer for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.transfer_direction, "sent");
    });

    await t.step("P2 receives warp.transfer (received)", async () => {
      const events = await eventsOfType(p2Id, "warp.transfer", cursorP2);
      assert(events.length >= 1, `Expected >= 1 warp.transfer for P2, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.transfer_direction, "received");
    });
  },
});

// ============================================================================
// Group 3: Transfer fails — different sectors
// ============================================================================

Deno.test({
  name: "transfer — fails when in different sectors",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move P2 to different sector", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 5000);
      // Move P2 to sector 1
      await setShipSector(p2ShipId, 1);
    });

    await t.step("transfer fails with sector mismatch", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
        amount: 100,
      });
      assert(!result.ok || !result.body.success, "Expected transfer to fail when in different sectors");
    });
  },
});

// ============================================================================
// Group 4: Transfer fails — insufficient funds
// ============================================================================

Deno.test({
  name: "transfer — fails with insufficient credits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and drain P1 credits", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 0);
    });

    await t.step("transfer fails with no credits", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
        amount: 100,
      });
      assert(!result.ok || !result.body.success, "Expected transfer to fail with no credits");
    });
  },
});

// ============================================================================
// Group 5: Bank deposit (mega-port, same corp)
// ============================================================================

Deno.test({
  name: "transfer — bank deposit at mega-port",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, create corp, and set up", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      // Create corp and join P2
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp Bank",
      });
      const corpId = (result as Record<string, unknown>).corp_id as string;
      const inviteCode = (result as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    let cursorP2: number;

    await t.step("capture cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 deposits 1000 credits to P2's bank", async () => {
      const result = await apiOk("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: P2,
        amount: 1000,
      });
      assert(result.success);
    });

    await t.step("P2 receives bank.transaction event", async () => {
      // Bank event is routed to target (P2), not depositor (P1)
      const events = await eventsOfType(p2Id, "bank.transaction", cursorP2);
      assert(events.length >= 1, `Expected >= 1 bank.transaction for P2, got ${events.length}`);
    });
  },
});

// ============================================================================
// Group 6: Bank withdraw (mega-port)
// ============================================================================

Deno.test({
  name: "transfer — bank withdraw at mega-port",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and give P1 bank balance", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Give P1 a bank balance via SQL
      const { withPg } = await import("./helpers.ts");
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE characters SET credits_in_megabank = 5000 WHERE character_id = $1`,
          [p1Id],
        );
      });
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 withdraws 500 from bank", async () => {
      const result = await apiOk("bank_transfer", {
        character_id: p1Id,
        direction: "withdraw",
        amount: 500,
      });
      assert(result.success);
    });

    await t.step("P1 receives bank.transaction event", async () => {
      const events = await eventsOfType(p1Id, "bank.transaction", cursorP1);
      assert(events.length >= 1, `Expected >= 1 bank.transaction, got ${events.length}`);
    });

    await t.step("DB: bank balance decreased and ship credits increased", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assert(
        (char.credits_in_megabank as number) <= 4500,
        `Bank balance should have decreased: ${char.credits_in_megabank}`,
      );
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assert(
        (ship.credits as number) >= 1500,
        `Ship credits should have increased: ${ship.credits}`,
      );
    });
  },
});

// ============================================================================
// Group 7: Warp transfer — self-transfer rejected
// ============================================================================

Deno.test({
  name: "transfer — warp self-transfer rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipWarpPower(p1ShipId, 400);
    });

    await t.step("self-transfer fails", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P1,
        units: 50,
      });
      assert(!result.ok || !result.body.success, "Expected self-transfer to fail");
      // May return 400 ("Cannot transfer to self") or 404 (target not found)
      assert(
        result.status === 400 || result.status === 404,
        `Expected 400 or 404 for self-transfer, got ${result.status}`,
      );
    });
  },
});

// ============================================================================
// Group 8: Warp transfer — sender clamp (over-request becomes partial)
// ============================================================================

Deno.test({
  name: "transfer — warp over-request clamps to sender available",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and drain warp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // P1 has 5 warp, P2 drained so receiver has plenty of room.
      await setShipWarpPower(p1ShipId, 5);
      await setShipWarpPower(p2ShipId, 10);
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("over-request succeeds with partial amount", async () => {
      const result = await apiOk("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assert(result.success);
    });

    await t.step("warp.transfer event reports actual amount (5)", async () => {
      const events = await eventsOfType(p1Id, "warp.transfer", cursorP1);
      assert(events.length >= 1, `Expected >= 1 warp.transfer, got ${events.length}`);
      const payload = events[0].payload as Record<string, unknown>;
      const details = payload.transfer_details as Record<string, unknown>;
      assertEquals(details.warp_power, 5, "Expected clamped amount 5, not requested 50");
    });

    await t.step("sender drained to 0", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_warp_power, 0);
    });
  },
});

// ============================================================================
// Group 8b: Warp transfer — sender at 0 warp still errors
// ============================================================================

Deno.test({
  name: "transfer — warp fails when sender has zero warp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and drain sender to zero", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 0);
      await setShipWarpPower(p2ShipId, 10);
    });

    await t.step("transfer fails with zero-warp sender", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assert(!result.ok || !result.body.success);
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("no warp power"),
        `Expected 'no warp power' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 9: Warp transfer — different sectors
// ============================================================================

Deno.test({
  name: "transfer — warp fails in different sectors",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move P2 away", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
      await setShipSector(p2ShipId, 1);
    });

    await t.step("transfer fails with sector mismatch", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assert(!result.ok || !result.body.success, "Expected different sectors to fail");
    });
  },
});

// ============================================================================
// Group 10: Warp transfer — receiver in hyperspace
// ============================================================================

Deno.test({
  name: "transfer — warp fails when receiver in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and put P2 in hyperspace", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
      // Put P2 in hyperspace
      const { setShipHyperspace } = await import("./helpers.ts");
      await setShipHyperspace(p2ShipId, true, 1);
    });

    await t.step("transfer fails when receiver in hyperspace", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assert(!result.ok || !result.body.success, "Expected hyperspace transfer to fail");
    });
  },
});

// ============================================================================
// Group 11: Warp transfer — no recipient identifier
// ============================================================================

Deno.test({
  name: "transfer — warp fails without recipient identifier",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipWarpPower(p1ShipId, 400);
    });

    await t.step("transfer fails without recipient", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        units: 50,
      });
      assert(!result.ok || !result.body.success, "Expected missing recipient to fail");
      assertEquals(result.status, 400, "Expected 400");
    });
  },
});

// ============================================================================
// Group 12: Credits — invalid amount (0, negative, missing)
// ============================================================================

Deno.test({
  name: "transfer — credits invalid amount",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 5000);
    });

    await t.step("fails: amount = 0", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
        amount: 0,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });

    await t.step("fails: amount negative", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
        amount: -100,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });

    await t.step("fails: amount missing", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });
  },
});

// ============================================================================
// Group 13: Credits — no recipient identifier
// ============================================================================

Deno.test({
  name: "transfer — credits fails without recipient",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 5000);
    });

    await t.step("fails: no recipient", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        amount: 100,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("to_player_name"));
    });
  },
});

// ============================================================================
// Group 14: Credits — self-transfer rejected
// ============================================================================

Deno.test({
  name: "transfer — credits self-transfer rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 5000);
    });

    await t.step("self-transfer fails", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P1,
        amount: 100,
      });
      assert(
        result.status === 400 || result.status === 404,
        `Expected 400 or 404, got ${result.status}`,
      );
    });
  },
});

// ============================================================================
// Group 15: Credits — sender in hyperspace
// ============================================================================

Deno.test({
  name: "transfer — credits fails when sender in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and put P1 in hyperspace", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 5000);
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: sender in hyperspace", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
        amount: 100,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 16: Credits — in combat blocked
// ============================================================================

Deno.test({
  name: "transfer — credits fails when in combat",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and initiate combat", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 5000);
      // Move both to sector 3 (non-fedspace, non-megaport)
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 50);
      await setShipFighters(p2ShipId, 50);
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    await t.step("fails: sender in combat", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_player_name: P2,
        amount: 100,
      });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("combat"));
    });
  },
});

// ============================================================================
// Group 17: Credits — invalid to_ship_id format
// ============================================================================

Deno.test({
  name: "transfer — credits invalid to_ship_id format",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 5000);
    });

    await t.step("fails: to_ship_id too short", async () => {
      const result = await api("transfer_credits", {
        from_character_id: p1Id,
        to_ship_id: "abc",
        amount: 100,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("UUID or 6-8 hex"));
    });
  },
});

// ============================================================================
// Group 18: Credits — transfer by ship_id
// ============================================================================

Deno.test({
  name: "transfer — credits by ship_id",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 5000);
      await setShipCredits(p2ShipId, 1000);
    });

    await t.step("transfer by to_ship_id succeeds", async () => {
      const result = await apiOk("transfer_credits", {
        from_character_id: p1Id,
        to_ship_id: p2ShipId,
        amount: 200,
      });
      assert(result.success);
    });

    await t.step("DB: credits moved", async () => {
      const ship1 = await queryShip(p1ShipId);
      const ship2 = await queryShip(p2ShipId);
      assertExists(ship1);
      assertExists(ship2);
      assertEquals(ship1.credits, 4800);
      assertEquals(ship2.credits, 1200);
    });
  },
});

// ============================================================================
// Group 19: Warp — invalid units (0, negative, missing)
// ============================================================================

Deno.test({
  name: "transfer — warp invalid units",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
    });

    await t.step("fails: units = 0", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 0,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });

    await t.step("fails: units negative", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: -10,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });

    await t.step("fails: units missing", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });
  },
});

// ============================================================================
// Group 20: Warp — sender in hyperspace
// ============================================================================

Deno.test({
  name: "transfer — warp fails when sender in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and put P1 in hyperspace", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: sender in hyperspace", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 20b: Warp transfer — clamped by both sender and receiver (min wins)
// ============================================================================

Deno.test({
  name: "transfer — warp clamp picks minimum of sender, receiver, request",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset with tight bounds on both sides", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // kestrel_courier warp_power_capacity=500.
      // Sender has 40 warp. Receiver at 480/500 (room = 20). Request 100.
      // Expected transfer: min(100, 40, 20) = 20.
      await setShipWarpPower(p1ShipId, 40);
      await setShipWarpPower(p2ShipId, 480);
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("transfer succeeds with receiver-capped amount", async () => {
      const result = await apiOk("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 100,
      });
      assert(result.success);
    });

    await t.step("warp.transfer event reports clamped amount (20)", async () => {
      const events = await eventsOfType(p1Id, "warp.transfer", cursorP1);
      assert(events.length >= 1);
      const payload = events[0].payload as Record<string, unknown>;
      const details = payload.transfer_details as Record<string, unknown>;
      assertEquals(details.warp_power, 20);
    });

    await t.step("DB: sender lost 20, receiver at max", async () => {
      const p1Ship = await queryShip(p1ShipId);
      const p2Ship = await queryShip(p2ShipId);
      assertExists(p1Ship);
      assertExists(p2Ship);
      assertEquals(p1Ship.current_warp_power, 20);
      assertEquals(p2Ship.current_warp_power, 500);
    });
  },
});

// ============================================================================
// Group 21: Warp — receiver at max capacity
// ============================================================================

Deno.test({
  name: "transfer — warp fails when receiver at max capacity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and max out P2 warp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
      // kestrel_courier warp_power_capacity=500 (updated in migration)
      await setShipWarpPower(p2ShipId, 500);
    });

    await t.step("fails: receiver at max capacity", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("maximum"));
    });
  },
});

// ============================================================================
// Group 22: Warp — missing target
// ============================================================================

Deno.test({
  name: "transfer — warp fails when no target specified",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
    });

    await t.step("fails: no target specified", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        units: 50,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("Must provide"));
    });
  },
});

// ============================================================================
// Group 23: Warp — units validation
// ============================================================================

Deno.test({
  name: "transfer — warp fails with invalid units",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
    });

    await t.step("fails: zero units", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 0,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("units"));
    });

    await t.step("fails: negative units", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: -10,
      });
      assertEquals(result.status, 400);
    });

    await t.step("fails: missing units", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
      });
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 24: Warp — self-transfer rejected
// ============================================================================

Deno.test({
  name: "transfer — warp self-transfer rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipWarpPower(p1ShipId, 400);
    });

    await t.step("fails: cannot transfer to self", async () => {
      // Use to_ship_id to bypass the name-lookup exclusion filter
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_ship_id: p1ShipId,
        units: 50,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("yourself"));
    });
  },
});

// ============================================================================
// Group 25: Warp — target not found in sector
// ============================================================================

Deno.test({
  name: "transfer — warp target not found",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, move P2 to different sector", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipWarpPower(p1ShipId, 400);
      await setShipSector(p2ShipId, 3);
    });

    await t.step("fails: target not found in sector", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_player_name: P2,
        units: 50,
      });
      assertEquals(result.status, 404);
    });
  },
});

// ============================================================================
// Group 26: Warp — invalid to_ship_id format
// ============================================================================

Deno.test({
  name: "transfer — warp invalid ship_id format",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("fails: invalid to_ship_id format", async () => {
      const result = await api("transfer_warp_power", {
        from_character_id: p1Id,
        to_ship_id: "xyz",
        units: 50,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("UUID or 6-8 hex"));
    });
  },
});
