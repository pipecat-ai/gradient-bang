/**
 * Tests for combat_disband_garrison edge function.
 *
 * Covers: happy path, toll payout, corp mate disband, permission denied,
 * no garrison, and fedspace rejection.
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
  setShipSector,
  setShipFighters,
  setShipCredits,
  insertGarrisonDirect,
  setGarrisonTollBalance,
  queryGarrison,
  queryShip,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Character handles
// ---------------------------------------------------------------------------

const P1 = "test_disband_p1";
const P2 = "test_disband_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server + resolve IDs
// ============================================================================

Deno.test({
  name: "disband_garrison — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

Deno.test({
  name: "disband_garrison — resolve IDs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    [p1Id, p2Id] = await Promise.all([
      characterIdFor(P1),
      characterIdFor(P2),
    ]);
    [p1ShipId, p2ShipId] = await Promise.all([
      shipIdFor(P1),
      shipIdFor(P2),
    ]);
  },
});

// ============================================================================
// Group 1: Disband own garrison (happy path)
// ============================================================================

Deno.test({
  name: "disband_garrison — disband own garrison",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await insertGarrisonDirect(3, p1Id, 50, "defensive");
    });

    let cursorP1: number;
    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("disband succeeds", async () => {
      const result = await apiOk("combat_disband_garrison", {
        character_id: p1Id,
        sector: 3,
      });
      assert(result.success);
    });

    await t.step("garrison deleted from DB", async () => {
      const garrison = await queryGarrison(3);
      assertEquals(garrison, null);
    });

    await t.step("ship fighters unchanged", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(Number(ship.current_fighters), 100);
    });

    await t.step("garrison.collected event emitted", async () => {
      const events = await eventsOfType(p1Id, "garrison.collected", cursorP1);
      assert(events.length >= 1, `Expected >= 1 garrison.collected, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.disbanded, true);
      assertEquals(payload.fighters_disbanded, 50);
      assertEquals(payload.garrison, null);
    });

    await t.step("sector.update event emitted", async () => {
      const events = await eventsOfType(p1Id, "sector.update", cursorP1);
      assert(events.length >= 1);
    });
  },
});

// ============================================================================
// Group 2: Disband toll garrison — payout
// ============================================================================

Deno.test({
  name: "disband_garrison — toll balance paid out",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCredits(p1ShipId, 1000);
      await insertGarrisonDirect(3, p1Id, 30, "toll", 100, 0);
      await setGarrisonTollBalance(3, 500);
    });

    await t.step("disband succeeds", async () => {
      const result = await apiOk("combat_disband_garrison", {
        character_id: p1Id,
        sector: 3,
      });
      assert(result.success);
    });

    await t.step("garrison deleted", async () => {
      const garrison = await queryGarrison(3);
      assertEquals(garrison, null);
    });

    await t.step("ship credits increased by toll balance", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(Number(ship.credits), 1500);
    });
  },
});

// ============================================================================
// Group 3: Corp mate can disband
// ============================================================================

Deno.test({
  name: "disband_garrison — corp mate can disband",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("setup — create corp, both players join", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);

      // P1 creates corp
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Disband Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>).invite_code as string;

      // P2 joins corp
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("P1 places garrison", async () => {
      await setShipSector(p1ShipId, 5);
      await insertGarrisonDirect(5, p1Id, 40, "defensive");
    });

    await t.step("P2 disbands P1's garrison", async () => {
      await setShipSector(p2ShipId, 5);
      const result = await apiOk("combat_disband_garrison", {
        character_id: p2Id,
        sector: 5,
      });
      assert(result.success);
    });

    await t.step("garrison deleted", async () => {
      const garrison = await queryGarrison(5);
      assertEquals(garrison, null);
    });
  },
});

// ============================================================================
// Group 4: Non-owner / different corp — blocked
// ============================================================================

Deno.test({
  name: "disband_garrison — non-owner blocked",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await insertGarrisonDirect(3, p1Id, 30, "defensive");
    });

    await t.step("P2 cannot disband P1's garrison", async () => {
      const result = await api("combat_disband_garrison", {
        character_id: p2Id,
        sector: 3,
      });
      assert(!result.ok || result.status >= 400, "Expected disband to fail");
      assert(result.status !== 500, "Should not be a server error");
    });

    await t.step("garrison still exists", async () => {
      const garrison = await queryGarrison(3);
      assertExists(garrison);
      assertEquals(Number(garrison.fighters), 30);
    });
  },
});

// ============================================================================
// Group 5: No garrison in sector
// ============================================================================

Deno.test({
  name: "disband_garrison — no garrison fails",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
    });

    await t.step("disband on empty sector fails", async () => {
      const result = await api("combat_disband_garrison", {
        character_id: p1Id,
        sector: 3,
      });
      assert(!result.ok || result.status >= 400, "Expected failure");
      assert(result.status !== 500, "Should not be a server error");
    });
  },
});

// ============================================================================
// Group 6: Fedspace rejection
// ============================================================================

Deno.test({
  name: "disband_garrison — fedspace blocked",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Sector 1 is always fedspace in the test universe
      await setShipSector(p1ShipId, 1);
    });

    await t.step("disband in fedspace fails", async () => {
      const result = await api("combat_disband_garrison", {
        character_id: p1Id,
        sector: 1,
      });
      assert(!result.ok || result.status >= 400, "Expected failure");
      assert(result.status !== 500, "Should not be a server error");
    });
  },
});
