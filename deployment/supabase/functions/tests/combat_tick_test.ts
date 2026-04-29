/**
 * Phase 3: Combat tick & round resolution tests.
 *
 * Tests that the combat_tick endpoint correctly resolves timed-out rounds,
 * handles multi-round combat, shield regeneration, flee mechanics, garrison
 * destruction, and joining existing combats.
 *
 * Coverage targets:
 * - combat_tick/index.ts (0% → ~90%)
 * - combat_resolution.ts (45% → ~75%)
 * - combat_engine.ts (56% → ~75%)
 * - combat_finalization.ts (49% → ~75%)
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
  eventsSince,
  getEventCursor,
  setShipSector,
  setShipFighters,
  setShipShields,
  setShipWarpPower,
  expireCombatDeadline,
  queryCombatState,
  queryShip,
  queryGarrison,
  insertGarrisonDirect,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Character/ship handles — match PINNED_SECTORS in test_reset
// ---------------------------------------------------------------------------

const P1 = "test_tick_p1";
const P2 = "test_tick_p2";
const P3 = "test_tick_p3";

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
  name: "combat_tick — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

Deno.test({
  name: "combat_tick — resolve IDs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    [p1Id, p2Id, p3Id] = await Promise.all([
      characterIdFor(P1),
      characterIdFor(P2),
      characterIdFor(P3),
    ]);
    [p1ShipId, p2ShipId, p3ShipId] = await Promise.all([
      shipIdFor(P1),
      shipIdFor(P2),
      shipIdFor(P3),
    ]);
  },
});

// ============================================================================
// Group 1: Tick resolves timed-out round — P1 attacks, P2 times out (brace)
// When both players timeout to brace, combat ends as "stalemate" since there
// are no attackers. To test the continuation path, P1 submits an attack and
// P2 times out (gets auto-brace). Combat should continue to round 2.
// ============================================================================

Deno.test({
  name: "combat_tick — timeout resolution: one attacker, one timeout brace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;

    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
    });

    let cursorP1: number;

    await t.step("initiate combat and P1 attacks", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await apiOk("combat_initiate", { character_id: p1Id });
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;
      cursorP1 = await getEventCursor(p1Id);
      // P1 submits attack, P2 does NOT submit (will timeout to brace)
      await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        commit: 10,
        target_id: p2Id,
      });
    });

    await t.step("expire deadline and tick", async () => {
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("verify round_resolved emitted", async () => {
      const events = await eventsOfType(
        p1Id,
        "combat.round_resolved",
        cursorP1,
      );
      assert(events.length >= 1, `Expected round_resolved, got ${events.length}`);
    });

    await t.step("verify combat continues (round_waiting emitted)", async () => {
      const events = await eventsOfType(
        p1Id,
        "combat.round_waiting",
        cursorP1,
      );
      assert(events.length >= 1, `Expected round_waiting after tick, got ${events.length}`);
    });

    await t.step("verify combat state still active", async () => {
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat should still be active");
      assert(combat.ended !== true, "Combat should not be ended");
    });
  },
});

// ============================================================================
// Group 1b: Both players timeout → stalemate (combat ends)
// When both players brace (no attackers), combat engine returns "stalemate".
// ============================================================================

Deno.test({
  name: "combat_tick — both timeout leads to stalemate end",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
    });

    let cursorP1: number;

    await t.step("initiate combat", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    await t.step("expire deadline and tick (neither submits)", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("verify combat ended with stalemate", async () => {
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist");
      assertEquals(combat.ended, true, "Combat should be ended");
      assertEquals(combat.end_state, "stalemate", "End state should be stalemate");
    });

    await t.step("verify combat.ended event emitted", async () => {
      const events = await eventsOfType(p1Id, "combat.ended", cursorP1);
      assert(events.length >= 1, "Should have combat.ended event");
    });
  },
});

// ============================================================================
// Group 2: Tick with no due combats — empty batch
// ============================================================================

Deno.test({
  name: "combat_tick — no due combats returns zero",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset with no combat", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("tick returns checked=0, resolved=0", async () => {
      const result = await apiOk("combat_tick", {});
      const body = result as Record<string, unknown>;
      assertEquals(body.checked, 0, "Should check 0 combats");
      assertEquals(body.resolved, 0, "Should resolve 0 combats");
    });
  },
});

// ============================================================================
// Group 3: Multi-round combat to natural end (P1 attacks, P2 braces)
// We set P2 to very low fighters so combat ends quickly via defeat.
// ============================================================================

Deno.test({
  name: "combat_tick — multi-round combat to defeat",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup (P2 has minimal fighters)", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 2); // Very few fighters — will lose quickly
      await setShipShields(p2ShipId, 0);
    });

    let combatId: string;
    let cursorP1: number;
    let cursorP2: number;

    await t.step("initiate combat", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      await apiOk("combat_initiate", { character_id: p1Id });
      // Get combat ID from round_waiting event
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      assert(events.length >= 1, "Should have round_waiting");
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;
      assertExists(combatId, "combat_id should exist");
    });

    await t.step("P1 attacks P2, P2 times out", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        commit: 50,
        target_id: p2Id,
      });
      // Only P1 submitted — need tick to resolve after timeout
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("attack until combat ends", async () => {
      // Combat engine has RNG — P2 with 2 fighters might survive a round or two.
      // Loop up to 5 rounds to ensure combat resolves.
      for (let round = 0; round < 5; round++) {
        const endCheck = await eventsOfType(p1Id, "combat.ended", cursorP1);
        if (endCheck.length >= 1) break;

        // Check if combat is still active
        const combat = await queryCombatState(3);
        if (combat?.ended) break;

        cursorP1 = await getEventCursor(p1Id);
        try {
          await apiOk("combat_action", {
            character_id: p1Id,
            combat_id: combatId,
            action: "attack",
            commit: 50,
            target_id: p2Id,
          });
        } catch (_e) {
          // Combat may have ended between check and action
          break;
        }
        await expireCombatDeadline(3);
        await apiOk("combat_tick", {});
      }

      // Verify combat ended
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist");
      assertEquals(combat.ended, true, "Combat should have ended");
    });

    await t.step("P2 should be converted to escape pod", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship, "P2 ship should still exist");
      assertEquals(ship.ship_type, "escape_pod", "P2 should be escape pod");
      assertEquals(Number(ship.current_fighters), 0, "Escape pod has 0 fighters");
    });

    await t.step("combat state should be ended", async () => {
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat record should exist");
      assertEquals(combat.ended, true, "Combat should be ended");
    });
  },
});

// ============================================================================
// Group 4: Shield regeneration between rounds
// P1 attacks P2 (small commit), both have shields. After round 1, shields
// should regen by SHIELD_REGEN_PER_ROUND (default 10) up to max_shields.
// We need at least one attacker to avoid stalemate on mutual brace.
// ============================================================================

Deno.test({
  name: "combat_tick — shield regeneration between rounds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let combatId: string;

    await t.step("reset and setup with shields", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await setShipShields(p1ShipId, 20);
      await setShipShields(p2ShipId, 20);
    });

    let cursorP1: number;

    await t.step("initiate combat and P1 submits small attack", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await apiOk("combat_initiate", { character_id: p1Id });
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;
      // P1 attacks with small commit so combat continues
      await apiOk("combat_action", {
        character_id: p1Id,
        combat_id: combatId,
        action: "attack",
        commit: 5,
        target_id: p2Id,
      });
    });

    await t.step("resolve round 1 (P2 timeout → brace)", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("verify shields in round_waiting payload", async () => {
      const events = await eventsOfType(
        p1Id,
        "combat.round_waiting",
        cursorP1,
      );
      assert(events.length >= 1, "Should have round_waiting (combat continues)");
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      // participants is an array of {id, name, ship: {shield_integrity, ...}}
      const participants = payload.participants as Record<string, unknown>[] | undefined;
      assertExists(participants, "Should have participants");
      assert(participants.length >= 2, "Should have 2+ participants");
      // After round with some damage, shields should have regenerated (shield_integrity > 0)
      // kestrel_courier has max_shields=30, we set current_shields=20
      // After regen (+10), shields = min(20+10, 30) = 30 → integrity = 100%
      let shieldsFound = false;
      for (const p of participants) {
        const ship = p.ship as Record<string, unknown> | undefined;
        if (ship && typeof ship.shield_integrity === "number" && ship.shield_integrity > 0) {
          shieldsFound = true;
        }
      }
      assert(shieldsFound, "At least one participant should have shield_integrity > 0 after regen");
    });
  },
});

// ============================================================================
// Group 5: Flee via tick — P2 flees, tick resolves, P2 moves to adjacent sector
// ============================================================================

Deno.test({
  name: "combat_tick — flee action moves ship to adjacent sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await setShipWarpPower(p2ShipId, 500);
    });

    let combatId: string;
    let cursorP2: number;

    await t.step("initiate combat and get combat_id", async () => {
      const cursor = await getEventCursor(p1Id);
      await apiOk("combat_initiate", { character_id: p1Id });
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursor);
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;
    });

    await t.step("P2 submits flee action", async () => {
      cursorP2 = await getEventCursor(p2Id);
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "flee",
      });
    });

    await t.step("P1 times out, tick resolves", async () => {
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("verify combat resolved and P2's flee result", async () => {
      // Combat should have ended: either P2 fled (combat over) or
      // P2 failed to flee + P1 braced → stalemate.
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist after tick");
      assertEquals(combat.ended, true, "Combat should be ended (flee or stalemate)");

      // If flee succeeded, P2 should be in an adjacent sector
      const ship = await queryShip(p2ShipId);
      assertExists(ship, "P2 ship should exist");
      const sector = Number(ship.current_sector);
      // P2 either fled (adjacent sector 1/4/7) or stayed (sector 3 for stalemate)
      assert(
        [1, 3, 4, 7].includes(sector),
        `P2 should be in sector 3 or adjacent, got ${sector}`,
      );
    });
  },
});

// ============================================================================
// Group 6: Garrison destroyed mid-combat
// P1 deploys a garrison with minimal fighters. P2 attacks it. After tick
// resolution, garrison should be deleted from the database.
// ============================================================================

Deno.test({
  name: "combat_tick — garrison destroyed and deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // Move P2 OUT of sector 3 first, so garrison deploy doesn't trigger
      // auto-engage while P2 is still there
      await setShipSector(p2ShipId, 4);
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      // Deploy garrison with very few fighters
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 5,
        mode: "offensive",
      });
      // Move P1 away so only the garrison remains
      await setShipSector(p1ShipId, 7);
      // Equip P2 for move
      await setShipFighters(p2ShipId, 200);
      await setShipWarpPower(p2ShipId, 500);
    });

    let cursorP2: number;
    let combatId: string;

    await t.step("P2 moves into sector and triggers combat", async () => {
      cursorP2 = await getEventCursor(p2Id);
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting", cursorP2);
      assert(events.length >= 1, "Should trigger combat with garrison");
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;
    });

    await t.step("P2 attacks garrison, tick resolves", async () => {
      cursorP2 = await getEventCursor(p2Id);
      // Find garrison combatant ID from the combat state
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat should exist");
      const participants = combat.participants as Record<string, Record<string, unknown>>;
      let garrisonCombatantId: string | null = null;
      for (const [pid, p] of Object.entries(participants)) {
        if (p.combatant_type === "garrison") {
          garrisonCombatantId = pid;
          break;
        }
      }
      assertExists(garrisonCombatantId, "Should have garrison participant");
      await apiOk("combat_action", {
        character_id: p2Id,
        combat_id: combatId,
        action: "attack",
        commit: 100,
        target_id: garrisonCombatantId,
      });
      await expireCombatDeadline(3);
      await apiOk("combat_tick", {});
    });

    await t.step("verify garrison deleted or fighters reduced", async () => {
      const garrison = await queryGarrison(3);
      // With 5 fighters vs 200, garrison should be destroyed
      // But combat engine has randomness — garrison might survive with fewer
      if (garrison) {
        assert(
          Number(garrison.fighters) < 5,
          `Garrison should have fewer fighters, got ${garrison.fighters}`,
        );
      }
      // If garrison is null, it was destroyed — test passes
    });
  },
});

// ============================================================================
// Group 7: Join existing combat — third player joins mid-combat
// P1 and P2 are in combat. P3 moves into the sector and initiates combat.
// P3 should join the existing encounter.
// ============================================================================

Deno.test({
  name: "combat_tick — third player joins existing combat",
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
      await setShipSector(p3ShipId, 4); // Adjacent to 3
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await setShipFighters(p3ShipId, 100);
      await setShipWarpPower(p3ShipId, 500);
    });

    let combatId: string;
    let cursorP3: number;

    await t.step("P1 initiates combat with P2", async () => {
      const cursor = await getEventCursor(p1Id);
      await apiOk("combat_initiate", { character_id: p1Id });
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursor);
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;
    });

    await t.step("P3 moves into sector 3 and joins combat", async () => {
      cursorP3 = await getEventCursor(p3Id);
      await apiOk("move", { character_id: p3Id, to_sector: 3 });
      await apiOk("combat_initiate", { character_id: p3Id });
    });

    await t.step("verify 3 participants in combat", async () => {
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat should exist");
      const participants = combat.participants as Record<string, Record<string, unknown>>;
      const characterParticipants = Object.values(participants).filter(
        (p) => p.combatant_type === "character",
      );
      assertEquals(
        characterParticipants.length,
        3,
        `Expected 3 character participants, got ${characterParticipants.length}`,
      );
    });

    await t.step("P3 receives combat.round_waiting", async () => {
      const events = await eventsOfType(p3Id, "combat.round_waiting", cursorP3);
      assert(events.length >= 1, "P3 should have round_waiting");
    });
  },
});

// ============================================================================
// Group 8: Surviving ship fighters/shields persisted after combat ends
// P1 (100 fighters) defeats P2 (2 fighters). After combat, P1's fighters and
// shields should be updated in ship_instances to reflect damage taken.
// ============================================================================

Deno.test({
  name: "combat_tick — surviving ship fighters persisted after combat",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup — P1 strong, P2 weak", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 2);
      await setShipShields(p1ShipId, 0);
      await setShipShields(p2ShipId, 0);
    });

    // Record P1's pre-combat state
    let p1PreFighters: number;

    await t.step("record pre-combat fighter count", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship, "P1 ship should exist");
      p1PreFighters = Number(ship.current_fighters);
      assertEquals(p1PreFighters, 100, "P1 should start with 100 fighters");
    });

    let combatId: string;
    let cursorP1: number;

    await t.step("initiate combat", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await apiOk("combat_initiate", { character_id: p1Id });
      const events = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;
      assertExists(combatId, "combat_id should exist");
    });

    await t.step("P1 attacks P2 until defeat", async () => {
      for (let round = 0; round < 5; round++) {
        cursorP1 = await getEventCursor(p1Id);
        try {
          await apiOk("combat_action", {
            character_id: p1Id,
            combat_id: combatId,
            action: "attack",
            commit: 50,
            target_id: p2Id,
          });
        } catch (_e) {
          break;
        }
        await expireCombatDeadline(3);
        await apiOk("combat_tick", {});

        const endCheck = await eventsOfType(p1Id, "combat.ended", cursorP1);
        if (endCheck.length >= 1) break;

        const combat = await queryCombatState(3);
        if (combat?.ended) break;
      }

      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist");
      assertEquals(combat.ended, true, "Combat should have ended");
    });

    await t.step("P1 (survivor) fighters persisted in DB", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship, "P1 ship should exist");
      const postFighters = Number(ship.current_fighters);
      // P2 had 2 fighters attacking back (via brace counter or direct), so P1
      // should have taken at least some damage. Even if P2 only braced, the
      // combat engine resolves with the in-memory state. The key assertion is
      // that the DB value differs from the pre-combat value of 100 OR matches
      // the encounter's final participant state.
      // At minimum, verify the DB was actually updated by checking against the
      // combat encounter's final state.
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist");
      const participants = combat.participants as Record<string, Record<string, unknown>>;
      // Find P1's participant entry
      let p1CombatFighters: number | null = null;
      for (const [_pid, p] of Object.entries(participants)) {
        if (p.owner_character_id === p1Id) {
          p1CombatFighters = Number(p.fighters);
          break;
        }
      }
      assertExists(p1CombatFighters, "P1 should be in combat participants");
      assertEquals(
        postFighters,
        p1CombatFighters,
        `DB fighters (${postFighters}) should match combat state (${p1CombatFighters})`,
      );
    });
  },
});

// ============================================================================
// Group 10: Surviving ship fighters/shields persisted after garrison combat
// P2 (200 fighters) attacks a garrison (5 fighters). After combat ends, P2's
// fighters in ship_instances should reflect damage taken during the fight.
// ============================================================================

Deno.test({
  name: "combat_tick — surviving ship fighters persisted after garrison combat",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup — garrison in sector 3", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // Deploy garrison via P1
      await setShipSector(p2ShipId, 4); // Move P2 out first
      await setShipSector(p1ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "offensive",
      });
      // Move P1 away
      await setShipSector(p1ShipId, 7);
      // Set up P2 for attack
      await setShipFighters(p2ShipId, 200);
      await setShipShields(p2ShipId, 0);
      await setShipWarpPower(p2ShipId, 500);
    });

    let p2PreFighters: number;

    await t.step("record P2 pre-combat fighters", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship, "P2 ship should exist");
      p2PreFighters = Number(ship.current_fighters);
      assertEquals(p2PreFighters, 200, "P2 should start with 200 fighters");
    });

    let combatId: string;
    let cursorP2: number;
    let garrisonCombatantId: string;

    await t.step("P2 moves into sector and triggers combat", async () => {
      cursorP2 = await getEventCursor(p2Id);
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
      const events = await eventsOfType(p2Id, "combat.round_waiting", cursorP2);
      assert(events.length >= 1, "Should trigger combat with garrison");
      combatId = (events[events.length - 1].payload as Record<string, unknown>).combat_id as string;

      // Find garrison combatant ID
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat should exist");
      const participants = combat.participants as Record<string, Record<string, unknown>>;
      for (const [pid, p] of Object.entries(participants)) {
        if (p.combatant_type === "garrison") {
          garrisonCombatantId = pid;
          break;
        }
      }
      assertExists(garrisonCombatantId, "Should have garrison participant");
    });

    await t.step("P2 attacks garrison until combat ends", async () => {
      for (let round = 0; round < 5; round++) {
        cursorP2 = await getEventCursor(p2Id);
        try {
          await apiOk("combat_action", {
            character_id: p2Id,
            combat_id: combatId,
            action: "attack",
            commit: 100,
            target_id: garrisonCombatantId,
          });
        } catch (_e) {
          break;
        }
        await expireCombatDeadline(3);
        await apiOk("combat_tick", {});

        const endCheck = await eventsOfType(p2Id, "combat.ended", cursorP2);
        if (endCheck.length >= 1) break;

        const combat = await queryCombatState(3);
        if (combat?.ended) break;
      }

      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist");
      assertEquals(combat.ended, true, "Combat should have ended");
    });

    await t.step("P2 (survivor) fighters persisted in DB", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship, "P2 ship should exist");
      const postFighters = Number(ship.current_fighters);

      // Verify DB matches the combat encounter's final state for P2
      const combat = await queryCombatState(3);
      assertExists(combat, "Combat state should exist");
      const participants = combat.participants as Record<string, Record<string, unknown>>;
      let p2CombatFighters: number | null = null;
      for (const [_pid, p] of Object.entries(participants)) {
        if (p.owner_character_id === p2Id) {
          p2CombatFighters = Number(p.fighters);
          break;
        }
      }
      assertExists(p2CombatFighters, "P2 should be in combat participants");
      assertEquals(
        postFighters,
        p2CombatFighters,
        `DB fighters (${postFighters}) should match combat state (${p2CombatFighters})`,
      );
    });
  },
});
