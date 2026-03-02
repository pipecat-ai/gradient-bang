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
