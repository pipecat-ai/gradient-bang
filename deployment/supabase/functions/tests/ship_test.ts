/**
 * Integration tests for ship management.
 *
 * Tests cover:
 *   - List ship definitions
 *   - Purchase ship (trade-in at mega-port)
 *   - Rename ship
 *   - List user ships
 *   - Purchase requires mega-port
 *
 * Setup: 1 player in sector 0 (mega-port by default).
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
  setShipCredits,
  setShipSector,
} from "./helpers.ts";

const P1 = "test_ship_p1";

let p1Id: string;
let p1ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "ship — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: List ship definitions
// ============================================================================

Deno.test({
  name: "ship — list definitions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p1ShipId = await shipIdFor(P1);

    await t.step("reset database", async () => {
      // Pin to sector 1 in PINNED_SECTORS but we set to sector 0 for mega-port
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("get ship definitions", async () => {
      const result = await apiOk("ship_definitions", {});
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.definitions, "Response should have definitions");
      const defs = body.definitions as unknown[];
      assert(defs.length >= 1, "Should have at least 1 ship definition");
      // Check a definition has expected fields
      const def = defs[0] as Record<string, unknown>;
      assertExists(def.ship_type, "Definition should have ship_type");
      assertExists(def.display_name, "Definition should have display_name");
      assertExists(def.cargo_holds, "Definition should have cargo_holds");
      assertExists(def.purchase_price, "Definition should have purchase_price");
    });
  },
});

// ============================================================================
// Group 2: Purchase ship (trade-in)
// ============================================================================

Deno.test({
  name: "ship — purchase with trade-in",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and give credits", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Must be at mega-port (sector 0)
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 100000);
    });

    let cursorP1: number;
    let oldShipId: string;

    await t.step("capture cursor and record old ship", async () => {
      cursorP1 = await getEventCursor(p1Id);
      oldShipId = p1ShipId;
    });

    await t.step("P1 purchases a new ship", async () => {
      // Get available ship types first
      const defs = await apiOk("ship_definitions", {});
      const definitions = (defs as Record<string, unknown>).definitions as Array<Record<string, unknown>>;
      // Find a ship type different from current (kestrel_courier)
      const otherShip = definitions.find((d) => d.ship_type !== "kestrel_courier");
      assertExists(otherShip, "Should find a different ship type to purchase");

      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: otherShip.ship_type as string,
        trade_in_ship_id: oldShipId,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.ship_id, "Response should have ship_id");
    });

    await t.step("P1 receives ship.traded_in event", async () => {
      const events = await eventsOfType(p1Id, "ship.traded_in", cursorP1);
      assert(events.length >= 1, `Expected >= 1 ship.traded_in, got ${events.length}`);
    });

    await t.step("P1 receives status.update", async () => {
      const events = await eventsOfType(p1Id, "status.update", cursorP1);
      assert(events.length >= 1);
    });

    await t.step("DB: character has new current_ship_id", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      // Ship ID should have changed
      assert(char.current_ship_id !== oldShipId, "Ship ID should have changed after trade-in");
    });
  },
});

// ============================================================================
// Group 3: Rename ship
// ============================================================================

Deno.test({
  name: "ship — rename",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 renames ship", async () => {
      const result = await apiOk("ship_rename", {
        character_id: p1Id,
        ship_name: "SS Testington",
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertEquals(body.ship_name, "SS Testington");
      assertEquals(body.changed, true);
    });

    await t.step("P1 receives ship.renamed event", async () => {
      const events = await eventsOfType(p1Id, "ship.renamed", cursorP1);
      assert(events.length >= 1, `Expected >= 1 ship.renamed, got ${events.length}`);
    });

    await t.step("DB: ship name updated", async () => {
      // Get current ship ID
      const char = await queryCharacter(p1Id);
      assertExists(char);
      const ship = await queryShip(char.current_ship_id as string);
      assertExists(ship);
      assertEquals(ship.ship_name, "SS Testington");
    });
  },
});

// ============================================================================
// Group 4: List user ships
// ============================================================================

Deno.test({
  name: "ship — list user ships",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 requests ship list", async () => {
      const result = await apiOk("list_user_ships", {
        character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("P1 receives ships.list event", async () => {
      const events = await eventsOfType(p1Id, "ships.list", cursorP1);
      assert(events.length >= 1, `Expected >= 1 ships.list, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.ships, "payload.ships");
      const ships = payload.ships as unknown[];
      assert(ships.length >= 1, "Should have at least 1 ship");
    });
  },
});

// ============================================================================
// Group 5: Purchase requires mega-port
// ============================================================================

Deno.test({
  name: "ship — purchase fails without mega-port",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move to non-mega sector", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      const char = await queryCharacter(p1Id);
      assertExists(char);
      // Move to sector 1 (not mega-port)
      await setShipSector(char.current_ship_id as string, 1);
      await setShipCredits(char.current_ship_id as string, 100000);
    });

    await t.step("purchase fails without mega-port", async () => {
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "kestrel_courier",
      });
      assert(!result.ok || !result.body.success, "Expected purchase to fail without mega-port");
    });
  },
});
