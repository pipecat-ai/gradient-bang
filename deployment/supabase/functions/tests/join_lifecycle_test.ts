/**
 * Integration tests for the join/connection lifecycle.
 *
 * Tests cover:
 *   - Single player join (response, events, DB state)
 *   - my_status after join
 *   - Multi-player event visibility (same sector, cross-sector)
 *   - Departure events
 *   - Self-event filtering
 *   - Error cases
 *
 * Requires: run_tests.sh to have started the isolated Supabase instance
 * and server.ts. Environment variables must be set.
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
  apiRaw,
  characterIdFor,
  shipIdFor,
  eventsSince,
  eventsOfType,
  getEventCursor,
  queryCharacter,
  queryShip,
  withPg,
} from "./helpers.ts";

// Test character names (resolved to UUIDs by test_reset via legacy ID)
const PLAYER_1 = "test_2p_player1";
const PLAYER_2 = "test_2p_player2";

// Pre-computed IDs (set in first step)
let player1Id: string;
let player2Id: string;
let player1ShipId: string;
let player2ShipId: string;

// ============================================================================
// Group 0: Start server in-process (enables code coverage)
// ============================================================================

Deno.test({
  name: "start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Single player join basics
// ============================================================================

Deno.test({
  name: "join lifecycle — single player",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // Resolve UUIDs
    player1Id = await characterIdFor(PLAYER_1);
    player2Id = await characterIdFor(PLAYER_2);
    player1ShipId = await shipIdFor(PLAYER_1);
    player2ShipId = await shipIdFor(PLAYER_2);

    await t.step("reset database with two test characters", async () => {
      await resetDatabase([PLAYER_1, PLAYER_2]);
    });

    // ── Join returns success ──────────────────────────────────────────

    await t.step("player 1 join returns success with request_id", async () => {
      const result = await apiOk("join", {
        character_id: player1Id,
        request_id: "test-join-p1",
      });
      assert(result.success);
      assertEquals((result as Record<string, unknown>).request_id, "test-join-p1");
    });

    // ── Events emitted by join ────────────────────────────────────────

    await t.step("player 1 receives status.snapshot event", async () => {
      const snapshots = await eventsOfType(player1Id, "status.snapshot");
      assert(snapshots.length >= 1, `Expected >= 1 status.snapshot, got ${snapshots.length}`);

      // Delivered directly to the joining player
      const ev = snapshots[0];
      assertEquals(ev.recipient_ids[0], player1Id);
      assertEquals(ev.recipient_reasons[0], "direct");
    });

    await t.step("status.snapshot payload has player, ship, sector, source", async () => {
      const snapshots = await eventsOfType(player1Id, "status.snapshot");
      const payload = snapshots[0].payload;

      // Player fields
      const player = payload.player as Record<string, unknown>;
      assertExists(player, "payload.player");
      assertEquals(player.id, player1Id);
      assertEquals(player.name, PLAYER_1);
      assert(typeof player.credits_in_bank === "number");
      assert(typeof player.sectors_visited === "number");
      assert(typeof player.universe_size === "number");

      // Ship fields
      const ship = payload.ship as Record<string, unknown>;
      assertExists(ship, "payload.ship");
      assertEquals(ship.ship_id, player1ShipId);
      assert(typeof ship.ship_type === "string");
      assert(typeof ship.credits === "number");
      assertExists(ship.cargo, "payload.ship.cargo");
      assert(typeof ship.warp_power === "number");
      assert(typeof ship.cargo_capacity === "number");

      // Sector fields
      const sector = payload.sector as Record<string, unknown>;
      assertExists(sector, "payload.sector");
      assertEquals(sector.id, 0); // pinned to sector 0

      // Source
      const source = payload.source as Record<string, unknown>;
      assertExists(source, "payload.source");
      assertEquals(source.method, "join");
    });

    await t.step("player 1 receives map.local event", async () => {
      const maps = await eventsOfType(player1Id, "map.local");
      assert(maps.length >= 1, `Expected >= 1 map.local, got ${maps.length}`);

      const ev = maps[0];
      assertEquals(ev.recipient_ids[0], player1Id);

      const payload = ev.payload;
      assertEquals(payload.center_sector, 0);
      assert(Array.isArray(payload.sectors), "payload.sectors should be an array");
      assert(
        (payload.sectors as unknown[]).length > 0,
        "sectors array should not be empty",
      );
    });

    // ── DB state after join ───────────────────────────────────────────

    await t.step("ship is in sector 0 and not in hyperspace", async () => {
      const ship = await queryShip(player1ShipId);
      assertExists(ship, "Ship should exist in DB");
      assertEquals(ship.current_sector, 0);
      assertEquals(ship.in_hyperspace, false);
      assertEquals(ship.hyperspace_destination, null);
    });

    await t.step("character has current_ship_id set", async () => {
      const char = await queryCharacter(player1Id);
      assertExists(char, "Character should exist in DB");
      assertEquals(char.current_ship_id, player1ShipId);
    });

    await t.step("character map_knowledge includes sector 0", async () => {
      const char = await queryCharacter(player1Id);
      assertExists(char, "Character should exist in DB");
      const knowledge = char.map_knowledge as Record<string, unknown>;
      assertExists(knowledge, "map_knowledge should exist");
      const visited = knowledge.sectors_visited as Record<string, unknown>;
      assertExists(visited, "sectors_visited should exist");
      assertExists(visited["0"], "sector 0 should be in visited sectors");
    });
  },
});

// ============================================================================
// Group 2: my_status after join
// ============================================================================

Deno.test({
  name: "join lifecycle — my_status after join",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player1ShipId = await shipIdFor(PLAYER_1);

    await t.step("reset and join player 1", async () => {
      await resetDatabase([PLAYER_1]);
      await apiOk("join", { character_id: player1Id });
    });

    await t.step("my_status returns success", async () => {
      const cursor = await getEventCursor(player1Id);

      const result = await apiOk("my_status", {
        character_id: player1Id,
        request_id: "test-status-p1",
      });
      assert(result.success);

      // my_status emits a status.snapshot
      const snapshots = await eventsOfType(player1Id, "status.snapshot", cursor);
      assert(snapshots.length >= 1, "my_status should emit status.snapshot");
    });

    await t.step("my_status snapshot has same structure as join snapshot", async () => {
      const snapshots = await eventsOfType(player1Id, "status.snapshot");
      // Take the last one (from my_status)
      const payload = snapshots[snapshots.length - 1].payload;

      const player = payload.player as Record<string, unknown>;
      assertExists(player, "payload.player");
      assertEquals(player.id, player1Id);

      const ship = payload.ship as Record<string, unknown>;
      assertExists(ship, "payload.ship");
      assertEquals(ship.ship_id, player1ShipId);

      const sector = payload.sector as Record<string, unknown>;
      assertExists(sector, "payload.sector");
    });
  },
});

// ============================================================================
// Group 3: Multi-player visibility — same sector, no sector change
// ============================================================================

Deno.test({
  name: "join lifecycle — multi-player same sector visibility",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player2Id = await characterIdFor(PLAYER_2);
    player1ShipId = await shipIdFor(PLAYER_1);

    await t.step("reset and join player 1 to sector 0", async () => {
      await resetDatabase([PLAYER_1, PLAYER_2]);
      await apiOk("join", { character_id: player1Id });
    });

    let cursorBeforeP2: number;

    await t.step("capture event cursor before player 2 joins", async () => {
      cursorBeforeP2 = await getEventCursor(player1Id);
      assert(typeof cursorBeforeP2 === "number");
    });

    await t.step("player 2 joins same sector (sector 0)", async () => {
      // Both players are pinned to sector 0 by PINNED_SECTORS in test_reset
      const result = await apiOk("join", { character_id: player2Id });
      assert(result.success);
    });

    await t.step("player 2 receives own status.snapshot", async () => {
      const snapshots = await eventsOfType(player2Id, "status.snapshot");
      assert(snapshots.length >= 1, "Player 2 should receive status.snapshot");
      assertEquals(snapshots[0].recipient_ids[0], player2Id);
    });

    await t.step("player 2 receives own map.local", async () => {
      const maps = await eventsOfType(player2Id, "map.local");
      assert(maps.length >= 1, "Player 2 should receive map.local");
    });

    await t.step("player 2 status.snapshot shows player 1 in sector", async () => {
      const snapshots = await eventsOfType(player2Id, "status.snapshot");
      const payload = snapshots[0].payload;
      const sector = payload.sector as Record<string, unknown>;
      const players = sector.players as Array<Record<string, unknown>>;
      assertExists(players, "sector.players should exist");

      // Player 1 should appear in the players list (they joined first)
      const p1Entry = players.find(
        (p) => p.id === player1Id || p.name === PLAYER_1,
      );
      assertExists(
        p1Entry,
        `Player 1 should be in sector.players. Found: ${JSON.stringify(players.map((p) => p.name ?? p.id))}`,
      );
    });

    await t.step("no character.moved events when both start in same sector", async () => {
      // Both players are pinned to sector 0. When player 2 joins sector 0
      // and previousSector === targetSector (both 0), join() skips movement
      // observer events. This is correct behavior.
      const p1Events = await eventsSince(player1Id, cursorBeforeP2);
      const movedEvents = p1Events.events.filter(
        (e) => e.event_type === "character.moved",
      );
      assertEquals(
        movedEvents.length,
        0,
        "No character.moved when previous === target sector",
      );
    });
  },
});

// ============================================================================
// Group 4: Multi-player movement events — cross-sector arrival
// ============================================================================

Deno.test({
  name: "join lifecycle — cross-sector arrival events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player2Id = await characterIdFor(PLAYER_2);

    await t.step("reset and place players in different sectors", async () => {
      await resetDatabase([PLAYER_1, PLAYER_2]);
      // Player 1 joins sector 0
      await apiOk("join", { character_id: player1Id, sector: 0 });
      // Player 2 joins sector 1 (different sector)
      await apiOk("join", { character_id: player2Id, sector: 1 });
    });

    let cursorP1: number;

    await t.step("capture cursor, then player 2 arrives in sector 0", async () => {
      cursorP1 = await getEventCursor(player1Id);

      // Player 2 joins sector 0 — arrives from sector 1
      const result = await apiOk("join", {
        character_id: player2Id,
        sector: 0,
        request_id: "test-p2-arrive",
      });
      assert(result.success);
    });

    await t.step("player 1 receives character.moved arrive event", async () => {
      const { events } = await eventsSince(player1Id, cursorP1);
      const arrivals = events.filter(
        (e) =>
          e.event_type === "character.moved" &&
          e.payload?.movement === "arrive",
      );

      assert(
        arrivals.length >= 1,
        `Expected player 1 to receive arrive event. Events: ${JSON.stringify(events.map((e) => e.event_type))}`,
      );

      const arrival = arrivals[0];
      assertEquals(arrival.recipient_ids[0], player1Id);

      // Verify payload has player and ship info
      const payload = arrival.payload;
      const player = payload.player as Record<string, unknown>;
      assertExists(player, "arrive payload should have player");
      assertEquals(player.id, player2Id);
      assertEquals(player.name, PLAYER_2);

      const ship = payload.ship as Record<string, unknown>;
      assertExists(ship, "arrive payload should have ship");
      assert(typeof ship.ship_id === "string");
      assert(typeof ship.ship_type === "string");

      assertEquals(payload.movement, "arrive");
      assertEquals(payload.move_type, "teleport");
    });

    await t.step("arrival event recipient_reason is sector_snapshot", async () => {
      const { events } = await eventsSince(player1Id, cursorP1);
      const arrivals = events.filter(
        (e) =>
          e.event_type === "character.moved" &&
          e.payload?.movement === "arrive",
      );
      assert(arrivals.length >= 1);
      assertEquals(arrivals[0].recipient_reasons[0], "sector_snapshot");
    });

    await t.step("player 2 does not receive own character.moved", async () => {
      // Player 2's events should only be status.snapshot and map.local,
      // not character.moved (that's for observers)
      const p2Cursor = cursorP1; // Use same baseline
      const { events } = await eventsSince(player2Id, p2Cursor);
      const p2Moved = events.filter(
        (e) => e.event_type === "character.moved",
      );
      assertEquals(
        p2Moved.length,
        0,
        "Player 2 should not receive own character.moved from join",
      );
    });
  },
});

// ============================================================================
// Group 5: Departure events
// ============================================================================

Deno.test({
  name: "join lifecycle — departure events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player2Id = await characterIdFor(PLAYER_2);

    await t.step("reset and place both players in sector 0", async () => {
      await resetDatabase([PLAYER_1, PLAYER_2]);
      await apiOk("join", { character_id: player1Id, sector: 0 });
      await apiOk("join", { character_id: player2Id, sector: 0 });
    });

    let cursorP1: number;

    await t.step("capture cursor, then player 2 departs to sector 1", async () => {
      cursorP1 = await getEventCursor(player1Id);

      // Player 2 joins sector 1 — departs sector 0
      const result = await apiOk("join", {
        character_id: player2Id,
        sector: 1,
        request_id: "test-p2-depart",
      });
      assert(result.success);
    });

    await t.step("player 1 receives character.moved depart event", async () => {
      const { events } = await eventsSince(player1Id, cursorP1);
      const departures = events.filter(
        (e) =>
          e.event_type === "character.moved" &&
          e.payload?.movement === "depart",
      );

      assert(
        departures.length >= 1,
        `Expected depart event. Events: ${JSON.stringify(events.map((e) => ({ type: e.event_type, movement: e.payload?.movement })))}`,
      );

      const departure = departures[0];
      assertEquals(departure.recipient_ids[0], player1Id);

      const payload = departure.payload;
      assertEquals(payload.movement, "depart");
      assertEquals(payload.move_type, "teleport");

      const player = payload.player as Record<string, unknown>;
      assertEquals(player.id, player2Id);
      assertEquals(player.name, PLAYER_2);
    });

    await t.step("player 1 does NOT receive arrive event (not in target sector)", async () => {
      // Player 1 is in sector 0, player 2 moved to sector 1.
      // Player 1 should only see the departure, not the arrival.
      const { events } = await eventsSince(player1Id, cursorP1);
      const arrivals = events.filter(
        (e) =>
          e.event_type === "character.moved" &&
          e.payload?.movement === "arrive",
      );
      assertEquals(
        arrivals.length,
        0,
        "Player 1 should not see arrive event in a different sector",
      );
    });
  },
});

// ============================================================================
// Group 6: Self-event filtering
// ============================================================================

Deno.test({
  name: "join lifecycle — self-event filtering",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player2Id = await characterIdFor(PLAYER_2);

    await t.step("reset and set up: player 2 in sector 0, player 1 in sector 1", async () => {
      await resetDatabase([PLAYER_1, PLAYER_2]);
      // Player 2 in sector 0 as observer
      await apiOk("join", { character_id: player2Id, sector: 0 });
      // Player 1 starts in sector 1
      await apiOk("join", { character_id: player1Id, sector: 1 });
    });

    await t.step("player 1 joining sector 0: gets snapshot, not own character.moved", async () => {
      await clearEvents();
      const cursor = await getEventCursor(player1Id);

      // Player 1 joins sector 0 (from sector 1)
      await apiOk("join", { character_id: player1Id, sector: 0 });

      const { events } = await eventsSince(player1Id, cursor);
      const eventTypes = events.map((e) => e.event_type);

      // Should receive status.snapshot and map.local (self-directed)
      assert(
        eventTypes.includes("status.snapshot"),
        `Expected status.snapshot in: ${JSON.stringify(eventTypes)}`,
      );
      assert(
        eventTypes.includes("map.local"),
        `Expected map.local in: ${JSON.stringify(eventTypes)}`,
      );

      // Should NOT receive character.moved for self
      const selfMoved = events.filter(
        (e) => e.event_type === "character.moved",
      );
      assertEquals(
        selfMoved.length,
        0,
        "Player should not receive own character.moved from join",
      );
    });

    await t.step("but observer (player 2) DOES get character.moved for player 1", async () => {
      // Player 2 was in sector 0, should have seen player 1 arrive
      // We cleared events earlier, so need to look at events since the clear
      const { events } = await eventsSince(player2Id, 0);
      const arrivals = events.filter(
        (e) =>
          e.event_type === "character.moved" &&
          e.payload?.movement === "arrive",
      );
      assert(
        arrivals.length >= 1,
        `Player 2 should see player 1's arrival. Events: ${JSON.stringify(events.map((e) => e.event_type))}`,
      );
      const payload = arrivals[0].payload;
      const player = payload.player as Record<string, unknown>;
      assertEquals(player.id, player1Id);
    });
  },
});

// ============================================================================
// Group 7: events_since behavior
// ============================================================================

Deno.test({
  name: "join lifecycle — events_since endpoint",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);

    await t.step("reset and join player 1", async () => {
      await resetDatabase([PLAYER_1]);
      await apiOk("join", { character_id: player1Id });
    });

    await t.step("initial_only returns last_event_id with empty events", async () => {
      const result = await apiOk<{
        events: unknown[];
        last_event_id: number | null;
        has_more: boolean;
      }>("events_since", {
        character_id: player1Id,
        initial_only: true,
      });
      assert(result.success);
      assertEquals(result.events.length, 0);
      assert(
        typeof result.last_event_id === "number" && result.last_event_id > 0,
        "last_event_id should be a positive number",
      );
      assertEquals(result.has_more, false);
    });

    await t.step("events_since with high cursor returns no events", async () => {
      const { events } = await eventsSince(player1Id, 999999);
      assertEquals(events.length, 0);
    });

    await t.step("events_since with cursor 0 returns all events", async () => {
      const { events, lastEventId } = await eventsSince(player1Id, 0);
      assert(events.length > 0, "Should have events from join");
      assert(
        typeof lastEventId === "number" && lastEventId > 0,
        "lastEventId should be positive",
      );
    });
  },
});

// ============================================================================
// Group 8: Error cases
// ============================================================================

Deno.test({
  name: "join lifecycle — error cases",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset database", async () => {
      await resetDatabase([]);
    });

    await t.step("join with non-existent character returns error", async () => {
      const result = await api("join", {
        character_id: "00000000-0000-0000-0000-000000000099",
        request_id: "test-join-invalid",
      });
      assert(!result.body.success);
      assert(
        result.status === 404 || result.status === 500,
        `Expected 404 or 500, got ${result.status}: ${result.body.error}`,
      );
    });

    await t.step("events_since without character_id returns 400", async () => {
      const result = await api("events_since", {
        since_event_id: 0,
      });
      assert(!result.body.success);
      assertEquals(result.status, 400);
    });

    await t.step("join with empty body returns error", async () => {
      const result = await api("join", {});
      assert(!result.body.success);
      assert(
        result.status === 400 || result.status === 500,
        `Expected 400 or 500, got ${result.status}`,
      );
    });
  },
});

// ============================================================================
// Group 9: Healthcheck branch
// ============================================================================

Deno.test({
  name: "join — healthcheck branch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const result = await apiOk("join", { healthcheck: true });
    assert(result.success);
    assertEquals(
      (result as Record<string, unknown>).status,
      "ok",
    );
  },
});

// ============================================================================
// Group 10: Invalid JSON body
// ============================================================================

Deno.test({
  name: "join — invalid JSON body",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const result = await apiRaw("join", "not valid json!!");
    assert(!result.body.success);
    assert(
      result.status === 400 || result.status === 500,
      `Expected 400 or 500 for invalid JSON, got ${result.status}`,
    );
  },
});

// ============================================================================
// Group 11: Rate limiting (429)
// ============================================================================

Deno.test({
  name: "join — rate limiting returns 429",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);

    await t.step("reset and create player 1", async () => {
      await resetDatabase([PLAYER_1]);
    });

    await t.step("pre-fill rate_limits to exceed threshold", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `INSERT INTO rate_limits (character_id, endpoint, window_start, request_count)
           VALUES ($1, 'join', date_trunc('minute', NOW()), 201)
           ON CONFLICT (character_id, endpoint, window_start)
           DO UPDATE SET request_count = 201`,
          [player1Id],
        );
      });
    });

    await t.step("join returns 429", async () => {
      const result = await api("join", { character_id: player1Id });
      assert(!result.body.success);
      assertEquals(result.status, 429);
    });
  },
});

// ============================================================================
// Group 12: Character with no ship
// ============================================================================

Deno.test({
  name: "join — character with no ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);

    await t.step("reset and create player 1", async () => {
      await resetDatabase([PLAYER_1]);
    });

    await t.step("remove ship link from character", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE characters SET current_ship_id = NULL WHERE character_id = $1`,
          [player1Id],
        );
      });
    });

    await t.step("join returns error about no ship", async () => {
      const result = await api("join", { character_id: player1Id });
      assert(!result.body.success);
      assert(
        result.status === 500 || result.status === 404,
        `Expected 500 or 404, got ${result.status}`,
      );
    });
  },
});

// ============================================================================
// Group 13: Actor character_id (matching — success path)
// ============================================================================

Deno.test({
  name: "join — actor_character_id matching succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);

    await t.step("reset and create player 1", async () => {
      await resetDatabase([PLAYER_1]);
    });

    await t.step("join with matching actor_character_id succeeds", async () => {
      const result = await apiOk("join", {
        character_id: player1Id,
        actor_character_id: player1Id,
      });
      assert(result.success);
    });
  },
});

// ============================================================================
// Group 14: Actor authorization error (mismatch)
// ============================================================================

Deno.test({
  name: "join — actor_character_id mismatch returns 403",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player2Id = await characterIdFor(PLAYER_2);

    await t.step("reset and create both players", async () => {
      await resetDatabase([PLAYER_1, PLAYER_2]);
    });

    await t.step("join player 1 with player 2 as actor returns 403", async () => {
      const result = await api("join", {
        character_id: player1Id,
        actor_character_id: player2Id,
      });
      assert(!result.body.success);
      assertEquals(result.status, 403);
    });
  },
});

// ============================================================================
// Group 15: Ship with null ship_name (fallback to display_name)
// ============================================================================

Deno.test({
  name: "join — null ship_name uses display_name fallback",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player1ShipId = await shipIdFor(PLAYER_1);

    await t.step("reset and create player 1", async () => {
      await resetDatabase([PLAYER_1]);
    });

    await t.step("set ship_name to NULL", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances SET ship_name = NULL WHERE ship_id = $1`,
          [player1ShipId],
        );
      });
    });

    await t.step("join succeeds and snapshot has ship type name", async () => {
      await clearEvents();
      await apiOk("join", { character_id: player1Id });

      const snapshots = await eventsOfType(player1Id, "status.snapshot");
      assert(snapshots.length >= 1);
      const payload = snapshots[0].payload;
      const ship = payload.ship as Record<string, unknown>;
      assertExists(ship, "payload.ship");
      // ship_name should be populated from shipDefinition.display_name
      assert(
        typeof ship.ship_name === "string" && ship.ship_name.length > 0,
        `ship_name should be a non-empty string from display_name, got: ${ship.ship_name}`,
      );
    });
  },
});

// ============================================================================
// Group 16: Combat auto-join + combat.round_waiting
// ============================================================================

Deno.test({
  name: "join — auto-join existing combat emits combat.round_waiting",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    player1Id = await characterIdFor(PLAYER_1);
    player2Id = await characterIdFor(PLAYER_2);
    player1ShipId = await shipIdFor(PLAYER_1);

    await t.step("reset and join both players to sector 0", async () => {
      await resetDatabase([PLAYER_1, PLAYER_2]);
      await apiOk("join", { character_id: player1Id, sector: 0 });
      await apiOk("join", { character_id: player2Id, sector: 0 });
    });

    await t.step("insert combat state with player 1 as participant", async () => {
      await withPg(async (pg) => {
        const combatState = JSON.stringify({
          combat_id: "test-combat-001",
          sector_id: 0,
          round: 1,
          deadline: null,
          participants: {
            [player1Id]: {
              combatant_id: player1Id,
              combatant_type: "character",
              name: PLAYER_1,
              fighters: 10,
              shields: 100,
              turns_per_warp: 3,
              max_fighters: 50,
              max_shields: 100,
              is_escape_pod: false,
              owner_character_id: player1Id,
              ship_type: "merchant_cruiser",
            },
          },
          pending_actions: {},
          logs: [],
          context: {},
          awaiting_resolution: false,
          ended: false,
          end_state: null,
          base_seed: 42,
          last_updated: new Date().toISOString(),
        });
        await pg.queryObject(
          `UPDATE sector_contents SET combat = $1::jsonb WHERE sector_id = 0`,
          [combatState],
        );
      });
    });

    await t.step("player 2 re-joins and receives combat.round_waiting", async () => {
      await clearEvents();
      const cursor = await getEventCursor(player2Id);

      await apiOk("join", { character_id: player2Id, sector: 0 });

      const { events } = await eventsSince(player2Id, cursor);
      const combatEvents = events.filter(
        (e) => e.event_type === "combat.round_waiting",
      );

      assert(
        combatEvents.length >= 1,
        `Expected combat.round_waiting event. Events: ${JSON.stringify(events.map((e) => e.event_type))}`,
      );

      const payload = combatEvents[0].payload;
      assertEquals(payload.combat_id, "test-combat-001");
      assertEquals(payload.round, 1);
      assertExists(payload.participants, "payload should have participants");
    });

    await t.step("player 1 re-joins: already in combat, still gets combat.round_waiting", async () => {
      // Player 1 is already a participant in the combat — covers autoJoinExistingCombat
      // "Character already in combat" path (lines 413-416)
      await clearEvents();
      const cursor = await getEventCursor(player1Id);

      await apiOk("join", { character_id: player1Id, sector: 0 });

      const { events } = await eventsSince(player1Id, cursor);
      const combatEvents = events.filter(
        (e) => e.event_type === "combat.round_waiting",
      );
      assert(
        combatEvents.length >= 1,
        `Player already in combat should still get combat.round_waiting. Events: ${JSON.stringify(events.map((e) => e.event_type))}`,
      );
    });

    await t.step("clean up combat state", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE sector_contents SET combat = NULL WHERE sector_id = 0`,
        );
      });
    });
  },
});

// ============================================================================
// Group 17: Auth token validation
// ============================================================================

Deno.test({
  name: "join — auth token validation returns 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const originalToken = Deno.env.get("EDGE_API_TOKEN");

    await t.step("set EDGE_API_TOKEN and send unauthenticated request", async () => {
      Deno.env.set("EDGE_API_TOKEN", "test-secret-123");

      const result = await api("join", { character_id: "anything" });
      assert(!result.body.success);
      assertEquals(result.status, 401);
    });

    await t.step("restore original env", () => {
      if (originalToken) {
        Deno.env.set("EDGE_API_TOKEN", originalToken);
      } else {
        Deno.env.delete("EDGE_API_TOKEN");
      }
    });
  },
});
