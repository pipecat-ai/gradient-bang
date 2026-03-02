/**
 * Integration tests for movement & navigation.
 *
 * Tests cover:
 *   - Basic move (sector 0 → 1)
 *   - Observer events: departure and arrival
 *   - Self-event filtering (actor does not get character.moved for self)
 *   - Adjacency validation (non-adjacent move rejected)
 *   - Warp power insufficient
 *   - Move while in hyperspace
 *   - Map knowledge updates on first visit
 *   - Plot course
 *   - Local map region
 *   - List known ports
 *
 * Setup: 3 players — P1+P2 in sector 0, P3 in sector 1.
 * MOVE_DELAY_SCALE=0 ensures instant moves.
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, clearEvents, startServerInProcess } from "./harness.ts";
import {
  api,
  apiOk,
  characterIdFor,
  shipIdFor,
  eventsSince,
  eventsOfType,
  getEventCursor,
  queryCharacter,
  queryShip,
  assertNoEventsOfType,
  setShipWarpPower,
  setShipHyperspace,
  setShipSector,
} from "./helpers.ts";

const P1 = "test_move_p1";
const P2 = "test_move_p2";
const P3 = "test_move_p3";

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
  name: "movement — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Basic move (sector 0 → sector 1)
// ============================================================================

Deno.test({
  name: "movement — basic move",
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
    });

    // Join all players so they have status.snapshot events
    await t.step("join all players", async () => {
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
    });

    let cursorP1: number;

    await t.step("capture cursor before move", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 moves sector 0 → 1", async () => {
      const result = await apiOk("move", {
        character_id: p1Id,
        to_sector: 1,
      });
      assert(result.success);
    });

    await t.step("P1 receives movement.start event", async () => {
      const events = await eventsOfType(p1Id, "movement.start", cursorP1);
      assert(events.length >= 1, `Expected >= 1 movement.start, got ${events.length}`);
      const ev = events[0];
      const payload = ev.payload;
      assertExists(payload.sector, "payload.sector");
      assertExists(payload.source, "payload.source");
    });

    await t.step("P1 receives movement.complete event", async () => {
      const events = await eventsOfType(p1Id, "movement.complete", cursorP1);
      assert(events.length >= 1, `Expected >= 1 movement.complete, got ${events.length}`);
      const ev = events[0];
      const payload = ev.payload;
      assertExists(payload.sector, "payload.sector");
      assertExists(payload.player, "payload.player");
      assertExists(payload.ship, "payload.ship");
    });

    await t.step("P1 receives map.local event", async () => {
      const events = await eventsOfType(p1Id, "map.local", cursorP1);
      assert(events.length >= 1, `Expected >= 1 map.local, got ${events.length}`);
    });

    await t.step("DB: ship is now in sector 1", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_sector, 1);
      assertEquals(ship.in_hyperspace, false);
    });

    await t.step("DB: warp power decreased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      // Started at 500, kestrel_courier costs 3 per warp
      assert(
        (ship.current_warp_power as number) < 500,
        `Warp power should have decreased: ${ship.current_warp_power}`,
      );
    });
  },
});

// ============================================================================
// Group 2: Move observer events — departure
// ============================================================================

Deno.test({
  name: "movement — departure observer events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join all players", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
    });

    let cursorP2: number;

    await t.step("capture P2 cursor before P1 moves", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 moves sector 0 → 1", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("P2 receives character.moved (depart)", async () => {
      const events = await eventsOfType(p2Id, "character.moved", cursorP2);
      assert(events.length >= 1, `Expected >= 1 character.moved, got ${events.length}`);
      // At least one event should be a departure from P2's sector
      const depart = events.find(
        (e) => (e.payload as Record<string, unknown>).movement === "depart",
      );
      assertExists(depart, "Expected a 'depart' character.moved event");
    });

    await t.step("P2 does NOT receive movement.start or movement.complete", async () => {
      await assertNoEventsOfType(p2Id, "movement.start", cursorP2);
      await assertNoEventsOfType(p2Id, "movement.complete", cursorP2);
    });
  },
});

// ============================================================================
// Group 3: Move observer events — arrival
// ============================================================================

Deno.test({
  name: "movement — arrival observer events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join all players", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
    });

    let cursorP3: number;

    await t.step("capture P3 cursor before P1 moves", async () => {
      // P3 is in sector 1
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 moves sector 0 → 1 (where P3 is)", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("P3 receives character.moved (arrive)", async () => {
      const events = await eventsOfType(p3Id, "character.moved", cursorP3);
      assert(events.length >= 1, `Expected >= 1 character.moved for P3, got ${events.length}`);
      const arrive = events.find(
        (e) => (e.payload as Record<string, unknown>).movement === "arrive",
      );
      assertExists(arrive, "Expected an 'arrive' character.moved event for P3");
    });
  },
});

// ============================================================================
// Group 4: Self-event filtering during move
// ============================================================================

Deno.test({
  name: "movement — self-event filtering",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join all players", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
    });

    let cursorP1: number;

    await t.step("capture P1 cursor and move", async () => {
      cursorP1 = await getEventCursor(p1Id);
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("P1 does NOT receive character.moved for self", async () => {
      await assertNoEventsOfType(p1Id, "character.moved", cursorP1);
    });

    await t.step("P1 DOES receive movement.start and movement.complete", async () => {
      const starts = await eventsOfType(p1Id, "movement.start", cursorP1);
      assert(starts.length >= 1, "Expected movement.start");
      const completes = await eventsOfType(p1Id, "movement.complete", cursorP1);
      assert(completes.length >= 1, "Expected movement.complete");
    });

    await t.step("P1 DOES receive map.local", async () => {
      const maps = await eventsOfType(p1Id, "map.local", cursorP1);
      assert(maps.length >= 1, "Expected map.local");
    });
  },
});

// ============================================================================
// Group 5: Adjacency validation
// ============================================================================

Deno.test({
  name: "movement — adjacency validation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join P1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("move to non-adjacent sector fails", async () => {
      // Sector 0 is adjacent to 1, 2, 5 — sector 9 is not adjacent
      const result = await api("move", {
        character_id: p1Id,
        to_sector: 9,
      });
      assert(!result.ok || !result.body.success, "Expected move to non-adjacent sector to fail");
    });

    await t.step("DB: ship is still in sector 0", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_sector, 0);
    });
  },
});

// ============================================================================
// Group 6: Warp power insufficient
// ============================================================================

Deno.test({
  name: "movement — warp power insufficient",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join P1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("drain P1 warp power", async () => {
      await setShipWarpPower(p1ShipId, 0);
    });

    await t.step("move fails with insufficient warp", async () => {
      const result = await api("move", {
        character_id: p1Id,
        to_sector: 1,
      });
      assert(!result.ok || !result.body.success, "Expected move to fail with no warp power");
    });

    await t.step("DB: ship still in sector 0", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.current_sector, 0);
    });
  },
});

// ============================================================================
// Group 7: Move while in hyperspace
// ============================================================================

Deno.test({
  name: "movement — move while in hyperspace rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join P1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("set P1 in hyperspace", async () => {
      await setShipHyperspace(p1ShipId, true, 2);
    });

    await t.step("move fails while in hyperspace", async () => {
      const result = await api("move", {
        character_id: p1Id,
        to_sector: 1,
      });
      // Server may return error or auto-recover if stuck too long.
      // Either way, a fresh hyperspace should reject.
      // We also need to set hyperspace_eta to future time.
      // If the server auto-recovers (>20s overdue), it might succeed.
      // Since we just set it, it should be treated as active hyperspace.
      assert(
        !result.ok || !result.body.success,
        "Expected move to fail while in hyperspace",
      );
    });

    await t.step("clean up hyperspace state", async () => {
      await setShipHyperspace(p1ShipId, false, null);
    });
  },
});

// ============================================================================
// Group 8: Map knowledge updated on first visit
// ============================================================================

Deno.test({
  name: "movement — map knowledge updated",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join P1", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("verify sector 1 not yet visited", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      const knowledge = char.map_knowledge as Record<string, unknown>;
      const visited = knowledge.sectors_visited as Record<string, unknown>;
      assertEquals(visited["1"], undefined, "Sector 1 should not be visited yet");
    });

    await t.step("P1 moves to sector 1", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("DB: sector 1 now in sectors_visited", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      const knowledge = char.map_knowledge as Record<string, unknown>;
      const visited = knowledge.sectors_visited as Record<string, unknown>;
      assertExists(visited["1"], "Sector 1 should now be in visited sectors");
    });
  },
});

// ============================================================================
// Group 9: Plot course
// ============================================================================

Deno.test({
  name: "movement — plot course",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join P1 and P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    // First visit some sectors so P1 has map knowledge for the destination
    // P1 is in sector 0, let's move to sector 1 then back to 0, then plot to sector 3
    await t.step("P1 explores sectors for map knowledge", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
      // Now P1 knows sectors 0, 1, 3
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 plots course from sector 3 to sector 0", async () => {
      const result = await apiOk("plot_course", {
        character_id: p1Id,
        to_sector: 0,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.path, "Response should have path");
      assertExists(body.distance, "Response should have distance");
      const path = body.path as number[];
      assert(path.length >= 2, "Path should have at least 2 sectors");
    });

    await t.step("P1 receives course.plot event", async () => {
      const events = await eventsOfType(p1Id, "course.plot", cursorP1);
      assert(events.length >= 1, `Expected >= 1 course.plot, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.path, "payload.path");
      assertExists(payload.distance, "payload.distance");
    });

    await t.step("P2 does NOT receive course.plot", async () => {
      await assertNoEventsOfType(p2Id, "course.plot", cursorP2);
    });
  },
});

// ============================================================================
// Group 10: Local map region
// ============================================================================

Deno.test({
  name: "movement — local map region",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join P1 and P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 requests local map region", async () => {
      const result = await apiOk("local_map_region", {
        character_id: p1Id,
      });
      assert(result.success);
      const body = result as Record<string, unknown>;
      assertExists(body.sectors, "Response should have sectors");
      const sectors = body.sectors as unknown[];
      assert(sectors.length > 0, "sectors array should not be empty");
    });

    await t.step("P1 receives map.region event", async () => {
      const events = await eventsOfType(p1Id, "map.region", cursorP1);
      assert(events.length >= 1, `Expected >= 1 map.region, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.sectors, "payload.sectors");
    });

    await t.step("P2 does NOT receive map.region", async () => {
      await assertNoEventsOfType(p2Id, "map.region", cursorP2);
    });
  },
});

// ============================================================================
// Group 11: List known ports
// ============================================================================

Deno.test({
  name: "movement — list known ports",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join P1 and P2", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
    });

    // P1 needs to visit sectors with ports to know about them
    await t.step("P1 moves to sector 1 (has port)", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 requests known ports", async () => {
      const result = await apiOk("list_known_ports", {
        character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("P1 receives ports.list event", async () => {
      const events = await eventsOfType(p1Id, "ports.list", cursorP1);
      assert(events.length >= 1, `Expected >= 1 ports.list, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.ports, "payload.ports");
    });

    await t.step("P2 does NOT receive ports.list", async () => {
      await assertNoEventsOfType(p2Id, "ports.list", cursorP2);
    });
  },
});
