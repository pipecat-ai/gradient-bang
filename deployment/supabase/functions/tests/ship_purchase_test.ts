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

      // Give P1 bank balance for corp purchase
      // autonomous_probe costs 1000
      await setMegabankBalance(p1Id, 10000);
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

    await t.step("DB: bank balance deducted", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      // 10000 - 1000 (price) = 9000
      assertEquals(char.credits_in_megabank, 9000);
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
      // autonomous_probe = 1000, initial credits = 500 → total cost = 1500
      await setMegabankBalance(p1Id, 5000);
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
      assertEquals(body.bank_after, 3500, "5000 - 1000 - 500 = 3500");
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

    await t.step("fails: insufficient bank balance (corp)", async () => {
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Broke Corp",
      });
      await setMegabankBalance(p1Id, 10); // not enough for anything
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
