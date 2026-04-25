/**
 * Integration tests for unowned_ship_collect.
 *
 * Tests cover:
 *   - Happy path: full drain transfers cargo + credits, marks target destroyed
 *   - Partial: limited cargo space leaves leftover cargo on target, credits still drained
 *   - Failures: not in same sector, occupied ship, escape pod, in hyperspace,
 *     own-ship rejection, missing ship_id
 *
 * Setup: P1 in sector 3 (non-FedSpace). Unowned ships are inserted directly
 * via withPg as ship_instances rows with owner_type='unowned' and no
 * character pointing at them.
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
  setShipCargo,
  setShipCredits,
  setShipHyperspace,
  setShipSector,
  setShipType,
  withPg,
} from "./helpers.ts";

const P1 = "test_unowned_p1";
const P2 = "test_unowned_p2";

let p1Id: string;
let p1ShipId: string;
let p2Id: string;
let p2ShipId: string;

// ----------------------------------------------------------------------------
// Helper: insert an unowned ship row into a sector for testing.
// ----------------------------------------------------------------------------
async function insertUnownedShip(params: {
  sectorId: number;
  shipType?: string;
  shipName?: string;
  formerOwnerName?: string;
  cargo?: { qf?: number; ro?: number; ns?: number };
  credits?: number;
}): Promise<string> {
  const shipId = crypto.randomUUID();
  await withPg(async (pg) => {
    await pg.queryObject(
      `INSERT INTO ship_instances (
        ship_id, owner_id, owner_type, owner_character_id, owner_corporation_id,
        ship_type, ship_name, current_sector, in_hyperspace,
        credits, cargo_qf, cargo_ro, cargo_ns,
        current_warp_power, current_shields, current_fighters,
        former_owner_name, became_unowned, metadata
      ) VALUES (
        $1, NULL, 'unowned', NULL, NULL,
        $2, $3, $4, false,
        $5, $6, $7, $8,
        100, 50, 0,
        $9, NOW(), '{}'::jsonb
      )`,
      [
        shipId,
        params.shipType ?? "kestrel_courier",
        params.shipName ?? "Derelict Hauler",
        params.sectorId,
        params.credits ?? 0,
        params.cargo?.qf ?? 0,
        params.cargo?.ro ?? 0,
        params.cargo?.ns ?? 0,
        params.formerOwnerName ?? "Captain Nobody",
      ],
    );
  });
  return shipId;
}

async function shipExistsAndAlive(shipId: string): Promise<boolean> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ destroyed_at: unknown }>(
      `SELECT destroyed_at FROM ship_instances WHERE ship_id = $1`,
      [shipId],
    );
    if (result.rows.length === 0) return false;
    return result.rows[0].destroyed_at === null;
  });
}

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "unowned_ship — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Full drain marks target destroyed
// ============================================================================

Deno.test({
  name: "unowned_ship_collect — full drain transfers all and destroys target",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let targetId: string;

    await t.step("resolve IDs and reset", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 0, ro: 0, ns: 0 });
      await setShipCredits(p1ShipId, 100);
    });

    await t.step("insert unowned ship in same sector", async () => {
      targetId = await insertUnownedShip({
        sectorId: 3,
        cargo: { qf: 5, ro: 3, ns: 0 },
        credits: 250,
      });
    });

    await t.step("collect", async () => {
      const result = await apiOk<Record<string, unknown>>(
        "unowned_ship_collect",
        { character_id: p1Id, ship_id: targetId },
      );
      assertEquals(result.fully_collected, true);
      const collected = result.collected as Record<string, unknown>;
      assertEquals(collected.credits, 250);
      const cargo = collected.cargo as Record<string, number>;
      assertEquals(cargo.quantum_foam, 5);
      assertEquals(cargo.retro_organics, 3);
    });

    await t.step("DB: cargo + credits added to P1", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.cargo_qf, 5);
      assertEquals(ship.cargo_ro, 3);
      assertEquals(ship.credits, 350, "100 + 250 = 350");
    });

    await t.step("DB: target ship marked destroyed", async () => {
      const alive = await shipExistsAndAlive(targetId);
      assertEquals(alive, false, "Target should be soft-deleted via destroyed_at");
    });
  },
});

// ============================================================================
// Group 2: Partial drain leaves cargo on target, ship survives
// ============================================================================

Deno.test({
  name: "unowned_ship_collect — partial: leftover cargo stays, credits drained",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let targetId: string;

    await t.step("reset and prefill P1 hold close to capacity", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      // kestrel_courier default starting hold is small; fill it nearly full
      // so partial collection is forced. We assume cargo_holds >= 12 in
      // fixtures; we leave 2 free slots.
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // Look up cargo capacity directly to keep the test resilient to
      // fixture changes.
      const def = await withPg(async (pg) => {
        const r = await pg.queryObject<{ cargo_holds: number }>(
          `SELECT cargo_holds FROM ship_definitions WHERE ship_type = $1`,
          [ship.ship_type],
        );
        return r.rows[0];
      });
      const cap = def.cargo_holds;
      // Leave exactly 2 free slots on P1's ship.
      await setShipCargo(p1ShipId, { qf: cap - 2, ro: 0, ns: 0 });
      await setShipCredits(p1ShipId, 0);
    });

    await t.step("insert unowned ship with 5 qf + 100 credits", async () => {
      targetId = await insertUnownedShip({
        sectorId: 3,
        cargo: { qf: 5, ro: 0, ns: 0 },
        credits: 100,
      });
    });

    await t.step("collect — only 2 qf fits", async () => {
      const result = await apiOk<Record<string, unknown>>(
        "unowned_ship_collect",
        { character_id: p1Id, ship_id: targetId },
      );
      assertEquals(result.fully_collected, false);
      const collected = result.collected as Record<string, unknown>;
      assertEquals(collected.credits, 100);
      const collectedCargo = collected.cargo as Record<string, number>;
      assertEquals(collectedCargo.quantum_foam, 2);
      const remaining = result.remaining as Record<string, unknown>;
      const remainingCargo = remaining.cargo as Record<string, number>;
      assertEquals(remainingCargo.quantum_foam, 3);
    });

    await t.step("DB: target keeps leftover cargo, credits zeroed, NOT destroyed", async () => {
      const target = await queryShip(targetId);
      assertExists(target);
      assertEquals(target.cargo_qf, 3, "5 - 2 = 3 left on target");
      assertEquals(target.credits, 0);
      assertEquals(target.destroyed_at, null);
    });
  },
});

// ============================================================================
// Group 3: Failure cases
// ============================================================================

Deno.test({
  name: "unowned_ship_collect — failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p2Id = await characterIdFor(P2);
    p2ShipId = await shipIdFor(P2);

    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
    });

    await t.step("fails: target ship not in same sector", async () => {
      const targetId = await insertUnownedShip({
        sectorId: 4,
        cargo: { qf: 1 },
      });
      const result = await api("unowned_ship_collect", {
        character_id: p1Id,
        ship_id: targetId,
      });
      assertEquals(result.status, 404);
      assert(
        (result.body.error ?? "").toLowerCase().includes("not in this sector"),
        `Unexpected error: ${result.body.error}`,
      );
    });

    await t.step("fails: target ship is occupied (P2 is in it)", async () => {
      // P2 is in sector 3 already, so P2's ship is "occupied" by P2.
      const result = await api("unowned_ship_collect", {
        character_id: p1Id,
        ship_id: p2ShipId,
      });
      assertEquals(result.status, 409);
      assert(
        (result.body.error ?? "").toLowerCase().includes("occupied"),
        `Unexpected error: ${result.body.error}`,
      );
    });

    await t.step("fails: cannot collect own ship", async () => {
      const result = await api("unowned_ship_collect", {
        character_id: p1Id,
        ship_id: p1ShipId,
      });
      assertEquals(result.status, 400);
      assert(
        (result.body.error ?? "").toLowerCase().includes("own ship"),
        `Unexpected error: ${result.body.error}`,
      );
    });

    await t.step("fails: escape pod cannot collect", async () => {
      const targetId = await insertUnownedShip({
        sectorId: 3,
        cargo: { qf: 1 },
      });
      await setShipType(p1ShipId, "escape_pod");
      const result = await api("unowned_ship_collect", {
        character_id: p1Id,
        ship_id: targetId,
      });
      assertEquals(result.status, 400);
      assert((result.body.error ?? "").toLowerCase().includes("escape pod"));
      await setShipType(p1ShipId, "kestrel_courier");
    });

    await t.step("fails: collector in hyperspace", async () => {
      const targetId = await insertUnownedShip({
        sectorId: 3,
        cargo: { qf: 1 },
      });
      await setShipHyperspace(p1ShipId, true, 4);
      const result = await api("unowned_ship_collect", {
        character_id: p1Id,
        ship_id: targetId,
      });
      assertEquals(result.status, 400);
      assert((result.body.error ?? "").toLowerCase().includes("hyperspace"));
      await setShipHyperspace(p1ShipId, false);
      await setShipSector(p1ShipId, 3);
    });

    await t.step("fails: missing ship_id", async () => {
      const result = await api("unowned_ship_collect", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
    });

    await t.step("fails: ship_id refers to a ship that does not exist", async () => {
      const result = await api("unowned_ship_collect", {
        character_id: p1Id,
        ship_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 404);
      assert(
        (result.body.error ?? "").toLowerCase().includes("not found"),
        `Unexpected error: ${result.body.error}`,
      );
    });
  },
});
