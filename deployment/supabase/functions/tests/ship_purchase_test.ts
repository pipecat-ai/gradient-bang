/**
 * Integration tests for ship_purchase (personal / corporation).
 *
 * Tests cover:
 *   - Personal ship purchase happy path (trade-in of current ship)
 *   - Corporation ship purchase (creates pseudo-character, corporation_ships link)
 *   - Corp purchase with initial_ship_credits
 *   - Failure: in hyperspace, in combat, insufficient credits, not in corp,
 *     duplicate ship name, price mismatch
 *
 * Setup: P1, P2 in sector 0 (mega-port).
 * Default ship is kestrel_courier (purchase_price=25000, fighters=300).
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
  setShipFighters,
  setShipSector,
  setShipHyperspace,
  setMegabankBalance,
  withPg,
} from "./helpers.ts";

const P1 = "test_shoppurch_p1";
const P2 = "test_shoppurch_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "ship_purchase — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Personal purchase happy path
// ============================================================================

Deno.test({
  name: "ship_purchase — personal purchase with trade-in",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("resolve IDs", async () => {
      p1Id = await characterIdFor(P1);
      p2Id = await characterIdFor(P2);
      p1ShipId = await shipIdFor(P1);
      p2ShipId = await shipIdFor(P2);
    });

    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Give enough credits for a wayfarer_freighter (120000)
      // Trade-in value of kestrel with 300 fighters = 25000
      // Net cost = 120000 - 25000 = 95000
      await setShipCredits(p1ShipId, 100000);
      await setShipFighters(p1ShipId, 300);
    });

    let newShipId: string;
    const oldShipId = p1ShipId;

    await t.step("purchase wayfarer_freighter", async () => {
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "wayfarer_freighter",
      });
      const body = result as Record<string, unknown>;
      assertExists(body.ship_id, "Should return new ship_id");
      assertEquals(body.ship_type, "wayfarer_freighter");
      assertEquals(body.net_cost, 95000, "Net cost after trade-in");
      assertEquals(body.credits_after, 5000, "100000 - 95000 = 5000");
      newShipId = body.ship_id as string;
    });

    await t.step("DB: character points to new ship", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.current_ship_id, newShipId);
    });

    await t.step("DB: new ship has correct type and credits", async () => {
      const ship = await queryShip(newShipId);
      assertExists(ship);
      assertEquals(ship.ship_type, "wayfarer_freighter");
      assertEquals(ship.credits, 5000);
      assertEquals(ship.owner_type, "character");
    });

    await t.step("DB: old ship marked unowned (trade-in)", async () => {
      const oldShip = await queryShip(oldShipId);
      assertExists(oldShip);
      assertEquals(oldShip.owner_type, "unowned");
      assertExists(oldShip.became_unowned, "Should have became_unowned timestamp");
    });
  },
});

// ============================================================================
// Group 2: Corporation purchase
// ============================================================================

Deno.test({
  name: "ship_purchase — corporation purchase creates ship and pseudo-character",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Ship Purchase Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      // corporation_create costs 10000 ship credits, so reset to a known value
      await setShipCredits(p1ShipId, 50000);
    });

    let corpShipId: string;

    await t.step("purchase autonomous_probe for corporation", async () => {
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      const body = result as Record<string, unknown>;
      assertExists(body.ship_id, "Should return new corp ship_id");
      assertEquals(body.ship_type, "autonomous_probe");
      assertEquals(body.corp_id, corpId);
      assertEquals(body.credits_after, 49000, "50000 - 1000 = 49000");
      corpShipId = body.ship_id as string;
    });

    await t.step("DB: corp ship exists with correct ownership", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship);
      assertEquals(ship.ship_type, "autonomous_probe");
      assertEquals(ship.owner_type, "corporation");
      assertEquals(ship.owner_corporation_id, corpId);
    });

    await t.step("DB: pseudo-character created", async () => {
      await withPg(async (pg) => {
        const result = await pg.queryObject<{ character_id: string; is_npc: boolean }>(
          `SELECT character_id, is_npc FROM characters WHERE character_id = $1`,
          [corpShipId],
        );
        assertEquals(result.rows.length, 1, "Pseudo-character should exist");
        assertEquals(result.rows[0].is_npc, true, "Should be marked as NPC");
      });
    });

    await t.step("DB: corporation_ships linkage created", async () => {
      await withPg(async (pg) => {
        const result = await pg.queryObject(
          `SELECT * FROM corporation_ships WHERE ship_id = $1 AND corp_id = $2`,
          [corpShipId, corpId],
        );
        assertEquals(result.rows.length, 1, "Corporation_ships row should exist");
      });
    });

    await t.step("DB: ship credits deducted", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // 50000 - 1000 (price) = 49000
      assertEquals(ship.credits, 49000);
    });

    await t.step("DB: bank balance unchanged", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 0, "Bank should not be touched");
    });
  },
});

// ============================================================================
// Group 3: Corp purchase with initial_ship_credits
// ============================================================================

Deno.test({
  name: "ship_purchase — corp purchase with initial_ship_credits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Init Credits Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      // corporation_create costs 10000, reset to known value
      await setShipCredits(p1ShipId, 50000);
      // autonomous_probe = 1000, initial credits = 500 → total cost = 1500
      // ship credits = 50000, so 50000 - 1500 = 48500
    });

    let corpShipId: string;

    await t.step("purchase with initial_ship_credits", async () => {
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
        initial_ship_credits: 500,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.ship_id);
      assertEquals(body.initial_ship_credits, 500);
      assertEquals(body.credits_after, 48500, "50000 - 1000 - 500 = 48500");
      corpShipId = body.ship_id as string;
    });

    await t.step("DB: corp ship has initial credits", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship);
      assertEquals(ship.credits, 500);
    });
  },
});

// ============================================================================
// Group 4: Purchase failure cases
// ============================================================================

Deno.test({
  name: "ship_purchase — failure cases",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("fails: in hyperspace", async () => {
      await setShipHyperspace(p1ShipId, true, 3);
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "wayfarer_freighter",
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("hyperspace"),
        `Expected hyperspace error, got: ${result.body.error}`,
      );
      await setShipHyperspace(p1ShipId, false);
    });

    await t.step("fails: in combat", async () => {
      await setShipSector(p1ShipId, 0);
      await setShipSector(p2ShipId, 0);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await apiOk("combat_initiate", { character_id: p1Id });

      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "wayfarer_freighter",
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("combat"),
        `Expected combat error, got: ${result.body.error}`,
      );
    });

    await t.step("reset for remaining tests", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("fails: insufficient credits (personal)", async () => {
      await setShipCredits(p1ShipId, 100);
      await setShipFighters(p1ShipId, 0);
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "wayfarer_freighter",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Insufficient"),
        `Expected insufficient error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: insufficient credits (corp)", async () => {
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Broke Corp",
      });
      await setShipCredits(p1ShipId, 10); // not enough for anything
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Insufficient"),
        `Expected insufficient error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: not in corporation for corp purchase", async () => {
      // P2 is not in a corp
      const result = await api("ship_purchase", {
        character_id: p2Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("corporation"),
        `Expected corporation error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: price mismatch", async () => {
      await setShipCredits(p1ShipId, 500000);
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "wayfarer_freighter",
        expected_price: 99999,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Price mismatch"),
        `Expected price mismatch error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: duplicate ship name", async () => {
      // Get P1's current ship name
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      const existingName = ship.ship_name as string;

      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "wayfarer_freighter",
        ship_name: existingName,
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("name"),
        `Expected name error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 7: corporation.ship_purchased event emitted on corp purchase
// ============================================================================

Deno.test({
  name: "ship_purchase — corporation.ship_purchased event emitted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let cursorP1: number;

    await t.step("reset and setup corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Purchase Event Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
    });

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    let corpShipId: string;

    await t.step("purchase corp ship", async () => {
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (result as Record<string, unknown>).ship_id as string;
    });

    await t.step("corporation.ship_purchased event visible via corp_id", async () => {
      const events = await eventsOfType(
        p1Id,
        "corporation.ship_purchased",
        cursorP1,
        corpId,
      );
      assert(
        events.length >= 1,
        `Expected >= 1 corporation.ship_purchased event, got ${events.length}`,
      );
      const payload = events[0].payload;
      assertEquals(payload.ship_id, corpShipId);
      assertEquals(payload.ship_type, "autonomous_probe");
      assertExists(payload.purchase_price);
      assertExists(payload.buyer_id);
      assertExists(payload.corp_name);
    });
  },
});

// ============================================================================
// Group 8: Corp purchase uses ship credits, not bank
// ============================================================================

Deno.test({
  name: "ship_purchase — corp purchase draws from ship credits, bank unchanged",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup with known bank + ship credits", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Ship Credits Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      // corporation_create costs 10000 — reset to known values
      await setShipCredits(p1ShipId, 20000);
      await setMegabankBalance(p1Id, 99999);
    });

    await t.step("purchase autonomous_probe for corporation", async () => {
      // autonomous_probe costs 1000, drawn from ship credits
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      const body = result as Record<string, unknown>;
      assertExists(body.ship_id);
      assertEquals(body.credits_after, 19000, "20000 - 1000 = 19000");
    });

    await t.step("DB: ship credits debited", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.credits, 19000, "Ship credits should be 20000 - 1000");
    });

    await t.step("DB: bank balance unchanged", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(
        char.credits_in_megabank,
        99999,
        "Bank balance must not change on corp purchase",
      );
    });
  },
});

// ============================================================================
// Group 9: Corp purchase with initial_ship_credits uses ship credits
// ============================================================================

Deno.test({
  name: "ship_purchase — corp purchase initial_ship_credits deducted from ship credits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Seed Credits Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      // corporation_create costs 10000 — reset to known values
      await setShipCredits(p1ShipId, 10000);
      await setMegabankBalance(p1Id, 50000);
    });

    let corpShipId: string;

    await t.step("purchase with initial_ship_credits=2000", async () => {
      // autonomous_probe = 1000, initial = 2000, total = 3000
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
        initial_ship_credits: 2000,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.ship_id);
      assertEquals(body.credits_after, 7000, "10000 - 1000 - 2000 = 7000");
      corpShipId = body.ship_id as string;
    });

    await t.step("DB: buyer ship credits debited for price + initial", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.credits, 7000);
    });

    await t.step("DB: new corp ship has seeded credits", async () => {
      const corpShip = await queryShip(corpShipId);
      assertExists(corpShip);
      assertEquals(corpShip.credits, 2000);
    });

    await t.step("DB: bank balance unchanged", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 50000, "Bank should not be touched");
    });
  },
});

// ============================================================================
// Group 10: Corp purchase fails when ship credits insufficient but bank has funds
// ============================================================================

Deno.test({
  name: "ship_purchase — corp purchase fails on low ship credits even with high bank",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Low Ship Credits Corp",
      });
      // corporation_create costs 10000 — set low credits after
      await setShipCredits(p1ShipId, 100); // too low
      await setMegabankBalance(p1Id, 999999); // plenty in bank
    });

    await t.step("corp purchase fails with Insufficient credits", async () => {
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Insufficient"),
        `Expected insufficient error, got: ${result.body.error}`,
      );
    });

    await t.step("DB: bank balance unchanged after failed purchase", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 999999);
    });
  },
});

// ============================================================================
// Group 11: ship.purchased event emitted on personal purchase
// ============================================================================

Deno.test({
  name: "ship_purchase — ship.purchased event emitted for personal purchase",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let cursorP1: number;

    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 100000);
      await setShipFighters(p1ShipId, 300);
    });

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    let newShipId: string;

    await t.step("purchase personal ship", async () => {
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "wayfarer_freighter",
      });
      newShipId = (result as Record<string, unknown>).ship_id as string;
    });

    await t.step("ship.purchased event emitted", async () => {
      const events = await eventsOfType(p1Id, "ship.purchased", cursorP1);
      assert(
        events.length >= 1,
        `Expected >= 1 ship.purchased event, got ${events.length}`,
      );
      const payload = events[0].payload;
      assertEquals(payload.ship_id, newShipId);
      assertEquals(payload.ship_type, "wayfarer_freighter");
      assertExists(payload.purchase_price);
      assertExists(payload.net_cost);
    });
  },
});
