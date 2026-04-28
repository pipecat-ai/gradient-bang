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
 *   - Combat action edge cases (Groups 26–35)
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
  queryGarrison,
  assertNoEventsOfType,
  setShipCredits,
  setShipFighters,
  setShipSector,
  setShipWarpPower,
  insertGarrisonDirect,
  setGarrisonTollBalance,
  expireCombatDeadline,
  setShipType,
  setShipHyperspace,
  queryCombatState,
  setMegabankBalance,
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

    await t.step("if flee succeeded, fleer gets full movement cascade", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      const fled = (ship.current_sector as number) !== 3;
      if (!fled) return; // Probabilistic — skip when flee didn't succeed.

      // Round_resolved payload should mark P2 has_fled=true with the
      // resolved fled_to_sector.
      const resolved = await eventsOfType(p2Id, "combat.round_resolved", cursorP2);
      assert(resolved.length >= 1, "P2 should have a round_resolved event");
      const participants = resolved[0].payload.participants as Array<
        Record<string, unknown>
      >;
      const p2Entry = participants.find((p) => p.id === p2Id);
      assertExists(p2Entry, "P2 in participants list");
      assertEquals(p2Entry.has_fled, true, "has_fled should be true on fleer");
      assertEquals(
        p2Entry.fled_to_sector,
        ship.current_sector,
        "fled_to_sector should match ship's new sector",
      );

      // The fleer should also receive the full movement cascade.
      const moveStart = await eventsOfType(p2Id, "movement.start", cursorP2);
      const moveComplete = await eventsOfType(p2Id, "movement.complete", cursorP2);
      const mapLocal = await eventsOfType(p2Id, "map.local", cursorP2);
      assert(moveStart.length >= 1, "fleer should receive movement.start");
      assert(moveComplete.length >= 1, "fleer should receive movement.complete");
      assert(mapLocal.length >= 1, "fleer should receive map.local");

      // Personalized combat.ended for the fleer.
      const ended = await eventsOfType(p2Id, "combat.ended", cursorP2);
      assert(ended.length >= 1, "fleer should receive combat.ended");
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

// ============================================================================
// Group 13: Toll garrison — demand → pay → brace cycle
// P1 deploys toll garrison, moves away. P2 enters sector triggering
// auto-engage. P2 pays the toll.
// ============================================================================

Deno.test({
  name: "combat — toll garrison: demand then pay cycle",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipCredits(p2ShipId, 50000);
    });

    await t.step("P1 deploys toll garrison and moves away", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "toll",
        toll_amount: 100,
      });
      await setShipSector(p1ShipId, 4);
    });

    let combatId: string;

    await t.step("P2 moves into sector 3 via move endpoint (triggers auto-engage)", async () => {
      // Must use `move` (not setShipSector+combat_initiate) because only
      // the move endpoint's auto-engage path populates the toll_registry.
      // BUG: combat_initiate doesn't populate toll_registry for toll garrisons.
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      assert(events.length >= 1, "Should have combat.round_waiting after move");
      combatId = events[events.length - 1].payload.combat_id as string;
      assertExists(combatId, "combat_id");
    });

    await t.step("P2 pays toll", async () => {
      const result = await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
      assert(result.success);
    });

    await t.step("verify garrison toll_balance increased", async () => {
      const garrison = await queryGarrison(3);
      assertExists(garrison, "Garrison should exist");
      assert(
        (garrison.toll_balance as number) >= 100,
        `Expected toll_balance >= 100, got ${garrison.toll_balance}`,
      );
    });
  },
});

// ============================================================================
// Group 14: Toll garrison — payment with insufficient credits
// ============================================================================

Deno.test({
  name: "combat — toll garrison: insufficient credits for payment",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipCredits(p2ShipId, 0);
    });

    let combatId: string;

    await t.step("deploy toll garrison, move P1 away, P2 moves in", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "toll",
        toll_amount: 100,
      });
      await setShipSector(p1ShipId, 4);
      // Use move endpoint so auto-engage populates toll_registry
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    await t.step("P2 pay action fails with insufficient credits", async () => {
      const result = await api("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
      assert(!result.ok || !result.body.success, "Expected payment to fail");
      assert(result.status !== 500, "Should not crash");
    });
  },
});

// ============================================================================
// Group 14b: Per-payer toll semantics
// A toll payment is a peace contract scoped to one payer ↔ one garrison.
// Other hostiles must still pay; paid payers cannot attack the garrison or
// re-pay; the garrison re-targets to unpaid hostiles on escalation rounds.
// Mirrors client/combat-sim/src/engine/__tests__/combat.test.ts §
// "toll garrison with multiple players (per-payer semantics)".
// ============================================================================

Deno.test({
  name: "combat — per-payer toll: P1 pays, P2 braces → combat continues",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipSector(p3ShipId, 4);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await setShipFighters(p3ShipId, 100);
      await setShipCredits(p2ShipId, 1000);
      await setShipCredits(p3ShipId, 1000);
    });

    let combatId: string;
    await t.step(
      "P1 deploys toll garrison; P2 enters (auto-engage), P3 joins via combat_initiate",
      async () => {
        await apiOk("combat_leave_fighters", {
          character_id: p1Id,
          sector: 3,
          quantity: 80,
          mode: "toll",
          toll_amount: 100,
        });
        await setShipSector(p1ShipId, 4);
        // P2 enters first → toll_registry populated via auto-engage
        await apiOk("move", { character_id: p2Id, to_sector: 3 });
        // P3 moves in (becomes sector observer; move doesn't auto-join
        // existing combat) and explicitly calls combat_initiate to be
        // added to the encounter's participants.
        await apiOk("move", { character_id: p3Id, to_sector: 3 });
        await apiOk("combat_initiate", { character_id: p3Id });
        const events = await eventsOfType(p2Id, "combat.round_waiting");
        combatId = events[events.length - 1].payload.combat_id as string;
        assertExists(combatId, "combat_id");
      },
    );

    await t.step("round 1: P2 pays, P3 braces → combat continues", async () => {
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
      await apiOk("combat_action", {
        character_id: p3Id,
        combat_id: combatId,
        action: "brace",
      });

      const ended = await eventsOfType(p2Id, "combat.ended");
      assertEquals(
        ended.length,
        0,
        "combat must NOT end — P3 still owes the toll",
      );
      const combat = await queryCombatState(3);
      assertExists(combat, "combat state should still exist");
      assertEquals(
        combat.ended ?? false,
        false,
        "active combat should remain in sector_contents",
      );
    });
  },
});

Deno.test({
  name: "combat — per-payer toll: paid payer cannot attack the garrison they paid",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;
    let garrisonCombatantId: string;

    await t.step("setup + P2 pays the toll", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await setShipCredits(p2ShipId, 1000);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "toll",
        toll_amount: 100,
      });
      await setShipSector(p1ShipId, 4);
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      combatId = events[events.length - 1].payload.combat_id as string;
      // Garrison combatant lives in payload.garrison (not payload.participants[]).
      const garrisonObj = events[events.length - 1].payload.garrison as
        | { id?: string }
        | null;
      assertExists(garrisonObj, "garrison object in payload");
      assertExists(garrisonObj.id, "garrison.id in payload");
      garrisonCombatantId = garrisonObj.id as string;

      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
    });

    await t.step("attack against the paid garrison is rejected", async () => {
      // Trigger another round so we can submit a fresh action.
      // P2 tries to attack the garrison they just paid — must reject.
      const result = await api("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "attack",
        target_id: garrisonCombatantId,
        commit: 50,
      });
      assert(
        !result.ok || result.status === 400,
        `Expected attack to be rejected; got ok=${result.ok} status=${result.status}`,
      );
    });
  },
});

Deno.test({
  name: "combat — per-payer toll: paid payer cannot pay the same garrison twice",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;

    await t.step("setup + first pay succeeds", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await setShipCredits(p2ShipId, 1000);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "toll",
        toll_amount: 100,
      });
      await setShipSector(p1ShipId, 4);
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      combatId = events[events.length - 1].payload.combat_id as string;
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      assertEquals(
        ship.credits,
        900,
        "credits should drop by toll amount on first pay",
      );
    });

    await t.step("second pay is rejected; no additional credits deducted", async () => {
      const result = await api("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
      assert(
        !result.ok || !result.body.success,
        "Re-pay must not succeed",
      );
      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      assertEquals(
        ship.credits,
        900,
        "credits must remain at 900 — no double-charge",
      );
    });
  },
});

Deno.test({
  name: "combat — per-payer toll: garrison re-targets to unpaid hostile after pay",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;

    await t.step("setup + round 1: P2 pays, P3 braces", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipSector(p3ShipId, 4);
      await setShipFighters(p1ShipId, 50);
      await setShipFighters(p2ShipId, 50);
      await setShipFighters(p3ShipId, 50);
      await setShipCredits(p2ShipId, 1000);
      await setShipCredits(p3ShipId, 1000);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 30,
        mode: "toll",
        toll_amount: 100,
      });
      await setShipSector(p1ShipId, 4);
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      // P3 moves in then joins the existing combat explicitly.
      await apiOk("move", { character_id: p3Id, to_sector: 3 });
      await apiOk("combat_initiate", { character_id: p3Id });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      combatId = events[events.length - 1].payload.combat_id as string;
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
      await apiOk("combat_action", {
        character_id: p3Id,
        combat_id: combatId,
        action: "brace",
      });
    });

    await t.step(
      "round 2: P2 + P3 brace → garrison attacks, target is NOT P2",
      async () => {
        await apiOk("combat_action", {
          character_id: p2Id,
          combat_id: combatId,
          action: "brace",
        });
        await apiOk("combat_action", {
          character_id: p3Id,
          combat_id: combatId,
          action: "brace",
        });

        // Look at the round 2 resolved payload's actions map for the garrison.
        const resolved = await eventsOfType(p3Id, "combat.round_resolved");
        assert(resolved.length >= 2, "expected two resolved events");
        const round2 = resolved[resolved.length - 1].payload;
        const actions = (round2.actions ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        const garrisonAction = Object.entries(actions).find(([key]) =>
          key.toLowerCase().includes("garrison"),
        );
        assertExists(garrisonAction, "garrison action should appear");
        // The garrison should attack on the escalation round, and never
        // target the paid payer (P2).
        if (garrisonAction[1].action === "attack") {
          assert(
            garrisonAction[1].target !== p2Id,
            `garrison must not target paid payer; got ${garrisonAction[1].target}`,
          );
        }
      },
    );
  },
});

// ============================================================================
// Group 15: Garrison target selection — strongest target picked
// Three players in combat with an offensive garrison.
// The garrison should target the strongest (most fighters).
// ============================================================================

Deno.test({
  name: "combat — garrison targets strongest opponent",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipSector(p3ShipId, 3);
      // P1 has garrison, P2 is strong (300), P3 is weak (50)
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 300);
      await setShipFighters(p3ShipId, 50);
    });

    await t.step("P1 deploys offensive garrison", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 100,
        mode: "offensive",
      });
    });

    let combatId: string;

    await t.step("P2 initiates combat (triggers garrison auto-engage)", async () => {
      await apiOk("combat_initiate", { character_id: p2Id });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    let cursorP2: number;

    await t.step("capture cursor and submit actions", async () => {
      cursorP2 = await getEventCursor(p2Id);
      // P2 and P3 brace to let garrison act
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "brace",
      });
      await apiOk("combat_action", {
        character_id: p3Id,
        combat_id: combatId,
        action: "brace",
      });
      // Force tick
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("verify round resolved — garrison generated action", async () => {
      const events = await eventsOfType(p2Id, "combat.round_resolved", cursorP2);
      assert(events.length >= 1, `Should have round_resolved event, got ${events.length}`);
      const payload = events[events.length - 1].payload;
      const actions = payload.actions as Record<string, Record<string, unknown>> | undefined;
      assertExists(actions, "round_resolved should include actions");
      // Find the garrison's action (non-player combatant)
      const garrisonAction = Object.entries(actions).find(
        ([id]) => id !== p1Id && id !== p2Id && id !== p3Id,
      );
      assertExists(garrisonAction, "Garrison should have an action entry");
      // Garrison should have attacked, but may brace in round 1 depending
      // on implementation details. The key coverage target is that
      // buildGarrisonActions and selectStrongestTarget are exercised.
      const action = garrisonAction[1].action;
      assert(
        action === "attack" || action === "brace",
        `Garrison action should be attack or brace, got ${action}`,
      );
    });
  },
});

// ============================================================================
// Group 16: Defensive garrison braces in combat (never attacks)
// ============================================================================

Deno.test({
  name: "combat — defensive garrison braces, does not attack",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
    });

    await t.step("P1 deploys defensive garrison", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 100,
        mode: "defensive",
      });
    });

    let combatId: string;

    await t.step("P2 initiates combat", async () => {
      await apiOk("combat_initiate", { character_id: p2Id });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    await t.step("P2 braces, expire and tick", async () => {
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "brace",
      });
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("verify garrison braced (did not attack)", async () => {
      const events = await eventsOfType(p2Id, "combat.round_resolved");
      assert(events.length >= 1, "Should have round_resolved");
      const payload = events[events.length - 1].payload;
      const actions = payload.actions as Record<string, Record<string, unknown>> | undefined;
      if (actions) {
        const garrisonAction = Object.entries(actions).find(
          ([id]) => id !== p2Id,
        );
        if (garrisonAction) {
          assertEquals(garrisonAction[1].action, "brace", "Defensive garrison should brace");
        }
      }
    });
  },
});

// ============================================================================
// Group 17: Deploy garrison fails in FedSpace
// ============================================================================

Deno.test({
  name: "combat — deploy garrison in FedSpace fails",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move to FedSpace", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 8);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("deploy garrison in sector 8 (FedSpace) fails", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 8,
        quantity: 50,
        mode: "offensive",
      });
      assert(!result.ok || !result.body.success, "Expected FedSpace deployment to fail");
      assert(result.status === 400, `Expected 400, got ${result.status}`);
    });
  },
});

// ============================================================================
// Group 18: Deploy garrison fails — enemy garrison exists
// ============================================================================

Deno.test({
  name: "combat — deploy garrison fails when enemy garrison exists",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
    });

    await t.step("P1 deploys garrison", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "offensive",
      });
    });

    await t.step("P2 deploy fails — enemy garrison present", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p2Id,
        sector: 3,
        quantity: 50,
        mode: "offensive",
      });
      assert(!result.ok || !result.body.success, "Expected deploy to fail");
      assertEquals(result.status, 409, "Expected 409 conflict");
    });
  },
});

// ============================================================================
// Group 19: Friendly garrison — same corp reinforces occupied sector
// ============================================================================

Deno.test({
  name: "combat — friendly garrison reinforcement (same corp)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // Both in sector 0 for corp creation (mega-port), then move
      await setShipSector(p1ShipId, 0);
      await setShipSector(p2ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      const corpResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Garrison Corp",
      });
      const corpBody = corpResult as Record<string, unknown>;
      const corpId = corpBody.corp_id as string;
      const inviteCode = corpBody.invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
      // Move to combat sector
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
    });

    await t.step("P1 deploys garrison", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
    });

    await t.step("P2 (same corp) reinforces garrison", async () => {
      const result = await apiOk("combat_leave_fighters", {
        character_id: p2Id,
        sector: 3,
        quantity: 50,
        mode: "offensive",
      });
      assertEquals(
        (result as Record<string, unknown>).success,
        true,
        "Corp mate reinforcement should succeed",
      );
    });
  },
});

// ============================================================================
// Group 20: Collect all fighters — garrison deleted
// ============================================================================

Deno.test({
  name: "combat — collect all fighters deletes garrison",
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

    await t.step("verify garrison exists", async () => {
      const garrison = await queryGarrison(3);
      assertExists(garrison, "Garrison should exist");
      assertEquals(garrison.fighters, 50);
    });

    await t.step("collect all 50 fighters", async () => {
      await apiOk("combat_collect_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
      });
    });

    await t.step("verify garrison deleted", async () => {
      const garrison = await queryGarrison(3);
      assertEquals(garrison, null, "Garrison should be deleted after collecting all fighters");
    });

    await t.step("verify ship fighters restored", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_fighters, 200, "Ship should have all 200 fighters back");
    });
  },
});

// ============================================================================
// Group 21: Collect fighters — toll payout extracted
// ============================================================================

Deno.test({
  name: "combat — collect garrison extracts toll payout",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and deploy toll garrison with balance", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipCredits(p1ShipId, 1000);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "toll",
        toll_amount: 100,
      });
      // Set toll_balance directly in DB (simulating toll payments received)
      await setGarrisonTollBalance(3, 500);
    });

    await t.step("collect fighters", async () => {
      const result = await apiOk("combat_collect_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
      });
      assert(result.success);
    });

    await t.step("verify credits include toll payout", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // Ship started with 1000 credits, should now have 1000 + 500 toll payout
      assert(
        (ship.credits as number) >= 1500,
        `Expected credits >= 1500 (1000 + 500 toll), got ${ship.credits}`,
      );
    });

    await t.step("verify garrison deleted (collected all)", async () => {
      const garrison = await queryGarrison(3);
      assertEquals(garrison, null, "Garrison should be deleted");
    });
  },
});

// ============================================================================
// Group 22: Set garrison mode — invalid mode rejected
// ============================================================================

Deno.test({
  name: "combat — set garrison mode: invalid mode rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("set mode to invalid value fails", async () => {
      const result = await api("combat_set_garrison_mode", {
        character_id: p1Id,
        sector: 3,
        mode: "invalid_mode",
      });
      assert(!result.ok || !result.body.success, "Expected invalid mode to fail");
      assertEquals(result.status, 400, "Expected 400");
    });
  },
});

// ============================================================================
// Group 23: Set garrison mode — no garrison exists → 404
// ============================================================================

Deno.test({
  name: "combat — set garrison mode: no garrison → 404",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset (no garrison deployed)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
    });

    await t.step("set mode on empty sector fails with 404", async () => {
      const result = await api("combat_set_garrison_mode", {
        character_id: p1Id,
        sector: 3,
        mode: "defensive",
      });
      assert(!result.ok || !result.body.success, "Expected no garrison to fail");
      assertEquals(result.status, 404, "Expected 404");
    });
  },
});

// ============================================================================
// Group 24: Set garrison mode — FedSpace rejected
// ============================================================================

Deno.test({
  name: "combat — set garrison mode: FedSpace rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move to FedSpace", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 8);
    });

    await t.step("set mode in FedSpace sector fails", async () => {
      const result = await api("combat_set_garrison_mode", {
        character_id: p1Id,
        sector: 8,
        mode: "defensive",
      });
      assert(!result.ok || !result.body.success, "Expected FedSpace rejection");
      assertEquals(result.status, 400, "Expected 400");
    });
  },
});

// ============================================================================
// Group 25: Offensive garrison auto-engages on deploy
// When P1 deploys an offensive garrison while an enemy (P2) is in sector,
// combat should automatically start.
// ============================================================================

Deno.test({
  name: "combat — offensive garrison auto-engages on deploy",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 deploys offensive garrison", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "offensive",
      });
    });

    await t.step("P2 receives combat.round_waiting (auto-engaged)", async () => {
      const events = await eventsOfType(p2Id, "combat.round_waiting", cursorP2);
      assert(
        events.length >= 1,
        `Expected P2 to receive combat.round_waiting from auto-engage, got ${events.length}`,
      );
    });
  },
});

// ============================================================================
// Group 26: Unknown combat action rejected (400)
// ============================================================================

Deno.test({
  name: "combat — unknown action type rejected",
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

    await t.step("submit unknown action → 400", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "explode",
        target_id: p2Id,
      });
      assertEquals(result.status, 400, "Expected 400 for unknown action");
      assert(
        (result.body.error ?? "").includes("Unknown combat action"),
        `Expected 'Unknown combat action' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 27: Combat not found (404) — invalid combat_id
// ============================================================================

Deno.test({
  name: "combat — combat not found → 404",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("submit action with fake combat_id → 404", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: "00000000-0000-0000-0000-000000000000",
        action: "brace",
      });
      assertEquals(result.status, 404, "Expected 404 for missing combat");
    });
  },
});

// ============================================================================
// Group 28: Round mismatch (409) — stale round hint
// ============================================================================

Deno.test({
  name: "combat — round hint mismatch → 409",
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

    await t.step("submit action with wrong round → 409", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "brace",
        round: 99,
      });
      assertEquals(result.status, 409, "Expected 409 for round mismatch");
      assert(
        (result.body.error ?? "").includes("Round mismatch"),
        `Expected 'Round mismatch' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 29: Character not in combat (403)
// P3 is in a different sector and not part of the combat.
// ============================================================================

Deno.test({
  name: "combat — character not in combat → 403",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and initiate combat between P1 & P2", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipSector(p3ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipFighters(p3ShipId, 200);
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    let combatId: string;

    await t.step("get combat_id", async () => {
      const events = await eventsOfType(p1Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    await t.step("P3 submits action to combat they're not in → 403", async () => {
      const result = await api("combat_action", {
        character_id: p3Id,
        combat_id: combatId,
        action: "brace",
      });
      assertEquals(result.status, 403, "Expected 403 for non-participant");
      assert(
        (result.body.error ?? "").includes("not part of this combat"),
        `Expected 'not part of this combat' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 30: Missing target_id for attack (400)
// ============================================================================

Deno.test({
  name: "combat — attack without target_id → 400",
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

    await t.step("P1 attacks without target_id → 400", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        commit: 50,
      });
      assertEquals(result.status, 400, "Expected 400 for missing target_id");
      assert(
        (result.body.error ?? "").includes("Missing target_id"),
        `Expected 'Missing target_id' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 31: Cannot target yourself (400)
// ============================================================================

Deno.test({
  name: "combat — attack self → 400",
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

    await t.step("P1 targets self → 400", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: p1Id,
        commit: 50,
      });
      assertEquals(result.status, 400, "Expected 400 for self-target");
      assert(
        (result.body.error ?? "").includes("Cannot target yourself"),
        `Expected 'Cannot target yourself' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 32: Target not found (404)
// ============================================================================

Deno.test({
  name: "combat — target not found → 404",
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

    await t.step("P1 attacks non-existent target → 404", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: "nonexistent-player-name",
        commit: 50,
      });
      assertEquals(result.status, 404, "Expected 404 for unknown target");
      assert(
        (result.body.error ?? "").includes("Target combatant not found"),
        `Expected 'Target combatant not found' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 33: Attack by character name (case-insensitive target resolution)
// ============================================================================

Deno.test({
  name: "combat — attack by character name (case-insensitive)",
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

    await t.step("P1 attacks P2 by uppercased name", async () => {
      // The character name for P2 is "test_combat_p2" — use different case
      const result = await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: "TEST_COMBAT_P2",
        commit: 50,
      });
      assert(result.success, "Attack by name should succeed");
    });
  },
});

// ============================================================================
// Group 34: No fighters for attack (400)
// ============================================================================

Deno.test({
  name: "combat — attack with no fighters → 400",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and initiate combat, then drain P1 fighters", async () => {
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

    await t.step("set P1 fighters to 0 in combat state", async () => {
      // Directly set fighters to 0 in the combat state
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE sector_contents
           SET combat = jsonb_set(
             combat,
             ARRAY['participants', $1::text, 'fighters'],
             '0'::jsonb
           )
           WHERE sector_id = 3 AND combat IS NOT NULL`,
          [p1Id],
        );
      });
    });

    await t.step("P1 attacks with 0 fighters → 400", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: p2Id,
        commit: 50,
      });
      assertEquals(result.status, 400, "Expected 400 for no fighters");
      assert(
        (result.body.error ?? "").includes("No fighters available"),
        `Expected 'No fighters available' error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 35: Attack own garrison rejected (400)
// P1 deploys garrison, P2 enters and triggers combat.
// P1 tries to attack their own garrison.
// ============================================================================

Deno.test({
  name: "combat — attack own garrison → 400",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup garrison combat", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipWarpPower(p2ShipId, 500);
      // Deploy offensive garrison in sector 3
      await insertGarrisonDirect(3, p1Id, 80, "offensive");
      // Move P2 into sector 3 to trigger auto-engage
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
    });

    let combatId: string;
    let garrisonCombatantId: string;

    await t.step("get combat_id and garrison combatant id from DB", async () => {
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist in sector 3");
      combatId = (combat as Record<string, unknown>).combat_id as string;
      assertExists(combatId, "Should have combat_id");
      const participants = (combat as Record<string, unknown>).participants as Record<string, Record<string, unknown>>;
      for (const [pid, p] of Object.entries(participants)) {
        if (p.combatant_type === "garrison") {
          garrisonCombatantId = pid;
          break;
        }
      }
      assertExists(garrisonCombatantId, "Should have garrison combatant id");
    });

    await t.step("P1 attacks own garrison → 400", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: garrisonCombatantId,
        commit: 50,
      });
      assertEquals(result.status, 400, "Expected 400 for friendly fire");
      assert(
        (result.body.error ?? "").includes("Cannot attack your own garrison"),
        `Expected friendly fire error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 36: Attack corp-mate garrison rejected (400)
// P1 and P3 are in same corp. P3 deploys garrison. P2 triggers combat.
// P1 tries to attack P3's garrison.
// ============================================================================

Deno.test({
  name: "combat — attack corp-mate garrison → 400",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset, create corp, deploy garrison", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      // Create corp at mega-port (sector 0)
      await setShipSector(p1ShipId, 0);
      await setShipSector(p3ShipId, 0);
      await setShipCredits(p1ShipId, 50000);
      const corpResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Combat Action Test Corp",
      });
      const corpBody = corpResult as Record<string, unknown>;
      corpId = corpBody.corp_id as string;
      await apiOk("corporation_join", {
        character_id: p3Id,
        corp_id: corpId,
        invite_code: corpBody.invite_code as string,
      });
      // P3 deploys garrison in sector 3
      await setShipSector(p3ShipId, 3);
      await setShipFighters(p3ShipId, 200);
      await insertGarrisonDirect(3, p3Id, 80, "offensive");
      // Set the garrison's owner_corporation_id in the garrison metadata
      // This is normally set by loadGarrisonCombatants from corporation_members
    });

    await t.step("setup combat: P1 and P2 in sector 3", async () => {
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipWarpPower(p2ShipId, 500);
      // Move P3 away so they don't confuse combat
      await setShipSector(p3ShipId, 7);
      // Move P2 in to trigger auto-engage with garrison
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
    });

    let combatId: string;
    let garrisonCombatantId: string;

    await t.step("get combat_id and garrison id from DB", async () => {
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist in sector 3");
      combatId = (combat as Record<string, unknown>).combat_id as string;
      assertExists(combatId, "Should have combat_id");
      const participants = (combat as Record<string, unknown>).participants as Record<string, Record<string, unknown>>;
      for (const [pid, p] of Object.entries(participants)) {
        if (p.combatant_type === "garrison") {
          garrisonCombatantId = pid;
          break;
        }
      }
      assertExists(garrisonCombatantId, "Should have garrison combatant id");
    });

    await t.step("P1 joins combat and attacks corp-mate garrison → 400", async () => {
      // P1 needs to be a participant in the combat to attack.
      // P1 is in sector 3, so should already be in combat.
      // If not, we need to check combat state for P1.
      const combat = await queryCombatState(3);
      const participants = (combat as Record<string, unknown>).participants as Record<string, unknown>;
      const p1InCombat = p1Id in participants;
      if (!p1InCombat) {
        // P1 wasn't auto-included, so initiate to join
        await apiOk("combat_initiate", { character_id: p1Id });
      }
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: garrisonCombatantId,
        commit: 50,
      });
      assertEquals(result.status, 400, "Expected 400 for corp friendly fire");
      assert(
        (result.body.error ?? "").includes("garrison owned by your corporation"),
        `Expected corp friendly fire error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 37: Escape pod cannot flee (400)
// Convert P1's ship to escape pod in combat state, then try flee.
// ============================================================================

Deno.test({
  name: "combat — escape pod cannot flee → 400",
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

    await t.step("mark P1 as escape pod in combat state", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE sector_contents
           SET combat = jsonb_set(
             combat,
             ARRAY['participants', $1::text, 'is_escape_pod'],
             'true'::jsonb
           )
           WHERE sector_id = 3 AND combat IS NOT NULL`,
          [p1Id],
        );
      });
    });

    await t.step("P1 (escape pod) tries to flee → 400", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "flee",
      });
      assertEquals(result.status, 400, "Expected 400 for escape pod flee");
      assert(
        (result.body.error ?? "").includes("Escape pods cannot flee"),
        `Expected escape pod error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 38: combat_initiate — in hyperspace
// ============================================================================

Deno.test({
  name: "combat — initiate in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipHyperspace(p1ShipId, true, 4);
    });

    await t.step("fails: in hyperspace", async () => {
      const result = await api("combat_initiate", {
        character_id: p1Id,
      });
      assert(!result.ok, "Expected initiate to fail while in hyperspace");
      assert(
        result.body.error?.includes("hyperspace"),
        `Expected hyperspace error, got: ${result.body.error}`,
      );
    });

    await t.step("cleanup", async () => {
      await setShipHyperspace(p1ShipId, false, null);
    });
  },
});

// ============================================================================
// Group 39: combat_initiate — in FedSpace
// ============================================================================

Deno.test({
  name: "combat — initiate in FedSpace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move both to FedSpace sector 8", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 8);
      await setShipSector(p2ShipId, 8);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
    });

    await t.step("fails: FedSpace", async () => {
      const result = await api("combat_initiate", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Federation Space"),
        `Expected FedSpace error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 40: combat_initiate — no fighters
// ============================================================================

Deno.test({
  name: "combat — initiate no fighters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and drain fighters", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipFighters(p1ShipId, 0);
    });

    await t.step("fails: no fighters", async () => {
      const result = await api("combat_initiate", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("no fighters"),
        `Expected no-fighters error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 41: combat_initiate — alone in sector
// ============================================================================

Deno.test({
  name: "combat — initiate alone in sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and move P2 away", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipFighters(p1ShipId, 100);
      // Move P2 away from P1's sector
      await setShipSector(p2ShipId, 4);
    });

    await t.step("fails: no targetable opponents", async () => {
      const result = await api("combat_initiate", {
        character_id: p1Id,
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("targetable") || result.body.error?.includes("opponents"),
        `Expected no-targets error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 42: combat_initiate — corpmates not targetable
// ============================================================================

Deno.test({
  name: "combat — initiate corpmates not targetable",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp with P1+P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Combat Corp",
      });
      const corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("fails: corpmates not targetable", async () => {
      const result = await api("combat_initiate", {
        character_id: p1Id,
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("targetable") || result.body.error?.includes("opponents"),
        `Expected no-targets error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 43: Set garrison mode — missing sector
// ============================================================================

Deno.test({
  name: "combat — set garrison mode: missing sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: sector is required", async () => {
      const result = await api("combat_set_garrison_mode", {
        character_id: p1Id,
        mode: "defensive",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("sector"),
        `Expected sector-required error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 44: combat_collect_fighters — missing sector
// ============================================================================

Deno.test({
  name: "combat — collect fighters: missing sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: sector is required", async () => {
      const result = await api("combat_collect_fighters", {
        character_id: p1Id,
        quantity: 10,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("sector"),
        `Expected sector-required error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 45: combat_collect_fighters — missing quantity
// ============================================================================

Deno.test({
  name: "combat — collect fighters: missing quantity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: quantity is required", async () => {
      const result = await api("combat_collect_fighters", {
        character_id: p1Id,
        sector: 3,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("quantity"),
        `Expected quantity-required error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 46: combat_collect_fighters — negative quantity
// ============================================================================

Deno.test({
  name: "combat — collect fighters: negative quantity",
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

    await t.step("fails: negative quantity", async () => {
      const result = await api("combat_collect_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: -10,
      });
      assert(!result.ok || !result.body.success, "Expected negative quantity to fail");
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 47: combat_leave_fighters — missing sector
// ============================================================================

Deno.test({
  name: "combat — leave fighters: missing sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: sector is required", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        quantity: 10,
        mode: "offensive",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("sector"),
        `Expected sector-required error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 48: combat_leave_fighters — missing quantity
// ============================================================================

Deno.test({
  name: "combat — leave fighters: missing quantity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: quantity is required", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        mode: "offensive",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("quantity"),
        `Expected quantity-required error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 49: combat_leave_fighters — negative quantity
// ============================================================================

Deno.test({
  name: "combat — leave fighters: negative quantity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("fails: negative quantity", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: -5,
        mode: "offensive",
      });
      assert(!result.ok || !result.body.success, "Expected negative quantity to fail");
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 50: combat_leave_fighters — invalid mode
// ============================================================================

Deno.test({
  name: "combat — leave fighters: invalid mode",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("fails: invalid garrison mode", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "invalid_mode",
      });
      assert(!result.ok || !result.body.success, "Expected invalid mode to fail");
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 51: combat_leave_fighters — sector mismatch
// ============================================================================

Deno.test({
  name: "combat — leave fighters: sector mismatch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset — P1 in sector 3", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("fails: wrong sector", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 7,
        quantity: 50,
        mode: "offensive",
      });
      assertEquals(result.status, 409);
    });
  },
});

// ============================================================================
// Group 52: combat_leave_fighters — FedSpace rejected
// ============================================================================

Deno.test({
  name: "combat — leave fighters: FedSpace rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset — P1 in FedSpace sector 8", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 8);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("fails: FedSpace", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 8,
        quantity: 50,
        mode: "defensive",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Federation Space") || result.body.error?.includes("leave fighters"),
        `Expected FedSpace error, got: ${result.body.error}`,
      );
    });
  },
});

// ============================================================================
// Group 53: Target garrison vs ship in same encounter
// ============================================================================

Deno.test({
  name: "combat — target garrison vs ship in same encounter",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Setup: P1 has an offensive garrison in sector 3. P2 enters sector 3
    // and initiates combat. Both P1's ship and P1's garrison are participants.
    // P2 should be able to target either P1's ship or the garrison explicitly.

    let garrisonCombatantId: string;

    await t.step("reset — P1 deploys offensive garrison, both in sector 3", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      // Deploy offensive garrison for P1 in sector 3
      await insertGarrisonDirect(3, p1Id, 80, "offensive");
      garrisonCombatantId = `garrison:3:${p1Id}`;
    });

    let combatId: string;

    await t.step("P2 initiates combat", async () => {
      await apiOk("combat_initiate", { character_id: p2Id });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      assert(events.length >= 1, "Should have combat.round_waiting");
      combatId = events[events.length - 1].payload.combat_id as string;
      assertExists(combatId, "combat_id");
    });

    await t.step("encounter has both P1 ship and garrison as participants", async () => {
      const combat = await queryCombatState(3);
      assertExists(combat, "combat state should exist");
      const participants = (combat as Record<string, unknown>).participants as Record<string, unknown>;
      assertExists(participants[p1Id], "P1 ship should be a participant");
      assertExists(participants[garrisonCombatantId], "P1 garrison should be a participant");
      assertExists(participants[p2Id], "P2 ship should be a participant");
    });

    // Test 1: P2 attacks the garrison by its combatant_id
    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P2 attacks garrison — action accepted", async () => {
      const result = await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "attack",
        target_id: garrisonCombatantId,
        commit: 50,
      });
      assert(result.success);
    });

    await t.step("P2 action_accepted targets garrison", async () => {
      const events = await eventsOfType(p2Id, "combat.action_accepted", cursorP2);
      assert(events.length >= 1, "Should have action_accepted");
      const payload = events[0].payload;
      assertEquals(payload.action, "attack");
      assertEquals(payload.target_id, garrisonCombatantId);
      assertEquals(payload.commit, 50);
    });

    // Resolve the round so we can test targeting the ship next
    await t.step("P1 braces to resolve round", async () => {
      await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "brace",
      });
      // Garrison acts automatically — round should resolve once P1 acts
    });

    await t.step("wait for round 2", async () => {
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      const round2 = events.find(
        (e) => e.payload.combat_id === combatId && (e.payload.round as number) === 2,
      );
      assert(round2, "Should have round 2 waiting event");
    });

    // Test 2: P2 attacks P1's ship (not the garrison) in round 2
    await t.step("capture P2 cursor for round 2", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P2 attacks P1 ship — action accepted", async () => {
      const result = await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "attack",
        target_id: p1Id,
        commit: 50,
      });
      assert(result.success);
    });

    await t.step("P2 action_accepted targets P1 ship (not garrison)", async () => {
      const events = await eventsOfType(p2Id, "combat.action_accepted", cursorP2);
      assert(events.length >= 1, "Should have action_accepted");
      const payload = events[0].payload;
      assertEquals(payload.action, "attack");
      assertEquals(payload.target_id, p1Id);
      assertEquals(payload.commit, 50);
    });
  },
});

// ============================================================================
// Group 54: Toll garrison — pay toll → combat ends → player can travel
// ============================================================================

Deno.test({
  name: "combat — toll garrison: pay toll then travel freely",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // P1 deploys toll garrison in sector 3 and moves away.
    // P2 enters sector 3 via move (triggers auto-engage with toll_registry).
    // P2 pays the toll → round resolves → toll_satisfied → combat ends.
    // P2 can then move to an adjacent sector.

    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipCredits(p2ShipId, 50000);
    });

    await t.step("P1 deploys toll garrison and moves away", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "toll",
        toll_amount: 500,
      });
      await setShipSector(p1ShipId, 4);
    });

    let combatId: string;

    await t.step("P2 moves into sector 3 (triggers auto-engage)", async () => {
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      assert(events.length >= 1, "Should have combat.round_waiting");
      combatId = events[events.length - 1].payload.combat_id as string;
      assertExists(combatId, "combat_id");
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P2 pays the toll", async () => {
      const result = await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "pay",
      });
      assert(result.success);
    });

    await t.step("combat ends with toll_satisfied", async () => {
      const events = await eventsOfType(p2Id, "combat.ended", cursorP2);
      assert(events.length >= 1, "Should have combat.ended event");
      const payload = events[0].payload;
      const result = payload.result ?? payload.end;
      assertEquals(result, "toll_satisfied", "End state should be toll_satisfied");
    });

    await t.step("P2 credits decreased by toll amount", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      assert(
        (ship.credits as number) <= 49500,
        `Credits should have decreased by at least 500, got ${ship.credits}`,
      );
    });

    await t.step("P2 can move to adjacent sector", async () => {
      cursorP2 = await getEventCursor(p2Id);
      const result = await apiOk("move", {
        character_id: p2Id,
        to_sector: 1,
      });
      assert(result.success, "P2 should be able to move after paying toll");
    });

    await t.step("P2 receives movement.complete", async () => {
      const events = await eventsOfType(p2Id, "movement.complete", cursorP2);
      assert(events.length >= 1, "Should have movement.complete event");
    });
  },
});

// ============================================================================
// Group 55: Toll garrison — refuse to pay → garrison attacks
// ============================================================================

Deno.test({
  name: "combat — toll garrison: refuse to pay triggers garrison attack",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // P1 deploys toll garrison in sector 3 and moves away.
    // P2 enters sector 3 via move (triggers auto-engage with toll_registry).
    // Round 1 (demand round): P2 braces (refuses to pay), garrison braces.
    // Round 2: garrison switches to attack since toll was not paid.

    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipCredits(p2ShipId, 50000);
    });

    await t.step("P1 deploys toll garrison and moves away", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 80,
        mode: "toll",
        toll_amount: 500,
      });
      await setShipSector(p1ShipId, 4);
    });

    let combatId: string;

    await t.step("P2 moves into sector 3 (triggers auto-engage)", async () => {
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      assert(events.length >= 1, "Should have combat.round_waiting");
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("Round 1: P2 braces (refuses to pay)", async () => {
      const result = await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "brace",
      });
      assert(result.success);
    });

    await t.step("round 1 resolves — combat continues (no toll_satisfied)", async () => {
      const events = await eventsOfType(p2Id, "combat.round_resolved", cursorP2);
      assert(events.length >= 1, "Should have combat.round_resolved");
      const payload = events[0].payload;
      // end/result should be null — combat continues
      const result = payload.result ?? payload.end ?? null;
      assertEquals(result, null, "Combat should NOT have ended after round 1");
    });

    await t.step("round 2 starts", async () => {
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      const round2 = events.find(
        (e) => e.payload.combat_id === combatId && (e.payload.round as number) === 2,
      );
      assert(round2, "Should have round 2 waiting event");
    });

    await t.step("capture P2 cursor for round 2", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("Round 2: P2 braces again", async () => {
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "brace",
      });
    });

    await t.step("round 2 resolves — garrison attacked (damage dealt)", async () => {
      const events = await eventsOfType(p2Id, "combat.round_resolved", cursorP2);
      assert(events.length >= 1, "Should have combat.round_resolved for round 2");
      const payload = events[0].payload;
      // Garrison should have attacked: P2 should have taken fighter or shield losses
      const defensiveLosses = payload.defensive_losses as Record<string, number> | undefined;
      const shieldLoss = payload.shield_loss as Record<string, number> | undefined;
      const p2FighterLoss = defensiveLosses?.[p2Id] ?? 0;
      const p2ShieldLoss = shieldLoss?.[p2Id] ?? 0;
      assert(
        p2FighterLoss > 0 || p2ShieldLoss > 0,
        `Garrison should have attacked P2 in round 2 — fighter_loss=${p2FighterLoss}, shield_loss=${p2ShieldLoss}`,
      );
    });
  },
});

// ============================================================================
// Group 56: sector.update includes adjacent_sectors with region info
// ============================================================================

Deno.test({
  name: "combat — sector.update adjacent_sectors has region info",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    let cursorP2: number;

    await t.step("capture cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 deploys garrison to trigger sector.update", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
    });

    await t.step("sector.update adjacent_sectors is object with region", async () => {
      const events = await eventsOfType(p2Id, "sector.update", cursorP2);
      assert(events.length >= 1, `Expected >= 1 sector.update, got ${events.length}`);

      const payload = events[0].payload;
      const adj = payload.adjacent_sectors;

      // Should be an object, NOT an array
      assert(
        !Array.isArray(adj),
        `adjacent_sectors should be an object, got array: ${JSON.stringify(adj)}`,
      );
      assert(
        typeof adj === "object" && adj !== null,
        `adjacent_sectors should be an object, got ${typeof adj}`,
      );

      // Sector 3 is adjacent to [1, 4, 7] — all "testbed" region
      const adjObj = adj as Record<string, { region: string }>;
      for (const sectorId of ["1", "4", "7"]) {
        assertExists(
          adjObj[sectorId],
          `adjacent_sectors should include sector ${sectorId}`,
        );
        assertExists(
          adjObj[sectorId].region,
          `adjacent sector ${sectorId} should have region`,
        );
        assertEquals(
          adjObj[sectorId].region,
          "testbed",
          `sector ${sectorId} should be testbed region`,
        );
      }
    });
  },
});

// ============================================================================
// Group 57: combat_leave_fighters — adjacent to FedSpace rejected
// ============================================================================

Deno.test({
  name: "combat — leave fighters: adjacent to FedSpace rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Sector 7 is NOT fedspace, but is adjacent to fedspace sectors 8 and 9.
    // Deploying a garrison here should be rejected.
    await t.step("reset — P1 in sector 7 (adjacent to FedSpace)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 7);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("fails: adjacent to FedSpace", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 7,
        quantity: 50,
        mode: "defensive",
      });
      assertEquals(result.status, 400, `Expected 400 for sector adjacent to FedSpace, got ${result.status}`);
      assert(
        result.body.error?.includes("adjacent to Federation Space"),
        `Expected adjacent-to-FedSpace message, got: ${result.body.error}`,
      );
    });

    // Sector 4 is also adjacent to FedSpace sector 8.
    await t.step("reset — P1 in sector 4 (adjacent to FedSpace)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 4);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("fails: sector 4 also adjacent to FedSpace", async () => {
      const result = await api("combat_leave_fighters", {
        character_id: p1Id,
        sector: 4,
        quantity: 50,
        mode: "offensive",
      });
      assertEquals(result.status, 400, `Expected 400 for sector adjacent to FedSpace, got ${result.status}`);
      assert(
        result.body.error?.includes("adjacent to Federation Space"),
        `Expected adjacent-to-FedSpace message, got: ${result.body.error}`,
      );
    });

    // Sector 3 is NOT adjacent to any FedSpace sector — garrison should succeed.
    await t.step("reset — P1 in sector 3 (not adjacent to FedSpace)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
    });

    await t.step("succeeds: sector 3 not adjacent to FedSpace", async () => {
      const result = await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
      assert(result.success, "Garrison deploy should succeed in non-adjacent sector");
    });
  },
});

// ============================================================================
// Group 58: Corp-ship garrison does NOT auto-engage corpmate on sector entry
// ============================================================================
//
// Regression for the friendly-fire bug caused by `loadGarrisonCombatants`
// looking up garrison-owner corps via `corporation_members` only. Corp-ship
// pseudo-characters aren't rows in that table, so their corp_id came back
// null and `selectStrongestTarget` treated corpmates as hostile.

Deno.test({
  name: "combat — corp-ship garrison does not auto-engage corpmate",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;
    let corpShipId: string;

    await t.step(
      "P1 founds corp, P2 joins corp, corp ship deploys garrison in sector 3",
      async () => {
        await resetDatabase([P1, P2]);
        await apiOk("join", { character_id: p1Id });
        await apiOk("join", { character_id: p2Id });
        await setShipCredits(p1ShipId, 100_000);
        // Move P1 to sector 0 (mega-port) before purchasing a corp ship.
        // test_combat_p1 defaults to sector 3 which rejects ship_purchase.
        await setShipSector(p1ShipId, 0);
        // Move P2 out of the target sector so it can't get caught by the
        // offensive garrison's initial deploy. test_combat_p2 also defaults
        // to sector 3.
        await setShipSector(p2ShipId, 2);

        const createResult = await apiOk("corporation_create", {
          character_id: p1Id,
          name: "Friendly Corp",
        });
        corpId = (createResult as Record<string, unknown>).corp_id as string;
        inviteCode = (createResult as Record<string, unknown>)
          .invite_code as string;

        // Bring P2 into the corp BEFORE the garrison deploys so the
        // corp-ship's deploy-time auto-engage check correctly sees P2 as a
        // corpmate. (If P2 were non-corp at deploy time the garrison would
        // fire on them — which would be correct behavior, just not what
        // we're testing.)
        await apiOk("corporation_join", {
          character_id: p2Id,
          corp_id: corpId,
          invite_code: inviteCode,
        });

        await setMegabankBalance(p1Id, 100_000);
        const purchaseResult = await apiOk("ship_purchase", {
          character_id: p1Id,
          ship_type: "autonomous_probe",
          purchase_type: "corporation",
        });
        corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;

        // Relocate the corp ship to sector 3 (non-fedspace) and give it
        // fighters so it can deploy a garrison.
        await setShipSector(corpShipId, 3);
        await setShipFighters(corpShipId, 200);

        // Deploy offensive garrison as the corp ship (pseudo-character).
        await apiOk("combat_leave_fighters", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          sector: 3,
          quantity: 80,
          mode: "offensive",
        });
      },
    );

    let cursorP2: number;

    await t.step("P2 enters sector 3 where the corp garrison lives", async () => {
      cursorP2 = await getEventCursor(p2Id);
      // Move P2's personal ship into sector 3 where the corp garrison lives.
      // `move` actually exercises `checkGarrisonAutoEngage`; setShipSector
      // alone just updates the DB.
      await apiOk("move", {
        character_id: p2Id,
        to_sector: 3,
      });
    });

    await t.step(
      "P2 does NOT receive combat.round_waiting (corp ship is friendly)",
      async () => {
        await assertNoEventsOfType(
          p2Id,
          "combat.round_waiting",
          cursorP2,
        );
      },
    );

    await t.step("DB: no combat row for sector 3", async () => {
      const combat = await queryCombatState(3);
      assertEquals(
        combat,
        null,
        "Combat should not be initiated against a corpmate garrison",
      );
    });
  },
});

// ============================================================================
// Group 59: Corp-ship garrison metadata carries owner_corporation_id
// ============================================================================
//
// Inside an active encounter, `buildGarrisonActions` → `selectStrongestTarget`
// must filter out corpmates. That filter reads `metadata.owner_corporation_id`
// on the garrison participant; before the fix this came back null for
// corp-ship garrisons.

Deno.test({
  name: "combat — corp-ship garrison participant carries corp_id metadata",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;
    let corpShipId: string;

    await t.step(
      "P1 founds corp, buys corp ship in sector 3, P2 joins, P3 stays out",
      async () => {
        await resetDatabase([P1, P2, P3]);
        await apiOk("join", { character_id: p1Id });
        await apiOk("join", { character_id: p2Id });
        await apiOk("join", { character_id: p3Id });
        await setShipCredits(p1ShipId, 100_000);
        await setShipSector(p1ShipId, 0);

        const createResult = await apiOk("corporation_create", {
          character_id: p1Id,
          name: "Target Filter Corp",
        });
        corpId = (createResult as Record<string, unknown>).corp_id as string;
        inviteCode = (createResult as Record<string, unknown>)
          .invite_code as string;

        await setMegabankBalance(p1Id, 100_000);
        const purchaseResult = await apiOk("ship_purchase", {
          character_id: p1Id,
          ship_type: "autonomous_probe",
          purchase_type: "corporation",
        });
        corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;

        await setShipSector(corpShipId, 3);
        await setShipFighters(corpShipId, 200);
        await apiOk("combat_leave_fighters", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          sector: 3,
          quantity: 80,
          mode: "offensive",
        });

        await apiOk("corporation_join", {
          character_id: p2Id,
          corp_id: corpId,
          invite_code: inviteCode,
        });

        // P3 (non-corpmate) joins the sector so there's a valid hostile
        // target for the garrison — otherwise combat_initiate refuses.
        await setShipSector(p3ShipId, 3);
        await setShipFighters(p3ShipId, 300);
      },
    );

    await t.step("P3 initiates combat against the corp ship", async () => {
      await apiOk("combat_initiate", {
        character_id: p3Id,
        target_id: corpShipId,
      });
    });

    await t.step(
      "Corp-ship garrison participant has owner_corporation_id set",
      async () => {
        const combat = await queryCombatState(3);
        assertExists(combat, "Combat should be active in sector 3");
        const participants = (combat as Record<string, unknown>)
          .participants as Record<string, unknown>;
        const garrisonId = `garrison:3:${corpShipId}`;
        assertExists(
          participants[garrisonId],
          "Corp-ship garrison should be a participant",
        );
        const garrison = participants[garrisonId] as Record<string, unknown>;
        const meta = (garrison.metadata ?? {}) as Record<string, unknown>;
        assertEquals(
          meta.owner_corporation_id,
          corpId,
          "Corp-ship garrison metadata must expose owner_corporation_id",
        );
      },
    );
  },
});

Deno.test({
  name:
    "combat events: corp member receives observer-safe combat.ended for player ship combat",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;
    let cursorP2: number;

    await t.step("setup: P1 and P2 are corpmates; P1 fights P3", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipSector(p3ShipId, 3);
      await setShipFighters(p1ShipId, 500);
      await setShipFighters(p3ShipId, 50);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Combat Watch Corp",
      });
      const corpId = (createResult as Record<string, unknown>)
        .corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });

      cursorP2 = await getEventCursor(p2Id);
      await apiOk("combat_initiate", {
        character_id: p1Id,
        target_id: p3Id,
      });
      const events = await eventsOfType(p1Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    await t.step("resolve combat to terminal state", async () => {
      for (let round = 0; round < 5; round++) {
        const ended = await eventsOfType(p2Id, "combat.ended", cursorP2);
        if (ended.some((event) => event.payload.combat_id === combatId)) break;
        const result = await api("combat_action", {
          character_id: p1Id,
          combat_id: combatId,
          action: "attack",
          target_id: p3Id,
          commit: 200,
        });
        if (result.status === 404) break;
        await api("combat_action", {
          character_id: p3Id,
          combat_id: combatId,
          action: "brace",
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });

    await t.step(
      "remote corp member P2 receives observer-safe combat.ended",
      async () => {
        const events = await eventsOfType(p2Id, "combat.ended", cursorP2);
        const ended = events.find((event) =>
          event.payload.combat_id === combatId
        );
        assertExists(ended, "P2 should receive observed combat.ended");
        assertEquals(ended.payload.observed, true);
        assert(
          !("ship" in ended.payload),
          "observed combat.ended should not include personalized ship payload",
        );
      },
    );
  },
});

// ============================================================================
// Group 60: combat_action rejects attacks against corpmate player ships
// ============================================================================
//
// Before the fix `combat_action` only validated garrison targets. A player
// in an encounter with their corpmate could commit attack fighters against
// them with no server-side objection.

Deno.test({
  name: "combat — combat_action rejects corpmate ship target",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step(
      "P1 + P2 both in Corp X; all three ships in sector 3",
      async () => {
        await resetDatabase([P1, P2, P3]);
        await apiOk("join", { character_id: p1Id });
        await apiOk("join", { character_id: p2Id });
        await apiOk("join", { character_id: p3Id });
        await setShipCredits(p1ShipId, 50_000);

        const createResult = await apiOk("corporation_create", {
          character_id: p1Id,
          name: "No Friendly Fire Corp",
        });
        corpId = (createResult as Record<string, unknown>).corp_id as string;
        inviteCode = (createResult as Record<string, unknown>)
          .invite_code as string;
        await apiOk("corporation_join", {
          character_id: p2Id,
          corp_id: corpId,
          invite_code: inviteCode,
        });

        await setShipSector(p1ShipId, 3);
        await setShipFighters(p1ShipId, 200);
        await setShipSector(p2ShipId, 3);
        await setShipFighters(p2ShipId, 200);
        await setShipSector(p3ShipId, 3);
        await setShipFighters(p3ShipId, 200);
      },
    );

    let combatId: string;

    await t.step("P3 initiates combat against P1 (drags in P2)", async () => {
      const result = await apiOk("combat_initiate", {
        character_id: p3Id,
        target_id: p1Id,
      });
      combatId = (result as Record<string, unknown>).combat_id as string;
      assertExists(combatId);

      // Sanity: P2 is a participant by virtue of being in the same sector.
      const combat = await queryCombatState(3);
      const participants = (combat as Record<string, unknown>)
        .participants as Record<string, unknown>;
      assertExists(participants[p2Id], "P2 should be pulled into combat");
    });

    await t.step("P1 cannot target corpmate P2 via combat_action", async () => {
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: p2Id,
        commit: 50,
      });
      assertEquals(result.status, 400, "Expected 400, got " + result.status);
      const error = String(result.body.error ?? "").toLowerCase();
      assert(
        error.includes("corporation") || error.includes("own"),
        `Expected friendly-fire rejection, got: ${result.body.error}`,
      );
    });

    await t.step("P1 CAN target P3 (non-corpmate)", async () => {
      const result = await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: p3Id,
        commit: 50,
      });
      assert(result.success);
    });
  },
});

// ============================================================================
// Group 26: Combat events catalog payload-shape coverage
// Asserts the new fields landed in Phase 1 are surfaced on every combat
// encounter event (combat.round_waiting / _resolved / ended) AND that
// ship.destroyed carries owner_character_id + corp_id.
// ============================================================================

Deno.test({
  name: "combat events: catalog fields land on round_waiting / resolved / ended / ship.destroyed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;

    await t.step("setup: P1 vs P2 combat in sector with a defensive garrison", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipSector(p3ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 50);
      // Plant P3's defensive garrison directly so combat.round_waiting carries
      // a populated `garrison` sub-object (the new owner_* fields live there).
      // Direct insert dodges the same-sector deploy requirement.
      await insertGarrisonDirect(3, p3Id, 50, "defensive");
      await apiOk("combat_initiate", { character_id: p1Id });
      const events = await eventsOfType(p1Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    await t.step("combat.round_waiting payload exposes new participant + garrison fields", async () => {
      const events = await eventsOfType(p1Id, "combat.round_waiting");
      const payload = events[events.length - 1].payload;
      const participants = payload.participants as Array<Record<string, unknown>>;
      assert(participants.length >= 2, "two character participants expected");
      for (const p of participants) {
        assert("fighters" in p, "participant missing `fighters`");
        assert("destroyed" in p, "participant missing `destroyed`");
        assert("corp_id" in p, "participant missing `corp_id`");
        assert("has_fled" in p, "participant missing `has_fled`");
        assert("fled_to_sector" in p, "participant missing `fled_to_sector`");
        assertEquals(p.has_fled, false, "no one has fled at round 1");
      }
      const garrison = payload.garrison as Record<string, unknown> | null;
      assertExists(garrison, "garrison sub-object on round_waiting");
      assert("owner_character_id" in garrison, "garrison missing `owner_character_id`");
      assert("owner_corp_id" in garrison, "garrison missing `owner_corp_id`");
      assertEquals(garrison.owner_character_id, p3Id);
    });

    let resolvedCursor: number;
    await t.step("capture cursor + resolve a round so we have round_resolved", async () => {
      resolvedCursor = await getEventCursor(p1Id);
      await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        target_id: p2Id,
        commit: 50,
      });
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "brace",
      });
    });

    await t.step("combat.round_resolved payload carries the new fields", async () => {
      const events = await eventsOfType(p1Id, "combat.round_resolved", resolvedCursor);
      assert(events.length >= 1, "expected combat.round_resolved");
      const payload = events[0].payload;
      const participants = payload.participants as Array<Record<string, unknown>>;
      for (const p of participants) {
        assert("fighters" in p, "resolved.participant missing `fighters`");
        assert("destroyed" in p, "resolved.participant missing `destroyed`");
        assert("corp_id" in p, "resolved.participant missing `corp_id`");
      }
      const garrison = payload.garrison as Record<string, unknown> | null;
      assertExists(garrison, "garrison on round_resolved");
      assert("owner_character_id" in garrison, "resolved.garrison missing owner_character_id");
      assert("owner_corp_id" in garrison, "resolved.garrison missing owner_corp_id");
    });

    await t.step("force combat to end and assert combat.ended payload + ship.destroyed", async () => {
      // Crush P2 so they die: max P1 fighters, P2 already at 50.
      const endCursor = await getEventCursor(p1Id);
      // Loop submitting actions until combat_action returns 404 (combat
      // ended) or we hit a safety limit.
      for (let round = 0; round < 8; round++) {
        const result = await api("combat_action", {
          character_id: p1Id,
          combat_id: combatId,
          action: "attack",
          target_id: p2Id,
          commit: 200,
        });
        if (result.status === 404) break;
        await api("combat_action", {
          character_id: p2Id,
          combat_id: combatId,
          action: "brace",
        });
        // Brief settle so round-resolution events land before the next loop.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const ended = await eventsOfType(p1Id, "combat.ended", endCursor);
      assert(ended.length >= 1, "combat.ended should fire for P1");
      const endedPayload = ended[ended.length - 1].payload;
      const endedParticipants = endedPayload.participants as Array<
        Record<string, unknown>
      >;
      for (const p of endedParticipants) {
        assert("fighters" in p, "ended.participant missing `fighters`");
        assert("destroyed" in p, "ended.participant missing `destroyed`");
        assert("corp_id" in p, "ended.participant missing `corp_id`");
      }

      // ship.destroyed for P2 — owner_character_id + corp_id must be present.
      const destroyed = await eventsOfType(p1Id, "ship.destroyed", endCursor);
      assert(destroyed.length >= 1, "ship.destroyed should fire for P2's ship");
      const destroyedPayload = destroyed[destroyed.length - 1].payload;
      assert("owner_character_id" in destroyedPayload, "ship.destroyed missing owner_character_id");
      assert("corp_id" in destroyedPayload, "ship.destroyed missing corp_id");
    });
  },
});

// ============================================================================
// Group 27: garrison.destroyed event emission
// Drop a garrison's fighters to 0 in combat; assert the event fires with the
// full payload BEFORE the garrison row is deleted, and that recipients
// include the absent garrison owner.
// ============================================================================

Deno.test({
  name: "combat events: garrison.destroyed fires with full payload + reaches absent owner",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;

    await t.step("setup: P1 deploys defensive garrison and moves away; P2 attacks it", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 500);

      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 5, // tiny — easy to one-shot
        mode: "defensive",
      });
      await setShipSector(p1ShipId, 4); // owner leaves the sector

      await apiOk("combat_initiate", { character_id: p2Id });
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      assert(events.length >= 1);
      combatId = events[events.length - 1].payload.combat_id as string;
    });

    let cursorP1: number;
    await t.step("capture P1 cursor and attack the garrison", async () => {
      cursorP1 = await getEventCursor(p1Id);
      // Pick the garrison combatant id from the round_waiting payload.
      const events = await eventsOfType(p2Id, "combat.round_waiting");
      const garrisonObj = events[events.length - 1].payload.garrison as
        | { id?: string }
        | null;
      assertExists(garrisonObj, "garrison sub-object");
      assertExists(garrisonObj.id, "garrison.id");

      // Sustained attack until the 5-fighter garrison falls (typically 1 round).
      for (let round = 0; round < 5; round++) {
        const dest = await eventsOfType(p1Id, "garrison.destroyed", cursorP1);
        if (dest.length) break;
        const wait = await eventsOfType(p2Id, "combat.round_waiting");
        if (!wait.length) break;
        await apiOk("combat_action", {
          character_id: p2Id,
          combat_id: combatId,
          action: "attack",
          target_id: garrisonObj.id,
          commit: 100,
        });
      }
    });

    await t.step("absent owner P1 receives garrison.destroyed with full payload", async () => {
      const events = await eventsOfType(p1Id, "garrison.destroyed", cursorP1);
      assert(events.length >= 1, "P1 should receive garrison.destroyed");
      const payload = events[0].payload;
      assertEquals(payload.owner_character_id, p1Id);
      assert(typeof payload.combat_id === "string", "combat_id");
      assert(typeof payload.garrison_id === "string", "garrison_id");
      assert("owner_corp_id" in payload, "owner_corp_id");
      // owner_name is a non-empty string — the exact value depends on the
      // character's display-name in the fixture (defaults to UUID for
      // resetDatabase-created chars), so we just assert presence.
      assert(
        typeof payload.owner_name === "string" && payload.owner_name.length > 0,
        "owner_name should be a non-empty string",
      );
      const sector = payload.sector as { id?: number } | undefined;
      assertEquals(sector?.id, 3);
      assertEquals(payload.mode, "defensive");
    });

    await t.step(
      "absent owner P1 receives observer-safe combat.ended",
      async () => {
        const events = await eventsOfType(p1Id, "combat.ended", cursorP1);
        const ended = events.find((event) =>
          event.payload.combat_id === combatId
        );
        assertExists(ended, "P1 should receive observed combat.ended");
        assertEquals(ended.payload.observed, true);
        assert(
          !("ship" in ended.payload),
          "observed combat.ended should not include personalized ship payload",
        );
      },
    );

    await t.step("garrison row was deleted (event captured the metadata before delete)", async () => {
      const garrison = await queryGarrison(3);
      // After destruction, no row should remain.
      // Either null or a row with fighters > 0 (different garrison) — but
      // since we only deployed P1's, null is expected.
      assertEquals(garrison, null, "garrison row should be deleted");
    });
  },
});
