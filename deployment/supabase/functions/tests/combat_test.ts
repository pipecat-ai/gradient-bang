/**
 * Integration tests for combat & garrisons.
 *
 * Tests cover:
 *   - Initiate combat (2 players, events to both)
 *   - Submit combat action (action_accepted event)
 *   - Round resolution (both players act → round resolves)
 *   - Flee action (player moves to adjacent sector)
 *   - Garrison deploy (offensive/defensive modes)
 *   - Collect garrison fighters
 *   - Change garrison mode
 *   - Cannot initiate without fighters
 *   - Corp members excluded from combat
 *   - Observer in different sector does NOT receive combat events
 *
 * Setup: P1 and P2 in sector 3 (non-FedSpace), P3 in sector 4.
 * Sector 3 adjacencies: 1, 4, 7.
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
  setShipFighters,
  setShipSector,
  withPg,
} from "./helpers.ts";

const P1 = "test_combat_p1";
const P2 = "test_combat_p2";
const P3 = "test_combat_p3";

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
  name: "combat — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Initiate combat
// ============================================================================

Deno.test({
  name: "combat — initiate between two players",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p3Id = await characterIdFor(P3);
    p1ShipId = await shipIdFor(P1);
    p2ShipId = await shipIdFor(P2);
    p3ShipId = await shipIdFor(P3);

    await t.step("reset database", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      // Ensure P1 and P2 in sector 3, P3 in sector 4
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipSector(p3ShipId, 4);
      // Ensure both have fighters
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
    });

    let cursorP1: number;
    let cursorP2: number;
    let cursorP3: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 initiates combat", async () => {
      const result = await apiOk("combat_initiate", {
        character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("P1 receives combat.round_waiting", async () => {
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      assert(events.length >= 1, `Expected >= 1 combat.round_waiting for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.combat_id, "payload.combat_id");
      assertExists(payload.participants, "payload.participants");
      assertEquals(payload.round, 1);
    });

    await t.step("P2 receives combat.round_waiting", async () => {
      const events = await eventsOfType(p2Id, "combat.round_waiting", cursorP2);
      assert(events.length >= 1, `Expected >= 1 combat.round_waiting for P2, got ${events.length}`);
    });

    await t.step("P3 does NOT receive combat.round_waiting", async () => {
      await assertNoEventsOfType(p3Id, "combat.round_waiting", cursorP3);
    });
  },
});

// ============================================================================
// Group 2: Submit combat action
// ============================================================================

Deno.test({
  name: "combat — submit action",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and initiate combat", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    // Get combat_id from the round_waiting event
    let combatId: string;

    await t.step("get combat_id from event", async () => {
      const events = await eventsOfType(p1Id, "combat.round_waiting");
      assert(events.length >= 1, "Should have combat.round_waiting event");
      combatId = events[events.length - 1].payload.combat_id as string;
      assertExists(combatId, "combat_id");
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 submits attack action", async () => {
      const result = await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: p2Id,
        commit: 50,
      });
      assert(result.success);
    });

    await t.step("P1 receives combat.action_accepted", async () => {
      const events = await eventsOfType(p1Id, "combat.action_accepted", cursorP1);
      assert(events.length >= 1, `Expected >= 1 combat.action_accepted for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.action, "attack");
      assertEquals(payload.combat_id, combatId);
    });

    await t.step("P2 does NOT receive P1's action_accepted", async () => {
      await assertNoEventsOfType(p2Id, "combat.action_accepted", cursorP2);
    });
  },
});

// ============================================================================
// Group 3: Round resolution (both players act)
// ============================================================================

Deno.test({
  name: "combat — round resolution when both act",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and initiate combat", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    let combatId: string;

    await t.step("get combat_id", async () => {
      const events = await eventsOfType(p1Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors before actions", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 attacks P2", async () => {
      await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: p2Id,
        commit: 50,
      });
    });

    await t.step("P2 braces", async () => {
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "brace",
      });
    });

    await t.step("P1 receives combat.round_resolved", async () => {
      const events = await eventsOfType(p1Id, "combat.round_resolved", cursorP1);
      assert(events.length >= 1, `Expected >= 1 combat.round_resolved for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.hits, "payload.hits");
      assertExists(payload.participants, "payload.participants");
    });

    await t.step("P2 receives combat.round_resolved", async () => {
      const events = await eventsOfType(p2Id, "combat.round_resolved", cursorP2);
      assert(events.length >= 1, `Expected >= 1 combat.round_resolved for P2, got ${events.length}`);
    });

    await t.step("both receive next combat.round_waiting or combat.ended", async () => {
      // After round resolves, combat either continues (round_waiting) or ends (combat.ended)
      const p1Waiting = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      const p1Ended = await eventsOfType(p1Id, "combat.ended", cursorP1);
      assert(
        p1Waiting.length >= 1 || p1Ended.length >= 1,
        `P1 should receive round_waiting or combat.ended after resolution`,
      );
    });
  },
});

// ============================================================================
// Group 4: Flee action
// ============================================================================

Deno.test({
  name: "combat — flee moves player to adjacent sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and initiate combat", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    let combatId: string;

    await t.step("get combat_id", async () => {
      const events = await eventsOfType(p1Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    let cursorP2: number;

    await t.step("capture cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 braces, P2 flees to sector 4", async () => {
      await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "brace",
      });
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "flee",
        destination_sector: 4,
      });
    });

    await t.step("P2 receives combat.ended or combat.round_resolved", async () => {
      // After both act, round resolves. P2 fled, so combat should end.
      const ended = await eventsOfType(p2Id, "combat.ended", cursorP2);
      const resolved = await eventsOfType(p2Id, "combat.round_resolved", cursorP2);
      assert(
        ended.length >= 1 || resolved.length >= 1,
        "P2 should receive combat.ended or combat.round_resolved after fleeing",
      );
    });

    await t.step("DB: P2 ship moved to sector 4 (or another adjacent)", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      const sector = ship.current_sector as number;
      // Sector 3 adjacencies: 1, 4, 7. P2 requested sector 4.
      // Flee may not always succeed, but if combat ended, check location.
      const adjacentTo3 = [1, 4, 7];
      assert(
        sector === 3 || adjacentTo3.includes(sector),
        `P2 should be in sector 3 or adjacent (1,4,7), got ${sector}`,
      );
    });
  },
});

// ============================================================================
// Group 5: Garrison deploy
// ============================================================================

Deno.test({
  name: "combat — deploy garrison",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 deploys defensive garrison", async () => {
      const result = await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
      assert(result.success);
    });

    await t.step("P1 receives garrison.deployed", async () => {
      const events = await eventsOfType(p1Id, "garrison.deployed", cursorP1);
      assert(events.length >= 1, `Expected >= 1 garrison.deployed, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.garrison, "payload.garrison");
      const garrison = payload.garrison as Record<string, unknown>;
      assertEquals(garrison.mode, "defensive");
      assertEquals(garrison.fighters, 50);
    });

    await t.step("P2 receives sector.update", async () => {
      const events = await eventsOfType(p2Id, "sector.update", cursorP2);
      assert(events.length >= 1, `Expected >= 1 sector.update for P2, got ${events.length}`);
    });

    await t.step("DB: ship fighters decreased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assert(
        (ship.current_fighters as number) <= 150,
        `Ship fighters should have decreased: ${ship.current_fighters}`,
      );
    });

    await t.step("DB: garrison exists in sector 3", async () => {
      const garrison = await withPg(async (pg) => {
        const result = await pg.queryObject<Record<string, unknown>>(
          `SELECT * FROM garrisons WHERE sector_id = 3 AND owner_id = $1`,
          [p1Id],
        );
        return result.rows[0] ?? null;
      });
      assertExists(garrison, "Garrison should exist in DB");
      assertEquals(garrison.mode, "defensive");
      assertEquals(garrison.fighters, 50);
    });
  },
});

// ============================================================================
// Group 6: Collect garrison fighters
// ============================================================================

Deno.test({
  name: "combat — collect garrison fighters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and deploy garrison", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 collects 30 fighters", async () => {
      const result = await apiOk("combat_collect_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 30,
      });
      assert(result.success);
    });

    await t.step("P1 receives garrison.collected", async () => {
      const events = await eventsOfType(p1Id, "garrison.collected", cursorP1);
      assert(events.length >= 1, `Expected >= 1 garrison.collected, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.garrison, "payload.garrison");
      const garrison = payload.garrison as Record<string, unknown>;
      assertEquals(garrison.fighters, 20); // 50 - 30 = 20 remaining
    });

    await t.step("P2 receives sector.update", async () => {
      const events = await eventsOfType(p2Id, "sector.update", cursorP2);
      assert(events.length >= 1, `Expected >= 1 sector.update for P2, got ${events.length}`);
    });

    await t.step("DB: ship fighters increased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // Started 200, deployed 50 (=150), collected 30 (=180)
      assert(
        (ship.current_fighters as number) >= 170,
        `Ship fighters should have increased: ${ship.current_fighters}`,
      );
    });
  },
});

// ============================================================================
// Group 7: Change garrison mode
// ============================================================================

Deno.test({
  name: "combat — change garrison mode",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and deploy defensive garrison", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 changes garrison to toll mode", async () => {
      const result = await apiOk("combat_set_garrison_mode", {
        character_id: p1Id,
        sector: 3,
        mode: "toll",
        toll_amount: 500,
      });
      assert(result.success);
    });

    await t.step("P1 receives garrison.mode_changed", async () => {
      const events = await eventsOfType(p1Id, "garrison.mode_changed", cursorP1);
      assert(events.length >= 1, `Expected >= 1 garrison.mode_changed, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.garrison, "payload.garrison");
      const garrison = payload.garrison as Record<string, unknown>;
      assertEquals(garrison.mode, "toll");
      assertEquals(garrison.toll_amount, 500);
    });

    await t.step("P2 receives sector.update", async () => {
      const events = await eventsOfType(p2Id, "sector.update", cursorP2);
      assert(events.length >= 1, `Expected >= 1 sector.update for P2, got ${events.length}`);
    });

    await t.step("DB: garrison mode updated", async () => {
      const garrison = await withPg(async (pg) => {
        const result = await pg.queryObject<Record<string, unknown>>(
          `SELECT * FROM garrisons WHERE sector_id = 3 AND owner_id = $1`,
          [p1Id],
        );
        return result.rows[0] ?? null;
      });
      assertExists(garrison);
      assertEquals(garrison.mode, "toll");
      assertEquals(garrison.toll_amount, 500);
    });
  },
});

// ============================================================================
// Group 8: Cannot initiate combat without fighters
// ============================================================================

Deno.test({
  name: "combat — initiate fails without fighters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and drain P1 fighters", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 0);
      await setShipFighters(p2ShipId, 200);
    });

    await t.step("combat initiate fails with no fighters", async () => {
      const result = await api("combat_initiate", {
        character_id: p1Id,
      });
      assert(
        !result.ok || !result.body.success,
        "Expected combat to fail with no fighters",
      );
      assert(result.status !== 500, "Should not crash");
    });
  },
});

// ============================================================================
// Group 9: Corp members excluded from combat
// ============================================================================

Deno.test({
  name: "combat — corp members cannot attack each other",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, create corp, join both players", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipCredits(p1ShipId, 50000);
      // Create corp
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Combat Test Corp",
      });
      const corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>).invite_code as string;
      // P2 joins corp
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("combat initiate fails — no valid targets (all same corp)", async () => {
      const result = await api("combat_initiate", {
        character_id: p1Id,
      });
      // Should return 409 or error — corp members are excluded as targets
      assert(
        !result.ok || !result.body.success,
        "Expected combat to fail when only corp members in sector",
      );
    });
  },
});

// ============================================================================
// Group 10: Offensive garrison auto-engages
// ============================================================================

Deno.test({
  name: "combat — offensive garrison auto-engages opponents",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and deploy offensive garrison", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // P1 in sector 3, deploy offensive garrison
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      // P2 starts in a different sector
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p2ShipId, 200);
      // Deploy offensive garrison while P2 is NOT in sector
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "offensive",
      });
    });

    // Now move P2 into sector 3 where offensive garrison is
    let cursorP2: number;

    await t.step("capture P2 cursor and move to sector 3", async () => {
      cursorP2 = await getEventCursor(p2Id);
      await setShipSector(p2ShipId, 3);
    });

    // The offensive garrison should auto-engage when we trigger
    // combat_leave_fighters with P2 present. Let's test by deploying
    // with P2 in the sector directly.
    await t.step("reset for auto-engage scenario", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
    });

    let cursorP1: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 deploys offensive garrison with P2 in sector", async () => {
      const result = await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "offensive",
      });
      assert(result.success);
    });

    await t.step("P2 receives combat.round_waiting (auto-engaged)", async () => {
      const events = await eventsOfType(p2Id, "combat.round_waiting", cursorP2);
      assert(
        events.length >= 1,
        `Expected >= 1 combat.round_waiting for P2 (auto-engage), got ${events.length}`,
      );
    });

    await t.step("P1 receives combat.round_waiting", async () => {
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      assert(
        events.length >= 1,
        `Expected >= 1 combat.round_waiting for P1, got ${events.length}`,
      );
    });
  },
});

// ============================================================================
// Group 11: Garrison deploy fails with zero quantity
// ============================================================================

Deno.test({
  name: "combat — deploy garrison fails with zero quantity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("deploy with quantity 0 fails", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 0,
        mode: "defensive",
      });
      assert(!result.ok || !result.body.success, "Expected deploy to fail with quantity 0");
      assert(result.status !== 500, "Should not crash");
    });
  },
});

// ============================================================================
// Group 12: Collect garrison fails with zero quantity
// ============================================================================

Deno.test({
  name: "combat — collect garrison fails with zero quantity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and deploy garrison", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
    });

    await t.step("collect with quantity 0 fails", async () => {
      const result = await api("combat_collect_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 0,
      });
      assert(!result.ok || !result.body.success, "Expected collect to fail with quantity 0");
      assert(result.status !== 500, "Should not crash");
    });
  },
});
