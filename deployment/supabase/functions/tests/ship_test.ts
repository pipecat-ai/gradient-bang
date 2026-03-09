/**
 * Integration tests for ship management.
 *
 * Tests cover:
 *   - List ship definitions
 *   - Purchase ship (trade-in at mega-port)
 *   - Rename ship
 *   - List user ships
 *   - Purchase requires mega-port
 *   - Rename collision (Groups 6–7)
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
  setShipHyperspace,
  setMegabankBalance,
  withPg,
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

// ============================================================================
// Group 6: Rename ship — name collision (409)
// ============================================================================

Deno.test({
  name: "ship — rename collision",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and rename ship to known name", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // First rename to establish the name
      await apiOk("ship_rename", {
        character_id: p1Id,
        ship_name: "UniqueTestShip",
      });
    });

    await t.step("rename to same name is accepted (no change)", async () => {
      const result = await apiOk("ship_rename", {
        character_id: p1Id,
        ship_name: "UniqueTestShip",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.changed, false, "Renaming to same name should return changed=false");
    });

    await t.step("rename to empty name fails", async () => {
      const result = await api("ship_rename", {
        character_id: p1Id,
        ship_name: "   ",
      });
      assertEquals(result.status, 400, "Expected 400 for empty name");
    });
  },
});

// ============================================================================
// Group 7: Ship sell — corp ship at mega-port
// ============================================================================

Deno.test({
  name: "ship — sell corp ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("reset and create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      // Create corp
      const corpResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Ship Sell Corp",
      });
      const corpBody = corpResult as Record<string, unknown>;
      // Buy a corp ship
      const { setMegabankBalance } = await import("./helpers.ts");
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      const purchaseBody = purchaseResult as Record<string, unknown>;
      corpShipId = purchaseBody.ship_id as string;
      assertExists(corpShipId, "Should get corp ship ID");
    });

    await t.step("sell corp ship", async () => {
      const result = await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.trade_in_value, "Should have trade_in_value");
      assert(
        (body.trade_in_value as number) > 0,
        "Trade-in value should be positive",
      );
    });
  },
});

// ============================================================================
// Group 8: Ship sell — cannot sell personal ship
// ============================================================================

Deno.test({
  name: "ship — cannot sell personal ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
    });

    await t.step("sell personal ship fails", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: p1ShipId,
      });
      assert(!result.ok || !result.body.success, "Expected personal ship sell to fail");
      assertEquals(result.status, 400, "Expected 400");
    });
  },
});

// ============================================================================
// Group 9: Ship sell — not at mega-port
// ============================================================================

Deno.test({
  name: "ship — sell fails not at mega-port",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("reset and create corp ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Sell Test Corp",
      });
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      // Move player to non-mega-port sector
      await setShipSector(p1ShipId, 3);
    });

    await t.step("fails: not at mega-port", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("mega-port"));
    });
  },
});

// ============================================================================
// Group 10: Ship sell — in hyperspace
// ============================================================================

Deno.test({
  name: "ship — sell fails in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("reset, create corp ship, go to hyperspace", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Hyper Sell Corp",
      });
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: in hyperspace", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
      });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 11: Ship rename — empty name
// ============================================================================

Deno.test({
  name: "ship — rename empty name rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: empty ship_name", async () => {
      const result = await api("ship_rename", {
        character_id: p1Id,
        ship_name: "",
      });
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 12: Ship sell — invalid ship_id format
// ============================================================================

Deno.test({
  name: "ship — sell invalid ship_id format",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
    });

    await t.step("fails: invalid ship_id format", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: "not-a-valid-id",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("UUID or 6-8 hex"));
    });
  },
});

// ============================================================================
// Group 13: Ship rename — invalid ship_id format
// ============================================================================

Deno.test({
  name: "ship — rename invalid ship_id format",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: invalid ship_id format", async () => {
      const result = await api("ship_rename", {
        character_id: p1Id,
        ship_id: "xyz",
        ship_name: "Test Name",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("UUID or 6-8 hex"));
    });
  },
});

// ============================================================================
// Group 14: Ship rename — empty name
// ============================================================================

Deno.test({
  name: "ship — rename empty name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: empty ship_name", async () => {
      const result = await api("ship_rename", {
        character_id: p1Id,
        ship_name: "   ",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("empty"));
    });
  },
});

// ============================================================================
// Group 15: Ship rename — duplicate name
// ============================================================================

Deno.test({
  name: "ship — rename duplicate name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let currentName: string;

    await t.step("reset and get current name", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      const ship = await queryShip(p1ShipId);
      currentName = ship!.ship_name as string;
    });

    await t.step("rename to a new name", async () => {
      await apiOk("ship_rename", {
        character_id: p1Id,
        ship_name: "UniqueTestShip123",
      });
    });

    await t.step("rename back — no change (same name)", async () => {
      const result = await apiOk("ship_rename", {
        character_id: p1Id,
        ship_name: "UniqueTestShip123",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.changed, false, "Same name should not trigger change");
    });
  },
});

// ============================================================================
// Group 16: Ship sell — cannot sell personal ship
// ============================================================================

Deno.test({
  name: "ship — sell personal ship rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
    });

    await t.step("fails: cannot sell personal ship", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: p1ShipId,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("personal ship"));
    });
  },
});

// ============================================================================
// Group 17: Ship sell — in hyperspace rejected
// ============================================================================

Deno.test({
  name: "ship — sell in hyperspace rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, put in hyperspace", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: in hyperspace", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 18: Ship sell — not at mega-port rejected
// ============================================================================

Deno.test({
  name: "ship — sell not at mega-port rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, move to non-mega sector", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
    });

    await t.step("fails: not at mega-port", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("mega-port"));
    });
  },
});

// ============================================================================
// Group 19: Corp ship rename updates characters.name
// ============================================================================

Deno.test({
  name: "ship — corp ship rename updates character name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("reset, create corp, buy corp ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Rename Test Corp",
      });
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      assertExists(corpShipId, "Should get corp ship ID");
    });

    await t.step("corp ship character has default name", async () => {
      const char = await queryCharacter(corpShipId);
      assertExists(char);
      assert(
        (char.name as string).startsWith("Corp Ship ["),
        `Expected default name starting with 'Corp Ship [', got '${char.name}'`,
      );
    });

    await t.step("rename corp ship", async () => {
      const result = await apiOk("ship_rename", {
        character_id: p1Id,
        ship_id: corpShipId,
        ship_name: "Nebula Runner",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.ship_name, "Nebula Runner");
      assertEquals(body.changed, true);
    });

    await t.step("DB: ship_instances.ship_name updated", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship);
      assertEquals(ship.ship_name, "Nebula Runner");
    });

    await t.step("DB: characters.name also updated", async () => {
      const char = await queryCharacter(corpShipId);
      assertExists(char);
      assertEquals(
        char.name,
        "Nebula Runner",
        "characters.name should be updated to match the new ship name",
      );
    });
  },
});

// ============================================================================
// Group 20: Ship sell — target not found
// ============================================================================

Deno.test({
  name: "ship — sell target not found",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset at mega-port", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
    });

    await t.step("fails: ship not found", async () => {
      const result = await api("ship_sell", {
        character_id: p1Id,
        ship_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 404);
    });
  },
});

// ============================================================================
// Group 21: Ship sell — sold ship is soft-deleted (destroyed_at set)
// ============================================================================

Deno.test({
  name: "ship — sold ship is soft-deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;

    await t.step("reset and create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Delete Test Corp",
      });
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      assertExists(corpShipId, "Should get corp ship ID");
    });

    await t.step("ship exists before sell with no destroyed_at", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship, "Corp ship should exist before selling");
      assertEquals(ship.destroyed_at, null, "destroyed_at should be null before sell");
    });

    await t.step("sell the corp ship", async () => {
      const result = await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("ship has destroyed_at set after sell", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship, "Ship row should still exist (soft-delete)");
      assertExists(ship.destroyed_at, "destroyed_at should be set after sell");
    });

    await t.step("corp ship character record is deleted", async () => {
      const char = await queryCharacter(corpShipId);
      assertEquals(char, null, "Corp ship character should be deleted");
    });
  },
});

// ============================================================================
// Group 22a: Ship sell — events associated with sold ship are preserved
// ============================================================================

Deno.test({
  name: "ship — sell preserves events for sold ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let cursorP1: number;

    await t.step("reset, create corp ship, generate events", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Event Preserve Corp",
      });
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      assertExists(corpShipId, "Should get corp ship ID");
    });

    let eventCountBefore: number;

    await t.step("count events referencing the corp ship before sell", async () => {
      eventCountBefore = await withPg(async (pg) => {
        const result = await pg.queryObject<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM events WHERE ship_id = $1`,
          [corpShipId],
        );
        return result.rows[0].count;
      });
      assert(eventCountBefore >= 0, "Should be able to count events");
    });

    await t.step("sell the corp ship", async () => {
      cursorP1 = await getEventCursor(p1Id);
      const result = await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("events referencing sold ship still exist", async () => {
      const eventCountAfter = await withPg(async (pg) => {
        const result = await pg.queryObject<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM events WHERE ship_id = $1`,
          [corpShipId],
        );
        return result.rows[0].count;
      });
      assert(
        eventCountAfter >= eventCountBefore,
        `Events should be preserved: had ${eventCountBefore} before, got ${eventCountAfter} after`,
      );
    });
  },
});

// ============================================================================
// Group 22: Ship sell — sold ship's credits included in refund to player ship
// ============================================================================

Deno.test({
  name: "ship — sell refunds ship credits to player ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let tradeInValue: number;
    const corpShipCredits = 500;
    const personalShipCredits = 50000;

    await t.step("reset and create corp ship with credits", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, personalShipCredits);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Credit Test Corp",
      });
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      assertExists(corpShipId, "Should get corp ship ID");
      // Give the corp ship a credit balance
      await setShipCredits(corpShipId, corpShipCredits);
      // Reset personal ship credits to a known value after purchase
      await setShipCredits(p1ShipId, personalShipCredits);
    });

    await t.step("sell succeeds and credits_after includes ship credits", async () => {
      const result = await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      tradeInValue = body.trade_in_value as number;
      const creditsAfter = body.credits_after as number;
      // credits_after should include trade-in value PLUS the sold ship's held credits
      assertEquals(
        creditsAfter,
        personalShipCredits + tradeInValue + corpShipCredits,
        `Expected credits_after to include the sold ship's ${corpShipCredits} credits on top of trade-in value ${tradeInValue}`,
      );
    });

    await t.step("DB: player ship credits match expected total", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      const expectedCredits = personalShipCredits + tradeInValue + corpShipCredits;
      assertEquals(
        ship.credits as number,
        expectedCredits,
        `Expected player ship credits == ${personalShipCredits} + ${tradeInValue} (trade-in) + ${corpShipCredits} (refund) = ${expectedCredits}`,
      );
    });
  },
});

// ============================================================================
// Group 23: Ship sell — emits status.update and corporation.ship_sold events
// ============================================================================

Deno.test({
  name: "ship — sell emits expected events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let corpId: string;
    let cursorP1: number;

    await t.step("reset and create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      const corpResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Event Test Corp",
      });
      const char = await queryCharacter(p1Id);
      assertExists(char);
      corpId = char.corporation_id as string;
      assertExists(corpId, "Player should have a corporation_id");
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      assertExists(corpShipId, "Should get corp ship ID");
    });

    await t.step("capture cursor and sell", async () => {
      cursorP1 = await getEventCursor(p1Id);
      const result = await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("player receives status.update event", async () => {
      const events = await eventsOfType(p1Id, "status.update", cursorP1);
      assert(events.length >= 1, `Expected >= 1 status.update, got ${events.length}`);
    });

    await t.step("player receives corporation.ship_sold event", async () => {
      const events = await eventsOfType(p1Id, "corporation.ship_sold", cursorP1, corpId);
      assert(events.length >= 1, `Expected >= 1 corporation.ship_sold, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.ship_id, corpShipId, "Event should reference the sold ship");
      assertExists(payload.trade_in_value, "Event should include trade_in_value");
      assertEquals(payload.seller_id, p1Id, "Event should reference the seller");
    });
  },
});
