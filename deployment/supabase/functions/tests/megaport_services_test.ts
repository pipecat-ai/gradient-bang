/**
 * Integration tests for mega-port services and corp management.
 *
 * Tests cover:
 *   - purchase_fighters: happy path, capped to capacity, at max, insufficient credits, not at mega-port
 *   - recharge_warp_power: happy path, capped to capacity, at max, insufficient credits
 *   - ship_rename: happy path, duplicate name fails, empty name fails
 *   - corporation_kick: happy path, self-kick rejected, target not in same corp
 *   - corporation_leave: happy path, last member leaves → corp disbanded, ships become unowned
 *
 * Setup: P1, P2, P3 in sector 0 (mega-port).
 * Kestrel courier: fighters=300, warp_power_capacity=500, fighter_price=50, warp_price=2.
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
  setShipWarpPower,
  setShipHyperspace,
  setMegabankBalance,
  createCorpShip,
  withPg,
} from "./helpers.ts";

const P1 = "test_megaport_p1";
const P2 = "test_megaport_p2";
const P3 = "test_megaport_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p1ShipId: string;
let p2ShipId: string;
let p3ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "megaport_services — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: purchase_fighters
// ============================================================================

Deno.test({
  name: "megaport_services — purchase_fighters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("resolve IDs", async () => {
      p1Id = await characterIdFor(P1);
      p2Id = await characterIdFor(P2);
      p3Id = await characterIdFor(P3);
      p1ShipId = await shipIdFor(P1);
      p2ShipId = await shipIdFor(P2);
      p3ShipId = await shipIdFor(P3);
    });

    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // kestrel_courier: max fighters=300
      await setShipFighters(p1ShipId, 200);
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("happy path: buy 50 fighters", async () => {
      const result = await apiOk("purchase_fighters", {
        character_id: p1Id,
        units: 50,
      });
      assertEquals(
        (result as Record<string, unknown>).units_purchased,
        50,
      );
    });

    await t.step("DB: fighters increased, credits deducted", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_fighters, 250, "200 + 50 = 250");
      // 50 fighters * 50 credits each = 2500
      assertEquals(ship.credits, 47500, "50000 - 2500 = 47500");
    });

    await t.step("capped to capacity: request 999 but only 50 remain", async () => {
      const result = await apiOk("purchase_fighters", {
        character_id: p1Id,
        units: 999,
      });
      assertEquals(
        (result as Record<string, unknown>).units_purchased,
        50,
        "Should cap to 50 (300-250)",
      );
    });

    await t.step("DB: at max fighters now", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_fighters, 300);
    });

    await t.step("fails: already at maximum", async () => {
      const result = await api("purchase_fighters", {
        character_id: p1Id,
        units: 1,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("maximum"));
    });

    await t.step("fails: insufficient credits", async () => {
      await setShipFighters(p1ShipId, 0);
      await setShipCredits(p1ShipId, 10); // Need 50 per fighter
      const result = await api("purchase_fighters", {
        character_id: p1Id,
        units: 1,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("Insufficient"));
    });

    await t.step("fails: not at mega-port", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipSector(p1ShipId, 3);
      const result = await api("purchase_fighters", {
        character_id: p1Id,
        units: 10,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("mega-port"));
      await setShipSector(p1ShipId, 0);
    });
  },
});

// ============================================================================
// Group 2: recharge_warp_power
// ============================================================================

Deno.test({
  name: "megaport_services — recharge_warp_power",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // kestrel_courier: warp_power_capacity=500
      await setShipWarpPower(p1ShipId, 200);
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("happy path: recharge 100 warp power", async () => {
      const result = await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 100,
      });
      assertExists(result);
    });

    await t.step("DB: warp power increased, credits deducted", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_warp_power, 300, "200 + 100 = 300");
      // 100 units * 2 credits each = 200
      assertEquals(ship.credits, 49800, "50000 - 200 = 49800");
    });

    await t.step("capped to capacity: request 999 but only 200 remain", async () => {
      const result = await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 999,
      });
      assertExists(result);
    });

    await t.step("DB: at max warp power now", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_warp_power, 500);
    });

    await t.step("fails: already at maximum", async () => {
      const result = await api("recharge_warp_power", {
        character_id: p1Id,
        units: 1,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("maximum"));
    });

    await t.step("fails: insufficient credits", async () => {
      await setShipWarpPower(p1ShipId, 0);
      await setShipCredits(p1ShipId, 1); // Need 2 per unit
      const result = await api("recharge_warp_power", {
        character_id: p1Id,
        units: 100,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("Insufficient"));
    });
  },
});

// ============================================================================
// Group 3: ship_rename
// ============================================================================

Deno.test({
  name: "megaport_services — ship_rename",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("happy path: rename own ship", async () => {
      const result = await apiOk("ship_rename", {
        character_id: p1Id,
        ship_name: "The Stardancer",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.ship_name, "The Stardancer");
      assertEquals(body.changed, true);
    });

    await t.step("DB: ship name updated", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.ship_name, "The Stardancer");
    });

    await t.step("fails: duplicate name", async () => {
      const result = await api("ship_rename", {
        character_id: p2Id,
        ship_name: "The Stardancer",
      });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("name"));
    });

    await t.step("fails: empty name", async () => {
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
// Group 4: corporation_kick
// ============================================================================

Deno.test({
  name: "megaport_services — corporation_kick",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup corp (P1+P2)", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });

      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Kick Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("fails: self-kick rejected", async () => {
      const result = await api("corporation_kick", {
        character_id: p1Id,
        target_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("leave"));
    });

    await t.step("fails: target not in same corp", async () => {
      const result = await api("corporation_kick", {
        character_id: p1Id,
        target_id: p3Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("not in your corporation"));
    });

    await t.step("happy path: P1 kicks P2", async () => {
      const result = await apiOk("corporation_kick", {
        character_id: p1Id,
        target_id: p2Id,
      });
      assertExists(result);
    });

    await t.step("DB: P2 no longer in corporation", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.corporation_id, null, "P2 should have no corporation");
    });
  },
});

// ============================================================================
// Group 5: corporation_leave and disband
// ============================================================================

Deno.test({
  name: "megaport_services — corporation_leave disbands when last member leaves",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and setup sole-member corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Doomed Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      // Give bank balance for corp ship purchase
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
    });

    await t.step("sell corp ship before leaving", async () => {
      const result = await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
      assertExists(result);
    });

    await t.step("P1 leaves — corp should disband", async () => {
      const result = await apiOk("corporation_leave", {
        character_id: p1Id,
      });
      assertExists(result);
    });

    await t.step("DB: P1 no longer in corporation", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.corporation_id, null);
    });

    await t.step("DB: corporation soft-deleted", async () => {
      await withPg(async (pg) => {
        const result = await pg.queryObject<{ disbanded_at: string | null }>(
          `SELECT disbanded_at FROM corporations WHERE corp_id = $1`,
          [corpId],
        );
        assertEquals(result.rows.length, 1, "Corporation row should still exist");
        assertExists(result.rows[0].disbanded_at, "Corporation should be soft-deleted");
      });
    });
  },
});

// ============================================================================
// Group 6: recharge_warp_power — in hyperspace
// ============================================================================

Deno.test({
  name: "megaport_services — recharge_warp_power in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: in hyperspace", async () => {
      const result = await api("recharge_warp_power", {
        character_id: p1Id,
        units: 10,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 7: recharge_warp_power — not at mega-port
// ============================================================================

Deno.test({
  name: "megaport_services — recharge_warp_power not at mega-port",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipWarpPower(p1ShipId, 100);
      await setShipCredits(p1ShipId, 50000);
      await setShipSector(p1ShipId, 3);
    });

    await t.step("fails: not at mega-port", async () => {
      const result = await api("recharge_warp_power", {
        character_id: p1Id,
        units: 10,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("mega-port"));
    });
  },
});

// ============================================================================
// Group 8: recharge_warp_power — invalid units
// ============================================================================

Deno.test({
  name: "megaport_services — recharge_warp_power invalid units",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipWarpPower(p1ShipId, 100);
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("fails: units = 0", async () => {
      const result = await api("recharge_warp_power", {
        character_id: p1Id,
        units: 0,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });

    await t.step("fails: units negative", async () => {
      const result = await api("recharge_warp_power", {
        character_id: p1Id,
        units: -5,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });

    await t.step("fails: units missing", async () => {
      const result = await api("recharge_warp_power", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });
  },
});

// ============================================================================
// Group 9: purchase_fighters — in hyperspace
// ============================================================================

Deno.test({
  name: "megaport_services — purchase_fighters in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: in hyperspace", async () => {
      const result = await api("purchase_fighters", {
        character_id: p1Id,
        units: 10,
      });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 10: purchase_fighters — invalid units
// ============================================================================

Deno.test({
  name: "megaport_services — purchase_fighters invalid units",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await setShipFighters(p1ShipId, 100);
    });

    await t.step("fails: units = 0", async () => {
      const result = await api("purchase_fighters", {
        character_id: p1Id,
        units: 0,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("positive integer") ||
          result.body.error?.includes("units"),
      );
    });

    await t.step("fails: units negative", async () => {
      const result = await api("purchase_fighters", {
        character_id: p1Id,
        units: -5,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("positive integer") ||
          result.body.error?.includes("units"),
      );
    });

    await t.step("fails: units missing", async () => {
      const result = await api("purchase_fighters", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("required") ||
          result.body.error?.includes("units"),
      );
    });
  },
});

// ============================================================================
// Group 11: ship_purchase — invalid purchase_type
// ============================================================================

Deno.test({
  name: "megaport_services — ship_purchase invalid purchase_type",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: invalid purchase_type", async () => {
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "kestrel_courier",
        purchase_type: "lease",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("purchase_type"));
    });
  },
});

// ============================================================================
// Group 12: ship_purchase — not at mega-port
// ============================================================================

Deno.test({
  name: "megaport_services — ship_purchase not at mega-port",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, move to non-mega sector", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("fails: not at mega-port", async () => {
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "kestrel_courier",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("mega-port"));
    });
  },
});

// ============================================================================
// Group 13: ship_purchase — in hyperspace
// ============================================================================

Deno.test({
  name: "megaport_services — ship_purchase in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, put in hyperspace", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: in hyperspace", async () => {
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "kestrel_courier",
      });
      assertEquals(result.status, 409);
    });
  },
});

// ============================================================================
// Group 14: ship_purchase — actor mismatch
// ============================================================================

Deno.test({
  name: "megaport_services — ship_purchase actor mismatch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("fails: actor mismatch", async () => {
      const result = await api("ship_purchase", {
        character_id: p1Id,
        ship_type: "kestrel_courier",
        actor_character_id: p2Id,
      });
      assertEquals(result.status, 403);
    });
  },
});
