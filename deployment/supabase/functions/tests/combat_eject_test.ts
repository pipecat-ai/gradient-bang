/**
 * Integration tests for mid-round ejection of destroyed combatants.
 *
 * When a ship is destroyed mid-combat (combat continues for others), the
 * destroyed participant must:
 *   - Be flagged `destruction_handled = true` on the encounter blob (kept in
 *     the participants list so observers / LLM see them as destroyed across
 *     subsequent rounds, not mistaken for a fleer who left).
 *   - Have escape-pod conversion (player) or corp-ship cleanup (corp_ships +
 *     pseudo-character row) committed immediately, not deferred to combat end.
 *   - Be unable to act: combat_action returns 410.
 *   - Not be a valid target: combat_action attack with target_id pointing at
 *     them returns 400.
 *   - Receive a personalized `combat.ended` event so their UI exits combat.
 *   - Not block movement / dump_cargo / bank withdraws etc. — they're flying
 *     an escape pod and must be free to leave.
 *
 * Salvage from the destroyed ship is captured onto the encounter blob but
 * NOT dropped into `sector_contents.salvage` until combat ends — preventing
 * mid-fight looting by combatants or sector passers-by.
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
  queryShip,
  setShipCargo,
  setShipCredits,
  setShipFighters,
  setShipShields,
  setShipSector,
  createCorpShip,
  queryCombatState,
  querySectorSalvage,
  expireCombatDeadline,
  withPg,
} from "./helpers.ts";

const P1 = "test_eject_p1";
const P2 = "test_eject_p2";
const P3 = "test_eject_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p1ShipId: string;
let p2ShipId: string;
let p3ShipId: string;

Deno.test({
  name: "combat_eject — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

async function resolveOneRound(
  sectorId: number,
  attackerId: string,
  targetId: string,
  commit = 200,
): Promise<Record<string, unknown>> {
  const before = await queryCombatState(sectorId);
  assertExists(before, "Combat must be active before resolving a round");
  const combatId = (before as Record<string, unknown>).combat_id as string;

  await api("combat_action", {
    character_id: attackerId,
    combat_id: combatId,
    action: "attack",
    target_id: targetId,
    commit,
  });
  await expireCombatDeadline(sectorId);
  await api("combat_tick", {});

  const after = await queryCombatState(sectorId);
  return (after ?? {}) as Record<string, unknown>;
}

Deno.test({
  name:
    "combat_eject — destroyed player gets escape pod, exits combat, can move",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p3Id = await characterIdFor(P3);
    p1ShipId = await shipIdFor(P1);
    p2ShipId = await shipIdFor(P2);
    p3ShipId = await shipIdFor(P3);

    await t.step("reset and setup 3-way combat (P2 will die round 1)", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipSector(p3ShipId, 3);
      // P1 strong enough to one-shot P2; P3 sturdy enough to keep combat alive.
      await setShipFighters(p1ShipId, 400);
      await setShipFighters(p2ShipId, 5);
      await setShipFighters(p3ShipId, 250);
      await setShipShields(p3ShipId, 200);
      // P2 has cargo so we can verify salvage capture without a sector drop.
      await setShipCargo(p2ShipId, { qf: 25 });
      await setShipCredits(p2ShipId, 100);
    });

    let cursorP2: number;
    await t.step("capture P2 cursor + initiate combat", async () => {
      cursorP2 = await getEventCursor(p2Id);
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    await t.step("P1 destroys P2 in round 1; combat continues vs P3", async () => {
      const state = await resolveOneRound(3, p1Id, p2Id, 400);
      assertEquals(state.ended, false, "Combat should still be active vs P3");
      const participants = state.participants as Record<
        string,
        { fighters: number; destruction_handled?: boolean; is_escape_pod?: boolean; ship_type?: string }
      >;
      const p2Entry = participants[p2Id];
      assertExists(p2Entry, "P2 must remain in encounter.participants");
      assertEquals(p2Entry.fighters, 0);
      assertEquals(p2Entry.destruction_handled, true);
      assertEquals(p2Entry.is_escape_pod, true);
      assertEquals(p2Entry.ship_type, "escape_pod");
    });

    await t.step("ship_instances reflects escape-pod conversion", async () => {
      const ship = await queryShip(p2ShipId);
      assertExists(ship);
      assertEquals(ship.ship_type, "escape_pod");
      assertEquals(ship.is_escape_pod, true);
      assertEquals(ship.current_fighters, 0);
      assertEquals(ship.current_shields, 0);
      assertEquals(ship.cargo_qf, 0, "Cargo zeroed by escape-pod conversion");
      assertEquals(ship.credits, 0);
    });

    await t.step("P2 receives a personalized combat.ended event", async () => {
      const events = await eventsOfType(p2Id, "combat.ended", cursorP2);
      assert(
        events.length >= 1,
        `Expected combat.ended for destroyed P2, got ${events.length}`,
      );
      const result = String(
        events[events.length - 1].payload.result ?? "",
      ).toLowerCase();
      assert(
        result.includes("destroyed"),
        `combat.ended.result should mention destruction, got: ${result}`,
      );
    });

    await t.step("salvage NOT yet in sector (deferred to combat end)", async () => {
      const salvage = await querySectorSalvage(3);
      assertEquals(
        salvage.length,
        0,
        "Salvage must not drop mid-combat — passer-by could otherwise loot",
      );
      const state = await queryCombatState(3);
      const pending = (state as Record<string, unknown>)
        ?.pending_salvage_entries as unknown[] | undefined;
      assert(
        Array.isArray(pending) && pending.length >= 1,
        "Salvage entry must be captured onto encounter.pending_salvage_entries",
      );
    });

    await t.step("destroyed P2 cannot act in combat", async () => {
      const combatId = (await queryCombatState(3)) as Record<string, unknown>;
      const result = await api("combat_action", {
        character_id: p2Id,
        combat_id: combatId.combat_id,
        action: "attack",
        target_id: p1Id,
        commit: 1,
      });
      assertEquals(result.status, 410, "Destroyed player should be 410 Gone");
    });

    await t.step("P1 cannot target destroyed P2", async () => {
      const combatId = (await queryCombatState(3)) as Record<string, unknown>;
      const result = await api("combat_action", {
        character_id: p1Id,
        combat_id: combatId.combat_id,
        action: "attack",
        target_id: p2Id,
        commit: 50,
      });
      assertEquals(
        result.status,
        400,
        "Targeting a destroyed participant should fail validation",
      );
    });

    await t.step("destroyed P2 can move (combat gate sees them as out)", async () => {
      // Adjacencies for sector 3 include sector 1, 4, 7 in the test universe.
      const result = await api("move", {
        character_id: p2Id,
        sector: 1,
      });
      assert(
        result.status !== 409,
        `move should not be blocked for destroyed player; got ${result.status}: ${JSON.stringify(result.body)}`,
      );
    });
  },
});

Deno.test({
  name:
    "combat_eject — corp ship destroyed mid-combat is fully cleaned up immediately",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;
    let pseudoCharId: string;

    await t.step("reset and set up 3-way combat with weak corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 400);
      // P2 is sturdy so combat continues after the corp ship dies.
      await setShipFighters(p2ShipId, 250);
      await setShipShields(p2ShipId, 200);

      await setShipCredits(p2ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p2Id,
        name: "Eject Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const ship = await createCorpShip(corpId, 3, "Fragile Eject Scout");
      corpShipId = ship.shipId;
      pseudoCharId = ship.pseudoCharacterId;
      await setShipFighters(corpShipId, 3);
    });

    await t.step("initiate combat (auto-pulls P2 + corp ship)", async () => {
      await apiOk("combat_initiate", { character_id: p1Id });
    });

    await t.step("P1 destroys corp ship in round 1; combat continues", async () => {
      const state = await resolveOneRound(3, p1Id, corpShipId, 400);
      assertEquals(state.ended, false, "P2 still alive — combat continues");
      const participants = state.participants as Record<
        string,
        { fighters: number; destruction_handled?: boolean }
      >;
      const corpEntry = participants[corpShipId];
      assertExists(
        corpEntry,
        "Corp ship participant must remain in encounter for narrative continuity",
      );
      assertEquals(corpEntry.destruction_handled, true);
      assertEquals(corpEntry.fighters, 0);
    });

    await t.step(
      "corporation_ships row deleted immediately, NOT at end of combat",
      async () => {
        await withPg(async (pg) => {
          const result = await pg.queryObject(
            `SELECT * FROM corporation_ships WHERE ship_id = $1`,
            [corpShipId],
          );
          assertEquals(
            result.rows.length,
            0,
            "corporation_ships row must be deleted by ejectDestroyedFromCombat",
          );
        });
      },
    );

    await t.step("ship_instances has destroyed_at set", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship);
      assertExists(ship.destroyed_at);
      assertEquals(ship.current_fighters, 0);
    });

    await t.step("pseudo-character is unlinked or deleted", async () => {
      await withPg(async (pg) => {
        const result = await pg.queryObject<{ current_ship_id: string | null }>(
          `SELECT current_ship_id FROM characters WHERE character_id = $1`,
          [pseudoCharId],
        );
        if (result.rows.length > 0) {
          assertEquals(result.rows[0].current_ship_id, null);
        }
        // Otherwise the row was hard-deleted; that's also fine.
      });
    });

    await t.step("encounter.pending_corp_ship_deletions is empty", async () => {
      const state = await queryCombatState(3);
      const pending = (state as Record<string, unknown>)
        ?.pending_corp_ship_deletions as unknown[] | undefined;
      assertEquals(
        Array.isArray(pending) ? pending.length : 0,
        0,
        "corp deletion queue should be drained as the ship is ejected",
      );
    });
  },
});

Deno.test({
  name:
    "combat_eject — captured salvage drops to sector only when combat ends",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup 3-way combat with cargo on P2", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipSector(p3ShipId, 3);
      await setShipFighters(p1ShipId, 400);
      await setShipFighters(p2ShipId, 5);
      await setShipFighters(p3ShipId, 30);
      await setShipCargo(p2ShipId, { qf: 50, ro: 30 });
      await setShipCredits(p2ShipId, 500);
    });

    let cursorP1: number;
    await t.step("initiate, kill P2 in round 1", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await apiOk("combat_initiate", { character_id: p1Id });
      await resolveOneRound(3, p1Id, p2Id, 400);
    });

    await t.step("salvage absent from sector after round 1", async () => {
      const salvage = await querySectorSalvage(3);
      assertEquals(salvage.length, 0);
      const events = await eventsOfType(p1Id, "salvage.created", cursorP1);
      assertEquals(
        events.length,
        0,
        "salvage.created must not fire mid-combat",
      );
    });

    await t.step("finish combat by destroying P3", async () => {
      // Drive remaining rounds until combat ends.
      for (let i = 0; i < 6; i++) {
        const state = await queryCombatState(3);
        if (!state || (state as Record<string, unknown>).ended === true) break;
        await resolveOneRound(3, p1Id, p3Id, 400);
      }
    });

    await t.step("salvage now present, salvage.created fired", async () => {
      const salvage = await querySectorSalvage(3);
      assert(salvage.length >= 1, `Expected salvage at combat end, got ${salvage.length}`);
      const events = await eventsOfType(p1Id, "salvage.created", cursorP1);
      assert(
        events.length >= 1,
        `Expected salvage.created at combat end, got ${events.length}`,
      );
    });
  },
});
