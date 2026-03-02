/**
 * Integration tests for trading & economy.
 *
 * Tests cover:
 *   - Buy goods from port
 *   - Sell goods to port
 *   - Insufficient credits / cargo space
 *   - No port in sector
 *   - Recharge warp power (mega-port)
 *   - Purchase fighters (mega-port)
 *   - Dump cargo (salvage creation)
 *   - Collect salvage
 *
 * Setup: 2 players in sector 1 (BBS port: buys QF+RO, sells NS).
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
  queryShip,
  assertNoEventsOfType,
  setShipCredits,
  setShipCargo,
  setShipSector,
  setShipWarpPower,
  setShipFighters,
} from "./helpers.ts";

const P1 = "test_trade_p1";
const P2 = "test_trade_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "trade — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Buy goods from port
// ============================================================================

Deno.test({
  name: "trade — buy goods from port",
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
      // Give enough credits to buy
      await setShipCredits(p1ShipId, 50000);
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 buys neuro_symbolics from port", async () => {
      // Sector 1 port (BBS) sells neuro_symbolics
      const result = await apiOk("trade", {
        character_id: p1Id,
        commodity: "neuro_symbolics",
        trade_type: "buy",
        quantity: 5,
      });
      assert(result.success);
    });

    await t.step("P1 receives trade.executed event", async () => {
      const events = await eventsOfType(p1Id, "trade.executed", cursorP1);
      assert(events.length >= 1, `Expected >= 1 trade.executed, got ${events.length}`);
    });

    await t.step("P1 receives status.update event", async () => {
      const events = await eventsOfType(p1Id, "status.update", cursorP1);
      assert(events.length >= 1, `Expected >= 1 status.update, got ${events.length}`);
    });

    await t.step("P1 receives port.update event", async () => {
      const events = await eventsOfType(p1Id, "port.update", cursorP1);
      assert(events.length >= 1, `Expected >= 1 port.update for P1, got ${events.length}`);
    });

    await t.step("P2 receives port.update (sector broadcast)", async () => {
      const events = await eventsOfType(p2Id, "port.update", cursorP2);
      assert(events.length >= 1, `Expected >= 1 port.update for P2, got ${events.length}`);
    });

    await t.step("P2 does NOT receive trade.executed", async () => {
      await assertNoEventsOfType(p2Id, "trade.executed", cursorP2);
    });

    await t.step("DB: ship cargo increased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assert((ship.cargo_ns as number) > 0, "Should have neuro_symbolics cargo (cargo_ns)");
    });
  },
});

// ============================================================================
// Group 2: Sell goods to port
// ============================================================================

Deno.test({
  name: "trade — sell goods to port",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and give P1 cargo", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // Give P1 quantum_foam to sell (sector 1 port buys QF)
      await setShipCargo(p1ShipId, { qf: 20, ro: 0, ns: 0 });
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 sells quantum_foam to port", async () => {
      const result = await apiOk("trade", {
        character_id: p1Id,
        commodity: "quantum_foam",
        trade_type: "sell",
        quantity: 5,
      });
      assert(result.success);
    });

    await t.step("P1 receives trade.executed", async () => {
      const events = await eventsOfType(p1Id, "trade.executed", cursorP1);
      assert(events.length >= 1);
    });

    await t.step("P2 receives port.update", async () => {
      const events = await eventsOfType(p2Id, "port.update", cursorP2);
      assert(events.length >= 1);
    });

    await t.step("DB: ship credits increased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // Started with 1000, should have more after selling
      assert((ship.credits as number) > 1000, `Credits should have increased: ${ship.credits}`);
    });
  },
});

// ============================================================================
// Group 3: Insufficient credits
// ============================================================================

Deno.test({
  name: "trade — insufficient credits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and drain credits", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 0);
    });

    await t.step("buy fails with insufficient credits", async () => {
      const result = await api("trade", {
        character_id: p1Id,
        commodity: "neuro_symbolics",
        trade_type: "buy",
        quantity: 5,
      });
      assert(!result.ok || !result.body.success, "Expected trade to fail with no credits");
    });
  },
});

// ============================================================================
// Group 4: No port in sector
// ============================================================================

Deno.test({
  name: "trade — no port in sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move P1 to sector without port", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Move P1 to sector 0 (no port)
      await setShipSector(p1ShipId, 0);
    });

    await t.step("trade fails with no port", async () => {
      const result = await api("trade", {
        character_id: p1Id,
        commodity: "neuro_symbolics",
        trade_type: "buy",
        quantity: 5,
      });
      assert(!result.ok || !result.body.success, "Expected trade to fail with no port");
    });
  },
});

// ============================================================================
// Group 5: Recharge warp power (mega-port)
// ============================================================================

Deno.test({
  name: "trade — recharge warp power",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move P1 to mega-port", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // Sector 0 is mega-port by default
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 100); // drain some warp
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 recharges warp power", async () => {
      const result = await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 50,
      });
      assert(result.success);
    });

    await t.step("P1 receives warp.purchase event", async () => {
      const events = await eventsOfType(p1Id, "warp.purchase", cursorP1);
      assert(events.length >= 1, `Expected >= 1 warp.purchase, got ${events.length}`);
    });

    await t.step("P1 receives status.update", async () => {
      const events = await eventsOfType(p1Id, "status.update", cursorP1);
      assert(events.length >= 1);
    });

    await t.step("P2 does NOT receive warp.purchase", async () => {
      await assertNoEventsOfType(p2Id, "warp.purchase", cursorP2);
    });

    await t.step("DB: warp power increased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assert((ship.current_warp_power as number) >= 150, `Warp should have increased: ${ship.current_warp_power}`);
    });
  },
});

// ============================================================================
// Group 6: Purchase fighters (mega-port)
// ============================================================================

Deno.test({
  name: "trade — purchase fighters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move P1 to mega-port with low fighters", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      // Kestrel courier starts at max 300 fighters, reduce so we can buy more
      await setShipFighters(p1ShipId, 100);
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 purchases fighters", async () => {
      const result = await apiOk("purchase_fighters", {
        character_id: p1Id,
        units: 10,
      });
      assert(result.success);
    });

    await t.step("P1 receives fighter.purchase event", async () => {
      const events = await eventsOfType(p1Id, "fighter.purchase", cursorP1);
      assert(events.length >= 1, `Expected >= 1 fighter.purchase, got ${events.length}`);
    });

    await t.step("DB: credits decreased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assert((ship.credits as number) < 50000, `Credits should have decreased: ${ship.credits}`);
    });
  },
});

// ============================================================================
// Group 7: Dump cargo (salvage creation)
// ============================================================================

Deno.test({
  name: "trade — dump cargo creates salvage",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and give P1 cargo", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCargo(p1ShipId, { qf: 20, ro: 10, ns: 5 });
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 dumps some cargo", async () => {
      const result = await apiOk("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 5 },
      });
      assert(result.success);
    });

    await t.step("P1 receives salvage.created event", async () => {
      const events = await eventsOfType(p1Id, "salvage.created", cursorP1);
      assert(events.length >= 1, `Expected >= 1 salvage.created, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.action, "dumped");
      assertExists(payload.salvage_details, "payload.salvage_details");
    });

    await t.step("P1 receives status.update", async () => {
      const events = await eventsOfType(p1Id, "status.update", cursorP1);
      assert(events.length >= 1);
    });

    await t.step("P2 receives sector.update (salvage visible)", async () => {
      const events = await eventsOfType(p2Id, "sector.update", cursorP2);
      assert(events.length >= 1, `Expected >= 1 sector.update for P2, got ${events.length}`);
    });
  },
});

// ============================================================================
// Group 8: Collect salvage
// ============================================================================

Deno.test({
  name: "trade — collect salvage",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, give P1 cargo, dump it", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 0 });
      await apiOk("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 5 },
      });
    });

    // Get the salvage ID from the salvage.created event
    let salvageId: string;

    await t.step("get salvage ID from event", async () => {
      const events = await eventsOfType(p1Id, "salvage.created");
      assert(events.length >= 1, "Should have salvage.created event");
      const details = events[0].payload.salvage_details as Record<string, unknown>;
      assertExists(details.salvage_id, "Should have salvage_id");
      salvageId = details.salvage_id as string;
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors before collect", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P2 collects salvage", async () => {
      const result = await apiOk("salvage_collect", {
        character_id: p2Id,
        salvage_id: salvageId,
      });
      assert(result.success);
    });

    await t.step("P2 receives salvage.collected event", async () => {
      const events = await eventsOfType(p2Id, "salvage.collected", cursorP2);
      assert(events.length >= 1, `Expected >= 1 salvage.collected, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.action, "collected");
    });

    await t.step("P1 receives sector.update", async () => {
      const events = await eventsOfType(p1Id, "sector.update", cursorP1);
      assert(events.length >= 1, `Expected >= 1 sector.update for P1, got ${events.length}`);
    });
  },
});
