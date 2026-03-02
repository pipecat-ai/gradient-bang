/**
 * Integration tests for exploration, corp ship map knowledge, and task-operated movement.
 *
 * Tests cover:
 *   - Personal exploration updates map knowledge (sectors_visited grows)
 *   - Corp ship exploration updates corporation_map_knowledge
 *   - Corp members see corp discoveries in list_known_ports
 *   - Task-operated movement with actor_character_id + task_id
 *   - map.update event routing: corp members notified, non-members not
 *
 * Setup: 3 players in sector 0. P1+P2 will form a corp. P3 is independent.
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
  queryEvents,
  assertNoEventsOfType,
  setShipCredits,
  setShipSector,
  createCorpShip,
  queryCorpMapKnowledge,
  withPg,
} from "./helpers.ts";

const P1 = "test_explore_p1";
const P2 = "test_explore_p2";
const P3 = "test_explore_p3";

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
  name: "exploration — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Personal exploration updates map knowledge
// ============================================================================

Deno.test({
  name: "exploration — personal map knowledge grows with movement",
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
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("initial knowledge has only sector 0", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      const knowledge = char.map_knowledge as Record<string, unknown>;
      const visited = knowledge.sectors_visited as Record<string, unknown>;
      assertExists(visited["0"], "Sector 0 should be in sectors_visited");
      assertEquals(visited["1"], undefined, "Sector 1 should not be visited yet");
      assertEquals(knowledge.total_sectors_visited, 1);
    });

    let cursorP1: number;

    await t.step("capture cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P1 moves to sector 1", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("DB: sector 1 now in sectors_visited", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      const knowledge = char.map_knowledge as Record<string, unknown>;
      const visited = knowledge.sectors_visited as Record<string, unknown>;
      assertExists(visited["1"], "Sector 1 should now be in sectors_visited");
      assertEquals(knowledge.total_sectors_visited, 2);
      // Sector entry should have adjacency and position data
      const entry = visited["1"] as Record<string, unknown>;
      assertExists(entry.last_visited, "Should have last_visited timestamp");
    });

    await t.step("movement.complete has first_visit: true", async () => {
      const events = await eventsOfType(p1Id, "movement.complete", cursorP1);
      assert(events.length >= 1, `Expected >= 1 movement.complete, got ${events.length}`);
      assertEquals(events[0].payload.first_visit, true);
    });

    await t.step("P1 receives map.update on first visit", async () => {
      const events = await eventsOfType(p1Id, "map.update", cursorP1);
      assert(events.length >= 1, `Expected >= 1 map.update, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.sectors, "map.update should have sectors");
    });

    await t.step("P1 moves 1 → 3", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
    });

    await t.step("DB: total_sectors_visited is 3", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      const knowledge = char.map_knowledge as Record<string, unknown>;
      assertEquals(knowledge.total_sectors_visited, 3);
      const visited = knowledge.sectors_visited as Record<string, unknown>;
      assertExists(visited["0"], "Should still have sector 0");
      assertExists(visited["1"], "Should still have sector 1");
      assertExists(visited["3"], "Should now have sector 3");
    });

    await t.step("revisiting sector 1 does not emit map.update", async () => {
      const cursor = await getEventCursor(p1Id);
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      const complete = await eventsOfType(p1Id, "movement.complete", cursor);
      assert(complete.length >= 1);
      assertEquals(complete[0].payload.first_visit, false, "Should not be first visit");
      await assertNoEventsOfType(p1Id, "map.update", cursor);
    });
  },
});

// ============================================================================
// Group 2: Corp ship exploration updates corporation map knowledge
// ============================================================================

Deno.test({
  name: "exploration — corp ship updates corporation map knowledge",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and create corp with corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);

      // Create corporation
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Explore Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>).invite_code as string;

      // P2 joins corp
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });

      // Create corp ship at sector 0
      const ship = await createCorpShip(corpId, 0, "Explorer");
      corpShipId = ship.shipId;
    });

    await t.step("corp has no map knowledge initially", async () => {
      const knowledge = await queryCorpMapKnowledge(corpId);
      // Row may not exist or sectors_visited should be empty
      if (knowledge) {
        const mk = knowledge.map_knowledge as Record<string, unknown>;
        const visited = mk?.sectors_visited as Record<string, unknown> | undefined;
        // If it exists, should not have sector 1
        assert(
          !visited || !visited["1"],
          "Corp should not know about sector 1 yet",
        );
      }
    });

    await t.step("move corp ship to sector 1 via actor", async () => {
      const result = await apiOk("move", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        to_sector: 1,
      });
      assert(result.success);
    });

    await t.step("DB: corporation_map_knowledge now has sector 1", async () => {
      const knowledge = await queryCorpMapKnowledge(corpId);
      assertExists(knowledge, "Corp map knowledge row should exist");
      const mk = knowledge.map_knowledge as Record<string, unknown>;
      const visited = mk.sectors_visited as Record<string, unknown>;
      assertExists(visited["1"], "Corp should now know about sector 1");
    });

    await t.step("DB: pseudo-character personal knowledge NOT updated", async () => {
      const char = await queryCharacter(corpShipId);
      assertExists(char);
      const mk = char.map_knowledge as Record<string, unknown>;
      const visited = mk.sectors_visited as Record<string, unknown>;
      // Corp ships write to corp table, not personal knowledge
      assertEquals(
        visited["1"],
        undefined,
        "Pseudo-character should NOT have sector 1 in personal knowledge",
      );
    });

    await t.step("move corp ship 1 → 3", async () => {
      await apiOk("move", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        to_sector: 3,
      });
    });

    await t.step("DB: corp knowledge has sectors 1 and 3", async () => {
      const knowledge = await queryCorpMapKnowledge(corpId);
      assertExists(knowledge);
      const mk = knowledge.map_knowledge as Record<string, unknown>;
      const visited = mk.sectors_visited as Record<string, unknown>;
      assertExists(visited["1"], "Corp should still know sector 1");
      assertExists(visited["3"], "Corp should now know sector 3");
    });
  },
});

// ============================================================================
// Group 3: Corp members see corp discoveries in list_known_ports
// ============================================================================

Deno.test({
  name: "exploration — corp members see corp-discovered ports",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and setup corp ship exploration", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);

      // Create corp
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Port Scout Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>).invite_code as string;

      // P2 joins corp
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });

      // Create corp ship and explore sectors with ports
      const ship = await createCorpShip(corpId, 0, "Port Scout");
      corpShipId = ship.shipId;

      // Move corp ship: 0 → 1 (BBS port) → 3 (BSS port)
      await apiOk("move", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        to_sector: 1,
      });
      await apiOk("move", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        to_sector: 3,
      });
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P2 (corp member) sees corp-discovered ports", async () => {
      await apiOk("list_known_ports", { character_id: p2Id });
      const events = await eventsOfType(p2Id, "ports.list", cursorP2);
      assert(events.length >= 1, `Expected >= 1 ports.list, got ${events.length}`);
      const ports = events[0].payload.ports as Array<Record<string, unknown>>;
      assertExists(ports, "payload.ports");
      // Port entries have nested structure: { sector: { id, position, port }, ... }
      const sectorIds = ports.map((p) => {
        const sector = p.sector as Record<string, unknown> | undefined;
        return sector?.id;
      });
      const hasSector1 = sectorIds.some((id) => String(id) === "1");
      const hasSector3 = sectorIds.some((id) => String(id) === "3");
      assert(
        hasSector1 || hasSector3,
        `P2 should see corp-discovered ports at sectors 1/3, got: ${JSON.stringify(sectorIds)}`,
      );
    });

    let cursorP3: number;

    await t.step("capture P3 cursor", async () => {
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P3 (non-member) does NOT see corp ports", async () => {
      await apiOk("list_known_ports", { character_id: p3Id });
      const events = await eventsOfType(p3Id, "ports.list", cursorP3);
      assert(events.length >= 1, `Expected >= 1 ports.list, got ${events.length}`);
      const ports = events[0].payload.ports as Array<Record<string, unknown>>;
      assertExists(ports, "payload.ports");
      // P3 only knows sector 0 (no port), should not see sectors 1/3
      const sectorIds = ports.map((p) => {
        const sector = p.sector as Record<string, unknown> | undefined;
        return sector?.id;
      });
      const hasSector1 = sectorIds.some((id) => String(id) === "1");
      const hasSector3 = sectorIds.some((id) => String(id) === "3");
      assert(
        !hasSector1 && !hasSector3,
        `P3 should NOT see corp ports at sectors 1/3, got: ${JSON.stringify(sectorIds)}`,
      );
    });
  },
});

// ============================================================================
// Group 4: Task-operated movement
// ============================================================================

Deno.test({
  name: "exploration — task-operated corp ship movement",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;
    const taskId = crypto.randomUUID();

    await t.step("reset and create corp + corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Task Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>).invite_code as string;

      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });

      const ship = await createCorpShip(corpId, 0, "Task Ship");
      corpShipId = ship.shipId;
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("emit task.start", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);

      const result = await apiOk("task_lifecycle", {
        character_id: corpShipId,
        task_id: taskId,
        event_type: "start",
        task_description: "Explore sector 1",
        actor_character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("P2 (corp member) receives task.start", async () => {
      const events = await eventsOfType(p2Id, "task.start", cursorP2, corpId);
      assert(events.length >= 1, `Expected >= 1 task.start for P2, got ${events.length}`);
      const payload = events[0].payload;
      assertEquals(payload.task_id, taskId);
    });

    await t.step("move corp ship with task_id", async () => {
      await apiOk("move", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        to_sector: 1,
      });
    });

    await t.step("DB: event records have task_id set", async () => {
      const events = await queryEvents("task_id = $1", [taskId]);
      assert(events.length >= 1, `Expected events with task_id, got ${events.length}`);
    });

    await t.step("emit task.finish", async () => {
      const result = await apiOk("task_lifecycle", {
        character_id: corpShipId,
        task_id: taskId,
        event_type: "finish",
        task_summary: "Found port in sector 1",
        actor_character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("DB: task.start and task.finish events exist", async () => {
      const events = await queryEvents(
        "task_id = $1 AND event_type IN ('task.start', 'task.finish')",
        [taskId],
      );
      const types = events.map((e) => e.event_type);
      assert(types.includes("task.start"), "Should have task.start event");
      assert(types.includes("task.finish"), "Should have task.finish event");
    });
  },
});

// ============================================================================
// Group 5: map.update routing — corp members notified, non-members not
// ============================================================================

Deno.test({
  name: "exploration — map.update sent to corp members, not non-members",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup corp (P1+P2), P3 independent", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Map Update Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>).invite_code as string;

      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    let cursorP1: number;
    let cursorP2: number;
    let cursorP3: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P1 moves to sector 1 (first visit, not known to corp)", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("P1 receives map.update", async () => {
      const events = await eventsOfType(p1Id, "map.update", cursorP1);
      assert(events.length >= 1, `Expected >= 1 map.update for P1, got ${events.length}`);
      const payload = events[0].payload;
      assertExists(payload.sectors, "map.update should have sectors");
    });

    await t.step("P2 receives map.update (corp member)", async () => {
      const events = await eventsOfType(p2Id, "map.update", cursorP2, corpId);
      assert(events.length >= 1, `Expected >= 1 map.update for P2 (corp), got ${events.length}`);
    });

    await t.step("P3 does NOT receive map.update (non-member)", async () => {
      await assertNoEventsOfType(p3Id, "map.update", cursorP3);
    });
  },
});
