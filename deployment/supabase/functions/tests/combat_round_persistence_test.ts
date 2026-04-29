/**
 * Integration tests for per-round persistence of combat outcomes to
 * canonical tables (ship_instances, garrisons).
 *
 * Pre-fix, combat only flushed survivor fighters/shields and corp-ship
 * destroyed_at to the DB at end-of-combat (finalizeCombat). This caused
 * any DB-sourced snapshot taken mid-combat (corporation.data,
 * status.update, my_status / my_corporation tool calls) to serve
 * pre-combat values and clobber freshly-applied client state.
 *
 * These tests assert that after each round, ship_instances reflects the
 * live combat state — not the pre-combat values.
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
  queryShip,
  setShipCredits,
  setShipFighters,
  setShipShields,
  setShipSector,
  createCorpShip,
  queryCombatState,
  expireCombatDeadline,
} from "./helpers.ts";

const P1 = "test_round_persist_p1";
const P2 = "test_round_persist_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

Deno.test({
  name: "combat_round_persistence — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

/**
 * Resolve a single combat round: attacker submits attack, defender defaults
 * to brace via timeout. Returns the encounter state after the round.
 */
async function resolveOneRound(
  sectorId: number,
  attackerId: string,
  targetId: string,
): Promise<Record<string, unknown>> {
  const before = await queryCombatState(sectorId);
  assertExists(before, "Combat must be active before resolving a round");
  const combatId = (before as Record<string, unknown>).combat_id as string;

  await api("combat_action", {
    character_id: attackerId,
    combat_id: combatId,
    action: "attack",
    target_id: targetId,
    commit: 200,
  });

  await expireCombatDeadline(sectorId);
  await api("combat_tick", {});

  const after = await queryCombatState(sectorId);
  return (after ?? {}) as Record<string, unknown>;
}

Deno.test({
  name:
    "combat_round_persistence — survivor fighters/shields are flushed to ship_instances after each round",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);
    p2ShipId = await shipIdFor(P2);

    const P2_START_FIGHTERS = 200;
    const P2_START_SHIELDS = 150;

    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      // P1 strong enough to land hits each round; P2 can absorb 2+ rounds.
      await setShipFighters(p1ShipId, 300);
      await setShipFighters(p2ShipId, P2_START_FIGHTERS);
      await setShipShields(p2ShipId, P2_START_SHIELDS);
    });

    await t.step("P1 initiates combat", async () => {
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    await t.step("ship_instances still holds pre-combat values before any round resolves", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      assertEquals(ship.current_fighters, P2_START_FIGHTERS);
      assertEquals(ship.current_shields, P2_START_SHIELDS);
    });

    let p2RoundOneFighters = 0;
    let p2RoundOneShields = 0;

    await t.step("after round 1, ship_instances reflects round-1 outcome (not pre-combat)", async () => {
      const state = await resolveOneRound(3, p1Id, p2Id);
      assertEquals(state.ended, false, "Combat should still be active");
      const participants = state.participants as Record<
        string,
        { fighters: number; shields: number }
      >;
      const expectedFighters = participants[p2Id].fighters;
      const expectedShields = participants[p2Id].shields;

      assert(
        expectedFighters < P2_START_FIGHTERS || expectedShields < P2_START_SHIELDS,
        `Expected P2 to take damage in round 1 (fighters=${expectedFighters}, shields=${expectedShields})`,
      );

      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      assertEquals(
        ship.current_fighters,
        expectedFighters,
        "ship_instances.current_fighters must match round outcome",
      );
      assertEquals(
        ship.current_shields,
        expectedShields,
        "ship_instances.current_shields must match round outcome",
      );

      p2RoundOneFighters = expectedFighters;
      p2RoundOneShields = expectedShields;
    });

    await t.step("after round 2, ship_instances reflects round-2 outcome", async () => {
      const state = await resolveOneRound(3, p1Id, p2Id);
      // Round 2 may end combat if P2 dies; either way, the snapshot must agree.
      const participants = state.participants as Record<
        string,
        { fighters: number; shields: number }
      >;
      const expectedFighters = participants[p2Id]?.fighters ?? 0;

      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      assertEquals(
        ship.current_fighters,
        expectedFighters,
        "ship_instances.current_fighters must match round 2 outcome",
      );
      // Either fighters dropped further OR shields decreased (or P2 died).
      assert(
        expectedFighters < p2RoundOneFighters ||
          (ship.current_shields as number) < p2RoundOneShields ||
          expectedFighters === 0,
        "Expected round 2 to apply more damage or end combat",
      );
    });
  },
});

Deno.test({
  name:
    "combat_round_persistence — destroyed corp ship gets destroyed_at mid-combat",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and setup 3-way combat with weak corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      // P1 stays strong. P2 is sturdy enough to keep combat going past round 1.
      await setShipFighters(p1ShipId, 300);
      await setShipFighters(p2ShipId, 250);
      await setShipShields(p2ShipId, 200);

      // P2 spins up a corp and parks a fragile corp ship in sector 3.
      await setShipCredits(p2ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p2Id,
        name: "Persistence Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const ship = await createCorpShip(corpId, 3, "Fragile Test Scout");
      corpShipId = ship.shipId;
      await setShipFighters(corpShipId, 3);
    });

    await t.step("P1 initiates combat (auto-pulls P2 + corp ship as hostiles)", async () => {
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    await t.step("corp ship has no destroyed_at before combat resolves", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship);
      assertEquals(ship.destroyed_at, null, "destroyed_at must be null pre-combat");
    });

    await t.step("after one round of focused fire on corp ship, destroyed_at is set in DB", async () => {
      // P1 attacks the corp ship; with only 3 fighters it should die in round 1.
      const state = await resolveOneRound(3, p1Id, corpShipId);

      // Combat may or may not be ended depending on whether P2 alone counts as
      // a remaining hostile — the assertion we care about is the corp ship's
      // DB state, which must show destroyed_at regardless of combat status.
      const ship = await queryShip(corpShipId);
      assertExists(ship, "Corp ship row must still exist (soft-delete only)");
      assertExists(
        ship.destroyed_at,
        "destroyed_at must be set immediately when corp ship dies, not deferred to combat end",
      );
      assertEquals(ship.current_fighters, 0);
      assertEquals(ship.current_shields, 0);

      // Sanity check: the encounter blob recorded the kill.
      if (state.ended === false) {
        const participants = state.participants as Record<
          string,
          { fighters: number; destruction_handled?: boolean }
        >;
        const corpParticipant = participants[corpShipId];
        if (corpParticipant) {
          assertEquals(corpParticipant.fighters, 0);
          assertEquals(
            corpParticipant.destruction_handled,
            true,
            "destruction_handled flag must be set on the corp ship participant",
          );
        }
      }
    });
  },
});
