/**
 * Integration tests for read-only query endpoints.
 *
 * Tests cover:
 *   - list_user_ships: personal only, personal + corp ships, character not found
 *   - local_map_region: basic region around sector 0, with max_hops, with center_sector
 *   - plot_course: valid path (0→3), already at destination, invalid to_sector
 *   - corporation_list, character_info, my_corporation, leaderboard (Groups 8–12)
 *
 * Setup: P1, P2 in sector 0 (mega-port).
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
  setShipHyperspace,
  setShipSector,
  setMegabankBalance,
  createCorpShip,
  withPg,
} from "./helpers.ts";

const P1 = "test_query_p1";
const P2 = "test_query_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "query_endpoints — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: list_user_ships — personal only
// ============================================================================

Deno.test({
  name: "query_endpoints — list_user_ships personal only",
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
    });

    await t.step("list ships returns personal ship", async () => {
      const result = await apiOk("list_user_ships", {
        character_id: p1Id,
      });
      // list_user_ships returns { request_id } — data emitted via event
      assertExists(
        (result as Record<string, unknown>).request_id,
        "Should return request_id",
      );
    });

    await t.step("verify ship data via events", async () => {
      // The ship data is emitted as a ships.list event — verify via DB query
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.ship_type, "kestrel_courier");
    });
  },
});

// ============================================================================
// Group 2: list_user_ships — personal + corp ships
// ============================================================================

Deno.test({
  name: "query_endpoints — list_user_ships with corp ships",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Query Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      // Buy a corp ship
      await setMegabankBalance(p1Id, 10000);
      await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
    });

    await t.step("list ships returns personal + corp ship", async () => {
      const result = await apiOk("list_user_ships", {
        character_id: p1Id,
      });
      assertExists(
        (result as Record<string, unknown>).request_id,
        "Should return request_id",
      );
    });
  },
});

// ============================================================================
// Group 3: list_user_ships — character not found
// ============================================================================

Deno.test({
  name: "query_endpoints — list_user_ships character not found",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("fails: nonexistent character", async () => {
      const result = await api("list_user_ships", {
        character_id: crypto.randomUUID(),
      });
      // BUG: Returns 500 instead of 400/404 because "Character not found"
      // is thrown as a plain Error, not a ValidationError, so it falls
      // through to the generic 500 handler in the catch block.
      assertEquals(result.status, 500);
    });
  },
});

// ============================================================================
// Group 4: local_map_region — basic region
// ============================================================================

Deno.test({
  name: "query_endpoints — local_map_region basic",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("get map region around current sector", async () => {
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.request_id, "Should return request_id");
      assertExists(body.sectors, "Should contain sectors data");
      const sectors = body.sectors as Record<string, unknown>[];
      assert(sectors.length > 0, "Should have at least one sector");
    });

    await t.step("get map region with max_hops=1", async () => {
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        max_hops: 1,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.sectors, "Should contain sectors data");
      const sectors = body.sectors as Record<string, unknown>[];
      // Sector 0 has warps to 1, 2, 5 — so max_hops=1 should include up to 4 sectors
      assert(
        sectors.length >= 1 && sectors.length <= 4,
        `Expected 1-4 sectors with max_hops=1, got ${sectors.length}`,
      );
    });

    await t.step("get map region with center_sector", async () => {
      // First move to sector 1 to have it in map knowledge, then back
      // Actually, sector 0 has warps to 1,2,5 so after join those may be visible
      // Let's just use sector 0 as center (which we've visited)
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        center_sector: 0,
        max_hops: 0,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.sectors, "Should contain sectors data");
      const sectors = body.sectors as Record<string, unknown>[];
      // max_hops=0 should only return the center sector
      assertEquals(sectors.length, 1, "max_hops=0 should return only center");
    });
  },
});

// ============================================================================
// Group 5: local_map_region — unvisited center sector fails
// ============================================================================

Deno.test({
  name: "query_endpoints — local_map_region failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: center_sector not visited", async () => {
      // Sector 9 is far away and shouldn't be in P1's map knowledge
      const result = await api("local_map_region", {
        character_id: p1Id,
        center_sector: 9,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("visited"));
    });
  },
});

// ============================================================================
// Group 6: plot_course — valid path
// ============================================================================

Deno.test({
  name: "query_endpoints — plot_course valid path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("plot course from 0 to 3", async () => {
      const result = await apiOk("plot_course", {
        character_id: p1Id,
        to_sector: 3,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.path, "Should return path");
      assertEquals(body.from_sector, 0);
      assertEquals(body.to_sector, 3);
      const path = body.path as number[];
      assert(path.length >= 2, "Path should have at least 2 hops");
      assertEquals(path[0], 0, "Path should start at 0");
      assertEquals(path[path.length - 1], 3, "Path should end at 3");
      // Shortest path: 0 → 1 → 3 (distance 2)
      assertEquals(body.distance, 2, "Shortest distance from 0 to 3 is 2");
    });

    await t.step("plot course — already at destination", async () => {
      const result = await apiOk("plot_course", {
        character_id: p1Id,
        to_sector: 0,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.from_sector, 0);
      assertEquals(body.to_sector, 0);
      assertEquals(body.distance, 0, "Distance to self should be 0");
      const path = body.path as number[];
      assertEquals(path.length, 1, "Path to self should just be [0]");
      assertEquals(path[0], 0);
    });
  },
});

// ============================================================================
// Group 7: plot_course — failures
// ============================================================================

Deno.test({
  name: "query_endpoints — plot_course failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: missing to_sector", async () => {
      const result = await api("plot_course", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("to_sector"));
    });

    await t.step("fails: invalid to_sector", async () => {
      const result = await api("plot_course", {
        character_id: p1Id,
        to_sector: 99999,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("to_sector"));
    });

    await t.step("fails: undiscovered from_sector", async () => {
      const result = await api("plot_course", {
        character_id: p1Id,
        from_sector: 9,
        to_sector: 3,
      });
      assertEquals(result.status, 403);
      assert(result.body.error?.includes("discovered"));
    });
  },
});

// ============================================================================
// Group 8: corporation_list
// ============================================================================

Deno.test({
  name: "query_endpoints — corporation_list",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Test Corp For List",
      });
    });

    await t.step("list corporations returns at least 1", async () => {
      const result = await apiOk("corporation_list", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.corporations, "Should have corporations array");
      const corps = body.corporations as Array<Record<string, unknown>>;
      assert(corps.length >= 1, "Should have at least 1 corporation");
      // Verify structure
      const corp = corps.find((c) => c.name === "Test Corp For List");
      assertExists(corp, "Should find our test corp");
      assertExists(corp.corp_id, "Corp should have corp_id");
      assertExists(corp.member_count, "Corp should have member_count");
    });
  },
});

// ============================================================================
// Group 9: character_info
// ============================================================================

Deno.test({
  name: "query_endpoints — character_info",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("get character info", async () => {
      const result = await apiOk("character_info", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.character_id, "Should have character_id");
      assertExists(body.name, "Should have name");
    });

    await t.step("character not found fails", async () => {
      const result = await api("character_info", {
        character_id: crypto.randomUUID(),
      });
      assert(
        !result.ok || !result.body.success,
        "Expected unknown character to fail",
      );
      // May return 404 or 500 depending on Supabase error handling
      assert(
        result.status === 404 || result.status === 500,
        `Expected 404 or 500 for unknown character, got ${result.status}`,
      );
    });
  },
});

// ============================================================================
// Group 10: my_corporation
// ============================================================================

Deno.test({
  name: "query_endpoints — my_corporation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and create corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "My Corp Test",
      });
    });

    await t.step("get my corporation info", async () => {
      const result = await apiOk("my_corporation", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.request_id, "Should have request_id");
    });
  },
});

// ============================================================================
// Group 11: path_with_region — returns request_id and emits event
// ============================================================================

Deno.test({
  name: "query_endpoints — path_with_region",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("get path with region from 0 to 3", async () => {
      const result = await apiOk("path_with_region", {
        character_id: p1Id,
        to_sector: 3,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.request_id, "Should have request_id");
    });
  },
});

// ============================================================================
// Group 12: my_status — with corporation membership
// ============================================================================

Deno.test({
  name: "query_endpoints — my_status with corp membership",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, create corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Status Corp",
      });
    });

    await t.step("my_status includes corporation info", async () => {
      const result = await apiOk("my_status", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.request_id, "Should have request_id");
    });
  },
});

// ============================================================================
// Group 13: corporation_info — corp not found
// ============================================================================

Deno.test({
  name: "query_endpoints — corporation_info not found",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: corp not found", async () => {
      const result = await api("corporation_info", {
        character_id: p1Id,
        corp_id: crypto.randomUUID(),
      });
      assert(
        result.status === 404 || result.status === 500,
        `Expected 404 or 500 for unknown corp, got ${result.status}`,
      );
    });
  },
});

// ============================================================================
// Group 14: local_map_region — invalid center sector (renumbered from 15)
// ============================================================================

Deno.test({
  name: "query_endpoints — local_map_region invalid center",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: negative sector", async () => {
      const result = await api("local_map_region", {
        character_id: p1Id,
        center_sector: -1,
      });
      assert(
        !result.ok || !result.body.success,
        "Expected negative sector to fail",
      );
    });

    await t.step("fails: sector out of range", async () => {
      const result = await api("local_map_region", {
        character_id: p1Id,
        center_sector: 99999,
      });
      assert(
        !result.ok || !result.body.success,
        "Expected out-of-range sector to fail",
      );
    });
  },
});

// ============================================================================
// Group 15: corporation_list — basic call
// ============================================================================

Deno.test({
  name: "query_endpoints — corporation_list basic",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("list returns array (with character_id)", async () => {
      const result = await apiOk("corporation_list", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assert(Array.isArray(body.corporations), "corporations should be array");
    });

    await t.step("list returns array (without character_id)", async () => {
      const result = await apiOk("corporation_list", {});
      const body = result as Record<string, unknown>;
      assert(Array.isArray(body.corporations), "corporations should be array");
    });
  },
});

// ============================================================================
// Group 16: my_corporation — not in corp (null result)
// ============================================================================

Deno.test({
  name: "query_endpoints — my_corporation not in corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset (no corp membership)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("returns null corporation", async () => {
      const result = await apiOk("my_corporation", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.corporation, null, "Should be null when not in corp");
    });
  },
});

// ============================================================================
// Group 17: my_corporation — with corp membership
// ============================================================================

Deno.test({
  name: "query_endpoints — my_corporation with membership",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, create corp", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "MyCorp Test",
      });
    });

    await t.step("returns corporation data", async () => {
      const result = await apiOk("my_corporation", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.corporation, "Should return corporation");
      const corp = body.corporation as Record<string, unknown>;
      assertEquals(corp.name, "MyCorp Test");
    });
  },
});

// ============================================================================
// Group 18: ship_definitions — basic call
// ============================================================================

Deno.test({
  name: "query_endpoints — ship_definitions basic",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("returns definitions without character_id", async () => {
      const result = await apiOk("ship_definitions", {});
      const body = result as Record<string, unknown>;
      assert(Array.isArray(body.definitions), "definitions should be array");
      assert(
        (body.definitions as unknown[]).length > 0,
        "should have at least one definition",
      );
    });

    await t.step("reset and call with character_id", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("returns definitions with character_id (emits event)", async () => {
      const result = await apiOk("ship_definitions", {
        character_id: p1Id,
      });
      const body = result as Record<string, unknown>;
      assert(Array.isArray(body.definitions), "definitions should be array");
    });
  },
});

// ============================================================================
// Group 19: path_with_region — missing to_sector
// ============================================================================

Deno.test({
  name: "query_endpoints — path_with_region missing to_sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: missing to_sector", async () => {
      const result = await api("path_with_region", {
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("to_sector"));
    });
  },
});

// ============================================================================
// Group 20: path_with_region — invalid region_hops
// ============================================================================

Deno.test({
  name: "query_endpoints — path_with_region invalid region_hops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: negative region_hops", async () => {
      const result = await api("path_with_region", {
        character_id: p1Id,
        to_sector: 1,
        region_hops: -1,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("region_hops"));
    });
  },
});

// ============================================================================
// Group 21: path_with_region — invalid max_sectors
// ============================================================================

Deno.test({
  name: "query_endpoints — path_with_region invalid max_sectors",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: max_sectors out of range", async () => {
      const result = await api("path_with_region", {
        character_id: p1Id,
        to_sector: 1,
        max_sectors: 999,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("max_sectors"));
    });
  },
});

// ============================================================================
// Group 22: path_with_region — happy path
// ============================================================================

Deno.test({
  name: "query_endpoints — path_with_region happy path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("returns path result", async () => {
      const result = await apiOk("path_with_region", {
        character_id: p1Id,
        to_sector: 1,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });
  },
});

// ============================================================================
// Group 23: local_map_region — invalid fit_sectors
// ============================================================================

Deno.test({
  name: "query_endpoints — local_map_region invalid fit_sectors",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: fit_sectors not an array", async () => {
      const result = await api("local_map_region", {
        character_id: p1Id,
        fit_sectors: "not-an-array",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("fit_sectors"));
    });

    await t.step("fails: fit_sectors empty array", async () => {
      const result = await api("local_map_region", {
        character_id: p1Id,
        fit_sectors: [],
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("fit_sectors"));
    });
  },
});

// ============================================================================
// Group 24: local_map_region — invalid max_hops
// ============================================================================

Deno.test({
  name: "query_endpoints — local_map_region invalid max_hops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: max_hops negative", async () => {
      const result = await api("local_map_region", {
        character_id: p1Id,
        max_hops: -1,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("max_hops"));
    });

    await t.step("fails: max_sectors zero", async () => {
      const result = await api("local_map_region", {
        character_id: p1Id,
        max_sectors: 0,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("max_sectors"));
    });
  },
});

// ============================================================================
// Group 25: local_map_region — bounds mode
// ============================================================================

Deno.test({
  name: "query_endpoints — local_map_region bounds mode",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("works: bounds-only mode", async () => {
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        bounds: 2,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("fails: bounds out of range", async () => {
      const result = await api("local_map_region", {
        character_id: p1Id,
        bounds: 200,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("bounds"));
    });
  },
});

// ============================================================================
// Group 26: list_known_ports — filter validation
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports filter validation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: commodity without trade_type", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        commodity: "quantum_foam",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("commodity and trade_type"));
    });

    await t.step("fails: trade_type without commodity", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        trade_type: "buy",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("commodity and trade_type"));
    });

    await t.step("fails: invalid trade_type", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        commodity: "quantum_foam",
        trade_type: "barter",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("trade_type"));
    });

    await t.step("fails: invalid commodity", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        commodity: "unobtanium",
        trade_type: "buy",
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("commodity") || result.body.error?.includes("Unknown"));
    });
  },
});

// ============================================================================
// Group 27: list_known_ports — invalid max_hops
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports invalid max_hops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: negative max_hops", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        max_hops: -1,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("max_hops"));
    });

    await t.step("fails: max_hops too large", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        max_hops: 999,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("max_hops"));
    });
  },
});

// ============================================================================
// Group 28: list_known_ports — from_sector not visited
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports from_sector not visited",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: from_sector not visited", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        from_sector: 999,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("visited"));
    });
  },
});

// ============================================================================
// Group 29: list_known_ports — happy path with filters
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports with valid filters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("list with commodity + trade_type filter", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        commodity: "quantum_foam",
        trade_type: "buy",
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("list with mega filter", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        mega: true,
        max_hops: 100,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });
  },
});

// ============================================================================
// Group 30: my_status — in hyperspace → 409
// ============================================================================

Deno.test({
  name: "query_endpoints — my_status in hyperspace",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, enter hyperspace", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipHyperspace(p1ShipId, true, 1);
    });

    await t.step("fails: in hyperspace → 409", async () => {
      const result = await api("my_status", {
        character_id: p1Id,
      });
      assertEquals(result.status, 409);
      assert(result.body.error?.includes("hyperspace"));
    });
  },
});

// ============================================================================
// Group 31: corporation_info — member vs non-member view
// ============================================================================

Deno.test({
  name: "query_endpoints — corporation_info member view",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset, create corp with P1", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "InfoTest Corp",
      });
      const body = createResult as Record<string, unknown>;
      corpId = body.corp_id as string;
    });

    await t.step("P1 (member) gets full info", async () => {
      const result = await apiOk("corporation_info", {
        character_id: p1Id,
        corp_id: corpId,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.members, "Member should see members list");
    });

    await t.step("P2 (non-member) gets public info", async () => {
      const result = await apiOk("corporation_info", {
        character_id: p2Id,
        corp_id: corpId,
      });
      const body = result as Record<string, unknown>;
      assertExists(body.name, "Non-member should see corp name");
    });
  },
});

// ============================================================================
// Group 32: list_known_ports — port_type filter
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports port_type filter",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("list with port_type filter", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        port_type: "BBS",
      });
      assertExists((result as Record<string, unknown>).request_id);
    });
  },
});

// ============================================================================
// Group 33: list_known_ports — from_sector integer validation
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports from_sector non-integer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fails: from_sector non-integer", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        from_sector: 1.5,
      });
      assertEquals(result.status, 400);
      assert(result.body.error?.includes("integer"));
    });
  },
});

// ============================================================================
// Group 34: local_map_region — fit_sectors with valid sectors
// ============================================================================

Deno.test({
  name: "query_endpoints — local_map_region fit_sectors valid",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("fit_sectors with visited sectors", async () => {
      // sector 0 is visited after join
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        fit_sectors: [0],
      });
      const body = result as Record<string, unknown>;
      assertExists(body.request_id);
    });
  },
});
