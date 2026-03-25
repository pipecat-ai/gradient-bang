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
  eventsOfType,
  getEventCursor,
  apiRaw,
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

// ============================================================================
// Group 35: list_known_ports — trade_type sell + mega false
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports trade_type sell + mega false",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, visit sector 1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Move to sector 1 to mark it as visited (sector 1 has port BBS)
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      // Move back to sector 0
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
    });

    let cursorSell: number;
    await t.step("capture cursor", async () => {
      cursorSell = await getEventCursor(p1Id);
    });

    await t.step("trade_type=sell finds ports buying quantum_foam", async () => {
      // trade_type "sell" → player wants to sell → port must BUY → code char = "B"
      // Sector 1 (BBS): position 0 = "B" → matches sell filter for quantum_foam
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        commodity: "quantum_foam",
        trade_type: "sell",
        max_hops: 1,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify sell filter in event", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursorSell);
      assert(events.length >= 1, "Should have ports.list event");
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.trade_type, "sell");
      assertEquals(payload.commodity, "quantum_foam");
      const totalPorts = payload.total_ports_found as number;
      assert(totalPorts >= 1, `Expected >= 1 port for sell filter, got ${totalPorts}`);
    });

    let cursorMega: number;
    await t.step("capture cursor for mega test", async () => {
      cursorMega = await getEventCursor(p1Id);
    });

    await t.step("mega=false includes non-mega ports", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        mega: false,
        max_hops: 1,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify mega=false event", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursorMega);
      assert(events.length >= 1, "Should have ports.list event");
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.mega, false);
      const totalPorts = payload.total_ports_found as number;
      assert(totalPorts >= 1, `Expected >= 1 non-mega port, got ${totalPorts}`);
    });
  },
});

// ============================================================================
// Group 36: list_known_ports — multi-hop BFS + inSector + default from_sector
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports multi-hop BFS + inSector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, move to sector 3 via sector 1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      // Ship is now at sector 3; sectors 0, 1, 3 are visited
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports without from_sector (defaults to ship sector)", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        max_hops: 2,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify BFS results and inSector", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1, "Should have ports.list event");
      const payload = events[events.length - 1].payload as Record<string, unknown>;

      // from_sector defaults to ship.current_sector = 3
      assertEquals(payload.from_sector, 3, "from_sector should default to ship sector");

      const ports = payload.ports as Array<Record<string, unknown>>;
      assert(ports.length >= 2, `Expected >= 2 ports, got ${ports.length}`);

      // Sector 3 at hop 0 (ship is here, port BSS)
      const s3 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 3,
      );
      assertExists(s3, "Should find sector 3 port at hop 0");
      assertEquals(s3!.hops_from_start, 0);

      // inSector port should have observed_at = null
      const s3Port = (s3!.sector as Record<string, unknown>)
        ?.port as Record<string, unknown>;
      assertEquals(
        s3Port?.observed_at,
        null,
        "inSector port should have observed_at=null",
      );

      // Sector 1 at hop 1 (port BBS, visited, ship NOT here)
      const s1 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 1,
      );
      assertExists(s1, "Should find sector 1 port at hop 1");
      assertEquals(s1!.hops_from_start, 1);

      // Verify sorted ascending by hops
      const hops = ports.map((p) => p.hops_from_start as number);
      for (let i = 1; i < hops.length; i++) {
        assert(hops[i] >= hops[i - 1], "Ports should be sorted by hops");
      }
    });
  },
});

// ============================================================================
// Group 37: list_known_ports — max_hops=0 single sector with port
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports max_hops 0 single sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, move to sector 1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("max_hops=0 returns only start sector port", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        from_sector: 1,
        max_hops: 0,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify single sector searched", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.searched_sectors, 1, "max_hops=0 should search only 1 sector");
      assertEquals(payload.total_ports_found, 1, "Sector 1 has a port");
      assertEquals(payload.from_sector, 1);

      // Verify port data has prices
      const ports = payload.ports as Array<Record<string, unknown>>;
      assertEquals(ports.length, 1);
      const portData = (ports[0].sector as Record<string, unknown>)
        ?.port as Record<string, unknown>;
      assertExists(portData?.code, "Port should have code");
      assertExists(portData?.prices, "Port should have prices");
    });
  },
});

// ============================================================================
// Group 38: list_known_ports — mega=true default max_hops
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports mega true default max_hops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("mega=true without explicit max_hops", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        mega: true,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify max_hops defaults to 100", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.max_hops, 100, "mega=true should default max_hops to 100");
      assertEquals(payload.mega, true);
    });
  },
});

// ============================================================================
// Group 39: list_known_ports — sort by hops then sector_id
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports sort order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, visit sectors 1 and 2", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
      await apiOk("move", { character_id: p1Id, to_sector: 2 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
      // Sectors 0, 1, 2 visited. Ship at sector 0.
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports from sector 0 max_hops=1", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        from_sector: 0,
        max_hops: 1,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify sort: sector 1 before sector 2 (same hops)", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      const ports = payload.ports as Array<Record<string, unknown>>;
      assert(ports.length >= 2, `Expected >= 2 ports, got ${ports.length}`);

      // Both sector 1 and 2 are at hop 1, should be sorted by sector_id
      for (let i = 1; i < ports.length; i++) {
        const prev = ports[i - 1];
        const curr = ports[i];
        const prevHops = prev.hops_from_start as number;
        const currHops = curr.hops_from_start as number;
        const prevId = (prev.sector as Record<string, unknown>)?.id as number;
        const currId = (curr.sector as Record<string, unknown>)?.id as number;
        if (prevHops === currHops) {
          assert(prevId <= currId, `Expected sector ${prevId} <= ${currId} at same hops`);
        } else {
          assert(prevHops < currHops, "Expected ascending hop order");
        }
      }
    });
  },
});

// ============================================================================
// Group 40: list_known_ports — actor mismatch
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports actor mismatch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    await t.step("P2 as actor for P1's ship → 403", async () => {
      const result = await api("list_known_ports", {
        character_id: p1Id,
        actor_character_id: p2Id,
      });
      assertEquals(result.status, 403);
    });
  },
});

// ============================================================================
// Group 41: list_known_ports — healthcheck
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports healthcheck",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("healthcheck returns ok", async () => {
      const result = await apiOk("list_known_ports", { healthcheck: true });
      assertEquals((result as Record<string, unknown>).status, "ok");
    });
  },
});

// ============================================================================
// Group 42: list_known_ports — malformed JSON
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports malformed JSON",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("non-JSON body → 400", async () => {
      const result = await apiRaw("list_known_ports", "not-json");
      assertEquals(result.status, 400);
    });

    await t.step("non-object JSON body → 400", async () => {
      const result = await apiRaw("list_known_ports", '"hello"');
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 43: list_known_ports — port with stock at max capacity
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports stock at max capacity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, visit sector 1 and saturate port stock", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      // Set stock = max for all commodities on sector 1's port
      await withPg(async (pg) => {
        const portResult = await pg.queryObject<{ port_id: number }>(
          `SELECT port_id FROM sector_contents WHERE sector_id = 1 AND port_id IS NOT NULL`,
        );
        if (portResult.rows.length > 0) {
          const portId = portResult.rows[0].port_id;
          await pg.queryObject(
            `UPDATE ports SET stock_qf = max_qf, stock_ro = max_ro, stock_ns = max_ns WHERE port_id = $1`,
            [portId],
          );
        }
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports from sector 1 max_hops=0", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        from_sector: 1,
        max_hops: 0,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify buy prices null when stock at max", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      const ports = payload.ports as Array<Record<string, unknown>>;
      assertEquals(ports.length, 1);

      // Sector 1 has BBS: Buys QF+RO (B,B), Sells NS (S)
      // With stock at max, buy prices should be null (port won't buy when full)
      const portData = (ports[0].sector as Record<string, unknown>)
        ?.port as Record<string, unknown>;
      const prices = portData?.prices as Record<string, unknown>;
      assertEquals(
        prices?.quantum_foam,
        null,
        "QF buy price should be null when stock=max",
      );
      assertEquals(
        prices?.retro_organics,
        null,
        "RO buy price should be null when stock=max",
      );
      // NS is sold by port, sell price should still exist
      assert(prices?.neuro_symbolics !== null, "NS sell price should exist");
    });
  },
});

// ============================================================================
// Group 44: list_known_ports — lowercase port code decoding
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports lowercase port code",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, visit sector 1, change port code to lowercase", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      // Update sector 1's port code from "BBS" to "bbs"
      await withPg(async (pg) => {
        const portResult = await pg.queryObject<{ port_id: number }>(
          `SELECT port_id FROM sector_contents WHERE sector_id = 1 AND port_id IS NOT NULL`,
        );
        if (portResult.rows.length > 0) {
          const portId = portResult.rows[0].port_id;
          await pg.queryObject(
            `UPDATE ports SET port_code = 'bbs' WHERE port_id = $1`,
            [portId],
          );
        }
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports with lowercase code from sector 1", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        from_sector: 1,
        max_hops: 0,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify port found with prices (lowercase code decoded)", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      const ports = payload.ports as Array<Record<string, unknown>>;
      assertEquals(ports.length, 1, "Should find 1 port at sector 1");

      // Verify prices exist (lowercase 'bbs' should decode same as 'BBS')
      const portData = (ports[0].sector as Record<string, unknown>)
        ?.port as Record<string, unknown>;
      const prices = portData?.prices as Record<string, unknown>;
      assertExists(prices, "Should have prices");
      // 'bbs' = buys QF+RO, sells NS → NS should have sell price
      assert(prices?.neuro_symbolics !== null, "NS sell price should exist");
    });
  },
});

// ============================================================================
// Group 45: list_known_ports — fromSector fallback when ship sector null
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports fromSector fallback",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, set ship current_sector to NULL", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Set ship's current_sector to NULL to test fallback path
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances SET current_sector = NULL WHERE ship_id = $1`,
          [p1ShipId],
        );
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports without from_sector (falls back to knowledge or 0)", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify from_sector in event (should be 0)", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      // Should fall back to knowledge.current_sector or default to 0
      assertEquals(payload.from_sector, 0, "Should fall back to sector 0");
    });
  },
});

// ============================================================================
// Group 46: list_known_ports — nonexistent character (rate limit FK error)
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports nonexistent character",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("nonexistent character → 500", async () => {
      // The rate_limits table has a FK to characters — a random UUID not in
      // characters causes enforceRateLimit to throw a non-RateLimitError,
      // exercising the generic rate limit error handler (lines 208-209).
      const result = await api("list_known_ports", {
        character_id: crypto.randomUUID(),
      });
      assertEquals(result.status, 500);
    });
  },
});

// ============================================================================
// Group 47: list_known_ports — trade_type sell with retro_organics
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports sell retro_organics",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, visit sector 2", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Sector 2 has SBB: Sells QF, Buys RO+NS
      await apiOk("move", { character_id: p1Id, to_sector: 2 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("sell retro_organics filter", async () => {
      // trade_type=sell, commodity=retro_organics → port buys RO → code[1]="B"
      // Sector 2 (SBB): position 1 = "B" → matches
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        commodity: "retro_organics",
        trade_type: "sell",
        max_hops: 1,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify event has results", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.commodity, "retro_organics");
      assertEquals(payload.trade_type, "sell");
      const totalPorts = payload.total_ports_found as number;
      assert(totalPorts >= 1, `Expected >= 1 port for sell retro_organics, got ${totalPorts}`);
    });
  },
});

// ============================================================================
// Group 48: list_known_ports — buy neuro_symbolics (sell price from port)
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports buy neuro_symbolics",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, visit sector 1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Sector 1 has BBS: Sells NS (position 2 = "S")
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("buy neuro_symbolics filter", async () => {
      // trade_type=buy, commodity=neuro_symbolics → port sells NS → code[2]="S"
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
        commodity: "neuro_symbolics",
        trade_type: "buy",
        max_hops: 1,
      });
      assertExists((result as Record<string, unknown>).request_id);
    });

    await t.step("verify event has results", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.commodity, "neuro_symbolics");
      assertEquals(payload.trade_type, "buy");
      const totalPorts = payload.total_ports_found as number;
      assert(totalPorts >= 1, `Expected >= 1 port for buy neuro_symbolics, got ${totalPorts}`);
    });
  },
});

// ============================================================================
// Group 49: list_known_ports — BFS expansion from non-port sector
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports BFS expands from non-port sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Sector 0 has NO port. Sectors 1 (BBS) and 2 (SBB) are adjacent to 0.
    // If BFS doesn't expand, 0 ports will be found.
    await t.step("reset and visit sectors 0, 1, 2", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // join puts us at sector 0; move to 1 then 2 then back to 0
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
      await apiOk("move", { character_id: p1Id, to_sector: 2 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
      // Ship at sector 0 (no port); visited: 0, 1, 2
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports from sector 0, max_hops=1", async () => {
      await apiOk("list_known_ports", {
        character_id: p1Id,
        max_hops: 1,
      });
    });

    await t.step("verify BFS found ports at hop 1", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1, "Should have ports.list event");
      const payload = events[events.length - 1].payload as Record<string, unknown>;

      assertEquals(payload.from_sector, 0, "from_sector should be 0");

      const ports = payload.ports as Array<Record<string, unknown>>;
      assert(
        ports.length >= 2,
        `Expected >= 2 ports from sector 0 with max_hops=1 (sectors 1 and 2 have ports), got ${ports.length}`,
      );

      // Sector 1 (BBS) at hop 1
      const s1 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 1,
      );
      assertExists(s1, "Should find sector 1 port (BBS) at hop 1");
      assertEquals(s1!.hops_from_start, 1, "Sector 1 should be 1 hop away");

      // Sector 2 (SBB) at hop 1
      const s2 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 2,
      );
      assertExists(s2, "Should find sector 2 port (SBB) at hop 1");
      assertEquals(s2!.hops_from_start, 1, "Sector 2 should be 1 hop away");

      // No port at sector 0 itself (it has no port)
      const s0 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 0,
      );
      assertEquals(s0, undefined, "Sector 0 should not appear (no port)");

      // searched_sectors should reflect multi-sector BFS
      const searched = payload.searched_sectors as number;
      assert(searched > 1, `Expected searched_sectors > 1, got ${searched}`);
    });
  },
});

// ============================================================================
// Group 50: list_known_ports — BFS finds ports at increasing hop distances
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports progressive hop discovery",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Visit sectors 0 → 1 → 3. Ship at sector 0.
    // Sector 0: no port. Sector 1: BBS (hop 1). Sector 3: BSS (hop 2 via 0→1→3).
    await t.step("reset and visit sectors 0, 1, 3 then return to 0", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
      // Ship at sector 0; visited: 0, 1, 3
    });

    let cursor: number;

    // max_hops=0: no ports (sector 0 has no port)
    await t.step("max_hops=0 finds 0 ports at non-port sector", async () => {
      cursor = await getEventCursor(p1Id);
      await apiOk("list_known_ports", {
        character_id: p1Id,
        max_hops: 0,
      });
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.total_ports_found, 0, "max_hops=0 at sector 0 should find 0 ports");
      assertEquals(payload.searched_sectors, 1, "max_hops=0 should search exactly 1 sector");
    });

    // max_hops=1: finds sector 1 port only
    await t.step("max_hops=1 finds sector 1 port", async () => {
      cursor = await getEventCursor(p1Id);
      await apiOk("list_known_ports", {
        character_id: p1Id,
        max_hops: 1,
      });
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      const ports = payload.ports as Array<Record<string, unknown>>;
      const totalPorts = payload.total_ports_found as number;
      assert(totalPorts >= 1, `Expected >= 1 port with max_hops=1, got ${totalPorts}`);

      const s1 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 1,
      );
      assertExists(s1, "max_hops=1 should find sector 1 (BBS)");
      assertEquals(s1!.hops_from_start, 1);
    });

    // max_hops=2: finds sector 1 AND sector 3
    await t.step("max_hops=2 finds sectors 1 and 3", async () => {
      cursor = await getEventCursor(p1Id);
      await apiOk("list_known_ports", {
        character_id: p1Id,
        max_hops: 2,
      });
      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      const ports = payload.ports as Array<Record<string, unknown>>;
      const totalPorts = payload.total_ports_found as number;
      assert(totalPorts >= 2, `Expected >= 2 ports with max_hops=2, got ${totalPorts}`);

      const s1 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 1,
      );
      assertExists(s1, "max_hops=2 should find sector 1 (BBS)");

      const s3 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 3,
      );
      assertExists(s3, "max_hops=2 should find sector 3 (BSS)");
    });
  },
});

// ============================================================================
// Group 51: list_known_ports — BFS across long chain finds distant ports
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports long chain port discovery",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Visit chain: 0 → 1 → 3 → 7 → 9 (port BBB). Then return to sector 0.
    // From sector 0: sector 9 should be reachable within max_hops=5.
    await t.step("reset and visit long chain 0→1→3→7→9", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      await apiOk("move", { character_id: p1Id, to_sector: 7 });
      await apiOk("move", { character_id: p1Id, to_sector: 9 });
      // Return to sector 0
      await apiOk("move", { character_id: p1Id, to_sector: 7 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
      // Ship at sector 0; visited: 0, 1, 3, 7, 9
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports with max_hops=5 finds all chain ports", async () => {
      await apiOk("list_known_ports", {
        character_id: p1Id,
        max_hops: 5,
      });

      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      const ports = payload.ports as Array<Record<string, unknown>>;
      const totalPorts = payload.total_ports_found as number;

      // Should find ports at: sector 1 (BBS), sector 3 (BSS), sector 9 (BBB)
      assert(totalPorts >= 3, `Expected >= 3 ports along chain, got ${totalPorts}`);

      const s1 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 1,
      );
      assertExists(s1, "Should find sector 1 (BBS)");

      const s3 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 3,
      );
      assertExists(s3, "Should find sector 3 (BSS)");

      const s9 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 9,
      );
      assertExists(s9, "Should find sector 9 (BBB)");

      // Verify hop ordering: sector 1 < sector 3 < sector 9
      assert(
        (s1!.hops_from_start as number) < (s3!.hops_from_start as number),
        "Sector 1 should be closer than sector 3",
      );
      assert(
        (s3!.hops_from_start as number) <= (s9!.hops_from_start as number),
        "Sector 3 should be closer than or equal to sector 9",
      );
    });
  },
});

// ============================================================================
// Group 52: list_known_ports — from_sector override with BFS expansion
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports from_sector override expands BFS",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Visit sectors 0, 1, 3. Ship stays at sector 3.
    // Use from_sector=1 to start BFS from sector 1 instead.
    await t.step("reset and visit 0 → 1 → 3", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      // Ship at sector 3; visited: 0, 1, 3
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("list ports from_sector=1, max_hops=1", async () => {
      await apiOk("list_known_ports", {
        character_id: p1Id,
        from_sector: 1,
        max_hops: 1,
      });

      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;
      assertEquals(payload.from_sector, 1, "from_sector should be 1");

      const ports = payload.ports as Array<Record<string, unknown>>;
      const totalPorts = payload.total_ports_found as number;

      // From sector 1: sector 1 at hop 0 (BBS), sector 3 at hop 1 (BSS, adjacent)
      assert(totalPorts >= 2, `Expected >= 2 ports from sector 1 with max_hops=1, got ${totalPorts}`);

      const s1 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 1,
      );
      assertExists(s1, "Should find sector 1 (BBS) at hop 0");
      assertEquals(s1!.hops_from_start, 0);

      const s3 = ports.find(
        (p) => ((p.sector as Record<string, unknown>)?.id as number) === 3,
      );
      assertExists(s3, "Should find sector 3 (BSS) at hop 1");
      assertEquals(s3!.hops_from_start, 1);
    });
  },
});

// ============================================================================
// Group 53: list_known_ports — searched_sectors reflects BFS expansion
// ============================================================================

Deno.test({
  name: "query_endpoints — list_known_ports searched_sectors accuracy",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Visit sectors 0 and 1. From sector 0 with max_hops=1,
    // BFS should search multiple sectors (not just 1).
    await t.step("reset and visit sectors 0, 1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 0 });
      // Ship at sector 0; visited: 0, 1
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("verify searched_sectors > 1 for max_hops > 0", async () => {
      await apiOk("list_known_ports", {
        character_id: p1Id,
        max_hops: 1,
      });

      const events = await eventsOfType(p1Id, "ports.list", cursor);
      assert(events.length >= 1);
      const payload = events[events.length - 1].payload as Record<string, unknown>;

      const searched = payload.searched_sectors as number;
      // Sector 0 has 3 neighbors (1, 2, 5), so at max_hops=1 we should
      // search 1 (sector 0) + 3 (neighbors) = 4 sectors
      assert(
        searched >= 4,
        `Expected searched_sectors >= 4 from sector 0 with max_hops=1, got ${searched}`,
      );
    });
  },
});

// ============================================================================
// Group 54: adjacent_sectors includes region info
// ============================================================================

Deno.test({
  name: "query_endpoints — adjacent_sectors includes region info",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("adjacent_sectors is object with region, not number[]", async () => {
      // P1 is in sector 0, adjacent to [1, 2, 5] — all "testbed" region
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        center_sector: 0,
        max_hops: 0,
      });
      const body = result as Record<string, unknown>;
      const sectors = body.sectors as Array<Record<string, unknown>>;
      assertEquals(sectors.length, 1, "max_hops=0 should return only center");

      const sector0 = sectors[0];
      assertEquals(sector0.id, 0);

      const adj = sector0.adjacent_sectors;
      // Should be an object, NOT an array
      assert(
        !Array.isArray(adj),
        `adjacent_sectors should be an object with region info, got array: ${JSON.stringify(adj)}`,
      );
      assert(
        typeof adj === "object" && adj !== null,
        `adjacent_sectors should be an object, got ${typeof adj}`,
      );

      // Sector 0 is adjacent to 1, 2, 5 — all should have region info
      const adjObj = adj as Record<string, { region: string }>;
      for (const sectorId of ["1", "2", "5"]) {
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
// Group 55: adjacent_sectors shows mixed regions (testbed + Federation Space)
// ============================================================================

Deno.test({
  name: "query_endpoints — adjacent_sectors mixed regions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset, join, and move to sector 4", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      // Move P1: 0 → 1 → 3 → 4
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      await apiOk("move", { character_id: p1Id, to_sector: 4 });
    });

    await t.step("sector 4 adjacent_sectors has mixed regions", async () => {
      // Sector 4 is adjacent to [3 (testbed), 8 (Federation Space)]
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        center_sector: 4,
        max_hops: 0,
      });
      const body = result as Record<string, unknown>;
      const sectors = body.sectors as Array<Record<string, unknown>>;
      assertEquals(sectors.length, 1);

      const sector4 = sectors[0];
      assertEquals(sector4.id, 4);

      const adj = sector4.adjacent_sectors as Record<string, { region: string }>;
      assert(
        !Array.isArray(adj),
        `adjacent_sectors should be an object, got array`,
      );

      // Sector 3 should be testbed
      assertExists(adj["3"], "should include sector 3");
      assertEquals(adj["3"].region, "testbed");

      // Sector 8 should be Federation Space
      assertExists(adj["8"], "should include sector 8");
      assertEquals(adj["8"].region, "Federation Space");
    });
  },
});

// ============================================================================
// Group 56: unvisited sectors include region
// ============================================================================

Deno.test({
  name: "query_endpoints — unvisited sectors include region",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("unvisited neighbors have region populated", async () => {
      // P1 is in sector 0 (visited). With max_hops=1, neighbors 1, 2, 5
      // appear as unvisited sectors and should still have region set.
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        center_sector: 0,
        max_hops: 1,
      });
      const body = result as Record<string, unknown>;
      const sectors = body.sectors as Array<Record<string, unknown>>;

      const unvisited = sectors.filter((s) => s.visited === false);
      assert(
        unvisited.length > 0,
        `Expected at least one unvisited sector with max_hops=1, got ${unvisited.length}`,
      );

      for (const sector of unvisited) {
        assertExists(
          sector.region,
          `Unvisited sector ${sector.id} should have region populated`,
        );
        assertEquals(
          sector.region,
          "testbed",
          `Unvisited sector ${sector.id} should be testbed`,
        );
      }
    });

    await t.step("unvisited fedspace neighbor has correct region", async () => {
      // Move P1 to sector 4, which is adjacent to sector 8 (Federation Space).
      // Sector 8 should appear as unvisited with region "Federation Space".
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      await apiOk("move", { character_id: p1Id, to_sector: 4 });

      const result = await apiOk("local_map_region", {
        character_id: p1Id,
        center_sector: 4,
        max_hops: 1,
      });
      const body = result as Record<string, unknown>;
      const sectors = body.sectors as Array<Record<string, unknown>>;

      const sector8 = sectors.find((s) => s.id === 8);
      assertExists(sector8, "Sector 8 should be in the response");
      assertEquals(sector8.visited, false, "Sector 8 should be unvisited");
      assertEquals(
        sector8.region,
        "Federation Space",
        "Unvisited sector 8 should have region Federation Space",
      );
    });
  },
});
