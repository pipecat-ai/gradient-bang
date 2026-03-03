/**
 * Integration tests for dump_cargo, salvage_collect, and my_status hyperspace recovery.
 *
 * Tests cover:
 *   - dump_cargo: creates salvage entry, partial dump clamping, array-format items
 *   - dump_cargo fails: in hyperspace, in combat, invalid commodity
 *   - salvage_collect: full collection (salvage removed), credits always collected
 *   - salvage_collect: scrap converts to neuro_symbolics
 *   - salvage_collect fails: escape pod, salvage not found
 *   - my_status: hyperspace recovery when stuck, 409 when legitimately in hyperspace
 *
 * Setup: P1, P2 in sector 3 (non-FedSpace).
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
  setShipFighters,
  setShipSector,
  setShipHyperspace,
  setShipType,
  querySectorSalvage,
  insertSalvageEntry,
  withPg,
} from "./helpers.ts";

const P1 = "test_salvage_p1";
const P2 = "test_salvage_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "salvage_economy — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: dump_cargo happy path
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo creates salvage entry",
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
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 50, ro: 30, ns: 20 });
    });

    await t.step("dump quantum_foam and retro_organics", async () => {
      const result = await apiOk("dump_cargo", {
        character_id: p1Id,
        items: {
          quantum_foam: 20,
          retro_organics: 10,
        },
      });
      assertExists(result, "Dump should succeed");
    });

    await t.step("DB: salvage created in sector 3", async () => {
      const salvage = await querySectorSalvage(3);
      assert(salvage.length >= 1, `Expected salvage, got ${salvage.length}`);
      const entry = salvage[salvage.length - 1] as Record<string, unknown>;
      assertExists(entry.salvage_id, "Should have salvage_id");
      const cargo = entry.cargo as Record<string, number>;
      assertEquals(cargo.quantum_foam, 20);
      assertEquals(cargo.retro_organics, 10);
    });

    await t.step("DB: P1 cargo reduced", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.cargo_qf, 30, "50 - 20 = 30");
      assertEquals(ship.cargo_ro, 20, "30 - 10 = 20");
      assertEquals(ship.cargo_ns, 20, "NS unchanged");
    });
  },
});

// ============================================================================
// Group 2: dump_cargo partial clamping and array format
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo clamps to available and supports array format",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 5 });
    });

    await t.step("dump more than available (clamped)", async () => {
      const result = await apiOk("dump_cargo", {
        character_id: p1Id,
        items: {
          quantum_foam: 999, // only have 10
        },
      });
      assertExists(result);
    });

    await t.step("DB: only 10 QF dumped", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.cargo_qf, 0, "All QF should be dumped");
    });

    await t.step("DB: salvage has clamped amount", async () => {
      const salvage = await querySectorSalvage(3);
      const entry = salvage[salvage.length - 1] as Record<string, unknown>;
      const cargo = entry.cargo as Record<string, number>;
      assertEquals(cargo.quantum_foam, 10, "Should have 10, not 999");
    });

    await t.step("reset for array test", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 15, ro: 0, ns: 0 });
    });

    await t.step("dump with array-format items", async () => {
      const result = await apiOk("dump_cargo", {
        character_id: p1Id,
        items: [
          { commodity: "quantum_foam", units: 5 },
        ],
      });
      assertExists(result);
    });

    await t.step("DB: array dump worked", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.cargo_qf, 10, "15 - 5 = 10");
    });
  },
});

// ============================================================================
// Group 3: dump_cargo failure cases
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 0 });
    });

    await t.step("fails: in hyperspace", async () => {
      await setShipHyperspace(p1ShipId, true, 4);
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 5 },
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("hyperspace"));
      await setShipHyperspace(p1ShipId, false);
      await setShipSector(p1ShipId, 3);
    });

    await t.step("fails: in combat", async () => {
      await setShipSector(p2ShipId, 3);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await apiOk("combat_initiate", { character_id: p1Id });

      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 5 },
      });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("combat"));
    });

    await t.step("reset for invalid commodity test", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 0 });
    });

    await t.step("fails: invalid commodity", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: { unobtanium: 5 },
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("Invalid commodity"));
    });
  },
});

// ============================================================================
// Group 4: salvage_collect full collection
// ============================================================================

Deno.test({
  name: "salvage_economy — salvage_collect full collection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let salvageId: string;

    await t.step("reset and insert test salvage", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 0, ro: 0, ns: 0 });
      await setShipCredits(p1ShipId, 100);

      // Insert salvage with cargo and credits
      salvageId = crypto.randomUUID();
      await insertSalvageEntry(3, {
        salvage_id: salvageId,
        cargo: { quantum_foam: 5, retro_organics: 3 },
        scrap: 0,
        credits: 200,
        source_ship_name: "Test Wreck",
        source_ship_type: "kestrel_courier",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    });

    await t.step("collect salvage", async () => {
      const result = await apiOk("salvage_collect", {
        character_id: p1Id,
        salvage_id: salvageId,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.fully_collected, true, "Should be fully collected");
      const collected = body.collected as Record<string, unknown>;
      assertEquals(collected.credits, 200);
    });

    await t.step("DB: cargo transferred to ship", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.cargo_qf, 5);
      assertEquals(ship.cargo_ro, 3);
    });

    await t.step("DB: credits added to ship", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.credits, 300, "100 + 200 = 300");
    });

    await t.step("DB: salvage removed from sector", async () => {
      const salvage = await querySectorSalvage(3);
      const found = salvage.find(
        (s) => (s as Record<string, unknown>).salvage_id === salvageId,
      );
      assertEquals(found, undefined, "Salvage should be removed after full collection");
    });
  },
});

// ============================================================================
// Group 5: salvage_collect scrap converts to NS
// ============================================================================

Deno.test({
  name: "salvage_economy — salvage_collect scrap converts to neuro_symbolics",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let salvageId: string;

    await t.step("reset and insert scrap salvage", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 0, ro: 0, ns: 2 });

      salvageId = crypto.randomUUID();
      await insertSalvageEntry(3, {
        salvage_id: salvageId,
        cargo: {},
        scrap: 8,
        credits: 0,
        source_ship_name: "Scrap Hull",
        source_ship_type: "kestrel_courier",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    });

    await t.step("collect scrap salvage", async () => {
      const result = await apiOk("salvage_collect", {
        character_id: p1Id,
        salvage_id: salvageId,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.fully_collected, true);
    });

    await t.step("DB: scrap converted to neuro_symbolics", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.cargo_ns, 10, "2 existing + 8 scrap = 10 NS");
    });
  },
});

// ============================================================================
// Group 6: salvage_collect failure cases
// ============================================================================

Deno.test({
  name: "salvage_economy — salvage_collect failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
    });

    await t.step("fails: salvage not found", async () => {
      const result = await api("salvage_collect", {
        character_id: p1Id,
        salvage_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 404);
    });

    await t.step("fails: escape pod cannot collect", async () => {
      const salvageId = crypto.randomUUID();
      await insertSalvageEntry(3, {
        salvage_id: salvageId,
        cargo: { quantum_foam: 5 },
        scrap: 0,
        credits: 0,
        source_ship_name: "Test",
        source_ship_type: "kestrel_courier",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      await setShipType(p1ShipId, "escape_pod");
      const result = await api("salvage_collect", {
        character_id: p1Id,
        salvage_id: salvageId,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("Escape pod"));
      await setShipType(p1ShipId, "kestrel_courier");
    });
  },
});

// ============================================================================
// Group 7: my_status hyperspace recovery
// ============================================================================

Deno.test({
  name: "salvage_economy — my_status hyperspace recovery",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("set ship stuck in hyperspace (ETA 30s ago)", async () => {
      // Set hyperspace with ETA in the past (> 20s threshold)
      const pastEta = new Date(Date.now() - 30000).toISOString();
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances
           SET in_hyperspace = true,
               hyperspace_destination = 3,
               hyperspace_eta = $1
           WHERE ship_id = $2`,
          [pastEta, p1ShipId],
        );
      });
    });

    await t.step("my_status triggers recovery", async () => {
      const result = await apiOk("my_status", { character_id: p1Id });
      assertExists(result, "my_status should succeed after recovery");
    });

    await t.step("DB: ship is at destination sector", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.in_hyperspace, false, "Should not be in hyperspace");
      assertEquals(ship.current_sector, 3, "Should be at destination");
    });

    await t.step("legitimately in hyperspace → 409", async () => {
      // Set hyperspace with ETA in the future
      const futureEta = new Date(Date.now() + 60000).toISOString();
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances
           SET in_hyperspace = true,
               hyperspace_destination = 4,
               hyperspace_eta = $1
           WHERE ship_id = $2`,
          [futureEta, p1ShipId],
        );
      });

      const result = await api("my_status", { character_id: p1Id });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 8: dump_cargo — empty manifest
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo empty manifest",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 0 });
    });

    await t.step("fails: empty items object", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: {},
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("No cargo") ||
          result.body.error?.includes("manifest"),
      );
    });

    await t.step("fails: missing items entirely", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("manifest") ||
          result.body.error?.includes("Missing"),
      );
    });
  },
});

// ============================================================================
// Group 9: dump_cargo — non-integer units
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo non-integer units",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 0 });
    });

    await t.step("fails: non-integer units", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 2.5 },
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });

    await t.step("fails: zero units", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 0 },
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("positive integer"));
    });
  },
});

// ============================================================================
// Group 10: dump_cargo — no cargo available
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo no cargo available",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup (empty cargo)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 0, ro: 0, ns: 0 });
    });

    await t.step("fails: no cargo to dump", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 5 },
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("No cargo available"));
    });
  },
});

// ============================================================================
// Group 11: salvage_collect — partial collection (cargo full)
// ============================================================================

Deno.test({
  name: "salvage_economy — salvage_collect partial collection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let salvageId: string;

    await t.step("reset and fill ship cargo near capacity", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      // kestrel_courier has cargo_holds=30
      // Fill with 28 units, leaving only 2 slots
      await setShipCargo(p1ShipId, { qf: 20, ro: 8, ns: 0 });

      salvageId = crypto.randomUUID();
      await insertSalvageEntry(3, {
        salvage_id: salvageId,
        cargo: { quantum_foam: 10 },
        scrap: 0,
        credits: 50,
        source_ship_name: "Partial Wreck",
        source_ship_type: "kestrel_courier",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    });

    await t.step("collect salvage (partial)", async () => {
      const result = await apiOk("salvage_collect", {
        character_id: p1Id,
        salvage_id: salvageId,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.fully_collected, false, "Should be partial collection");
    });

    await t.step("DB: ship cargo increased by available space only", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // Only 2 slots available, so only 2 QF should be collected
      assertEquals(ship.cargo_qf, 22, "20 + 2 = 22");
    });

    await t.step("DB: remaining salvage still in sector", async () => {
      const salvage = await querySectorSalvage(3);
      const found = salvage.find(
        (s) => (s as Record<string, unknown>).salvage_id === salvageId,
      );
      assertExists(found, "Partial salvage should still exist");
      const cargo = (found as Record<string, unknown>).cargo as Record<string, number>;
      assertEquals(cargo.quantum_foam, 8, "10 - 2 = 8 remaining");
    });
  },
});

// ============================================================================
// Group 12: dump_cargo — cargo key alias
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo using cargo key",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and load cargo", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 0 });
    });

    await t.step("dump using 'cargo' key instead of 'items'", async () => {
      const result = await apiOk("dump_cargo", {
        character_id: p1Id,
        cargo: { quantum_foam: 5 },
      });
      assert(result.success);
    });

    await t.step("DB: cargo reduced", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.cargo_qf, 5, "10 - 5 = 5");
    });
  },
});

// ============================================================================
// Group 13: dump_cargo — manifest type validation
// ============================================================================

Deno.test({
  name: "salvage_economy — dump_cargo manifest type validation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);
      await setShipCargo(p1ShipId, { qf: 10, ro: 0, ns: 0 });
    });

    await t.step("fails: items as string", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: "quantum_foam",
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("object") || result.body.error?.includes("list"),
        `Expected manifest type error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: items as number", async () => {
      const result = await api("dump_cargo", {
        character_id: p1Id,
        items: 42,
      });
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 14: salvage_collect — already claimed
// ============================================================================

Deno.test({
  name: "salvage_economy — salvage_collect already claimed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let salvageId: string;

    await t.step("reset and insert pre-claimed salvage", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipSector(p1ShipId, 3);

      salvageId = crypto.randomUUID();
      await insertSalvageEntry(3, {
        salvage_id: salvageId,
        cargo: { quantum_foam: 5 },
        scrap: 0,
        credits: 100,
        source_ship_name: "Claimed Wreck",
        source_ship_type: "kestrel_courier",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        claimed: true,
      });
    });

    await t.step("fails: already claimed", async () => {
      const result = await api("salvage_collect", {
        character_id: p1Id,
        salvage_id: salvageId,
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("claimed") || result.body.error?.includes("Salvage"),
        `Expected already-claimed error, got: ${result.body.error}`,
      );
    });
  },
});
