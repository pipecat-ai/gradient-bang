/**
 * Integration tests for event deduplication.
 *
 * These tests verify that the event system delivers exactly one copy of each
 * logical event to each player, regardless of whether the player is:
 *   - a solo player (no corporation)
 *   - the event subject in a corporation
 *   - a corp observer (same corp, different player)
 *   - in a different corporation (isolation)
 *
 * Known bug being tested (TDD-style — these tests define correct behavior):
 *   When a corp member is the event subject, record_event_with_recipients
 *   creates an individual row (self-event exception) AND a corp row. When
 *   events_since is polled with both character_id and corp_id, both rows
 *   match, producing a duplicate.
 *
 * Setup: P1, P2 in Corp A. P3 is solo (no corp). P4 in Corp B.
 * All in sector 0 (mega-port).
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
  queryCharacter,
  queryShip,
  eventsSince,
  eventsOfType,
  getEventCursor,
  setShipCredits,
  setShipFighters,
  setShipWarpPower,
  setShipCargo,
  setShipSector,
  setMegabankBalance,
  withPg,
  queryEvents,
  type EventRow,
} from "./helpers.ts";

const P1 = "test_events_p1";
const P2 = "test_events_p2";
const P3 = "test_events_p3";
const P4 = "test_events_p4";

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p4Id: string;
let p1ShipId: string;
let p2ShipId: string;
let p3ShipId: string;
let p4ShipId: string;

let corpAId: string;
let corpBId: string;

/** Count events by type from a list. */
function countByType(events: EventRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Query raw event rows from the DB for a given request_id.
 * Returns all denormalized rows (individual + corp + broadcast).
 */
async function queryRawEventRows(
  requestId: string,
): Promise<Record<string, unknown>[]> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT id, event_type, recipient_character_id, recipient_reason,
              corp_id, is_broadcast, character_id, scope
       FROM events
       WHERE request_id = $1
       ORDER BY id ASC`,
      [requestId],
    );
    return result.rows;
  });
}

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "event_dedup — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Setup — create corps and resolve IDs
// ============================================================================

Deno.test({
  name: "event_dedup — setup players and corporations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("resolve IDs", async () => {
      p1Id = await characterIdFor(P1);
      p2Id = await characterIdFor(P2);
      p3Id = await characterIdFor(P3);
      p4Id = await characterIdFor(P4);
      p1ShipId = await shipIdFor(P1);
      p2ShipId = await shipIdFor(P2);
      p3ShipId = await shipIdFor(P3);
      p4ShipId = await shipIdFor(P4);
    });

    await t.step("reset and join all players", async () => {
      await resetDatabase([P1, P2, P3, P4]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await apiOk("join", { character_id: p4Id });
    });

    await t.step("create Corp A (P1 + P2)", async () => {
      await setShipCredits(p1ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Event Test Corp A",
      });
      corpAId = (result as Record<string, unknown>).corp_id as string;
      const inviteCode = (result as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpAId,
        invite_code: inviteCode,
      });
    });

    await t.step("create Corp B (P4)", async () => {
      await setShipCredits(p4ShipId, 50000);
      const result = await apiOk("corporation_create", {
        character_id: p4Id,
        name: "Event Test Corp B",
      });
      corpBId = (result as Record<string, unknown>).corp_id as string;
    });

    await t.step("verify corp membership", async () => {
      const c1 = await queryCharacter(p1Id);
      const c2 = await queryCharacter(p2Id);
      const c3 = await queryCharacter(p3Id);
      const c4 = await queryCharacter(p4Id);
      assertExists(c1);
      assertExists(c2);
      assertExists(c3);
      assertExists(c4);
      assertEquals(c1.corporation_id, corpAId, "P1 in Corp A");
      assertEquals(c2.corporation_id, corpAId, "P2 in Corp A");
      assertEquals(c3.corporation_id, null, "P3 solo");
      assertEquals(c4.corporation_id, corpBId, "P4 in Corp B");
    });
  },
});

// ============================================================================
// Group 2: Baseline — solo player gets exactly 1 event per action
// ============================================================================

Deno.test({
  name: "event_dedup — solo player (no corp) gets no duplicates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: give P3 credits and low warp", async () => {
      await setShipCredits(p3ShipId, 50000);
      await setShipWarpPower(p3ShipId, 100);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p3Id);
    });

    await t.step("P3 recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p3Id,
        units: 50,
      });
    });

    await t.step("P3 gets exactly 1 warp.purchase and 1 status.update", async () => {
      // Poll without corp_id (P3 has no corp)
      const { events } = await eventsSince(p3Id, cursor);
      const counts = countByType(events);
      assertEquals(
        counts["warp.purchase"],
        1,
        `Expected 1 warp.purchase, got ${counts["warp.purchase"]}`,
      );
      assertEquals(
        counts["status.update"],
        1,
        `Expected 1 status.update, got ${counts["status.update"]}`,
      );
    });
  },
});

// ============================================================================
// Group 3: Corp member (event subject) — the core duplicate bug
// This tests polling with character_id + corp_id, which is how the
// client/bot polls when in a corporation.
// ============================================================================

Deno.test({
  name: "event_dedup — corp member (subject) gets no duplicates on recharge_warp_power",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: give P1 credits and low warp", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 100);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 50,
      });
    });

    await t.step("P1 polls WITH corp_id: exactly 1 warp.purchase, 1 status.update", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["warp.purchase"],
        1,
        `Expected 1 warp.purchase, got ${counts["warp.purchase"]}. ` +
          `Duplicate bug: event subject in corp gets individual row + corp row.`,
      );
      assertEquals(
        counts["status.update"],
        1,
        `Expected 1 status.update, got ${counts["status.update"]}. ` +
          `Duplicate bug: event subject in corp gets individual row + corp row.`,
      );
    });
  },
});

// ============================================================================
// Group 4: Corp member (subject) — purchase_fighters duplicate
// ============================================================================

Deno.test({
  name: "event_dedup — corp member (subject) gets no duplicates on purchase_fighters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipFighters(p1ShipId, 100);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 purchases fighters", async () => {
      await apiOk("purchase_fighters", {
        character_id: p1Id,
        units: 10,
      });
    });

    await t.step("P1 polls WITH corp_id: exactly 1 fighter.purchase, 1 status.update", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["fighter.purchase"],
        1,
        `Expected 1 fighter.purchase, got ${counts["fighter.purchase"]}. ` +
          `Duplicate bug: event subject in corp gets individual row + corp row.`,
      );
      assertEquals(
        counts["status.update"],
        1,
        `Expected 1 status.update, got ${counts["status.update"]}. ` +
          `Duplicate bug: event subject in corp gets individual row + corp row.`,
      );
    });
  },
});

// ============================================================================
// Group 5: Corp member (subject) — trade duplicate
// ============================================================================

Deno.test({
  name: "event_dedup — corp member (subject) gets no duplicates on trade",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: move P1 to sector 1 (has port), give cargo", async () => {
      // Sector 1 has a port that buys quantum_foam
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances
           SET current_sector = 1, in_hyperspace = false
           WHERE ship_id = $1`,
          [p1ShipId],
        );
      });
      await setShipCredits(p1ShipId, 50000);
      await setShipCargo(p1ShipId, { qf: 50, ro: 0, ns: 0 });
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 sells quantum_foam to port", async () => {
      await apiOk("trade", {
        character_id: p1Id,
        trade_type: "sell",
        commodity: "quantum_foam",
        quantity: 5,
      });
    });

    await t.step("P1 polls WITH corp_id: exactly 1 of each trade event type", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      // trade emits: trade.executed, status.update, port.update
      for (const eventType of ["trade.executed", "status.update", "port.update"]) {
        const count = counts[eventType] ?? 0;
        assert(count > 0, `Expected at least 1 ${eventType}`);
        assertEquals(
          count,
          1,
          `Expected 1 ${eventType}, got ${count}. ` +
            `Duplicate bug: event subject in corp gets individual row + corp row.`,
        );
      }
    });

    await t.step("cleanup: move P1 back to sector 0", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances
           SET current_sector = 0, in_hyperspace = false
           WHERE ship_id = $1`,
          [p1ShipId],
        );
      });
    });
  },
});

// ============================================================================
// Group 6: Corp member (subject) — dump_cargo duplicate
// ============================================================================

Deno.test({
  name: "event_dedup — corp member (subject) gets no duplicates on dump_cargo",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: move P1 to non-fedspace, give cargo", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances
           SET current_sector = 3, in_hyperspace = false
           WHERE ship_id = $1`,
          [p1ShipId],
        );
      });
      await setShipCargo(p1ShipId, { qf: 20, ro: 0, ns: 0 });
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 dumps cargo", async () => {
      await apiOk("dump_cargo", {
        character_id: p1Id,
        items: { quantum_foam: 5 },
      });
    });

    await t.step("P1 polls WITH corp_id: exactly 1 salvage.created, 1 status.update", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["salvage.created"],
        1,
        `Expected 1 salvage.created, got ${counts["salvage.created"]}. ` +
          `Duplicate bug: event subject in corp gets individual row + corp row.`,
      );
      assertEquals(
        counts["status.update"],
        1,
        `Expected 1 status.update, got ${counts["status.update"]}. ` +
          `Duplicate bug: event subject in corp gets individual row + corp row.`,
      );
    });

    await t.step("cleanup: move P1 back to sector 0", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances
           SET current_sector = 0, in_hyperspace = false
           WHERE ship_id = $1`,
          [p1ShipId],
        );
      });
    });
  },
});

// ============================================================================
// Group 7: Corp member (subject) — join() duplicate
// The join endpoint emits status.snapshot and map.local with corpId.
// ============================================================================

Deno.test({
  name: "event_dedup — corp member (subject) gets no duplicates on join",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 re-joins", async () => {
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("P1 polls WITH corp_id: exactly 1 status.snapshot, 1 map.local", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["status.snapshot"],
        1,
        `Expected 1 status.snapshot, got ${counts["status.snapshot"]}. ` +
          `Duplicate bug: join emits with corpId, subject gets individual + corp row.`,
      );
      assertEquals(
        counts["map.local"],
        1,
        `Expected 1 map.local, got ${counts["map.local"]}. ` +
          `Duplicate bug: join emits with corpId, subject gets individual + corp row.`,
      );
    });
  },
});

// ============================================================================
// Group 8: Corp member polling WITHOUT corp_id — no duplicate
// When polling without corp_id, the corp row is never matched.
// This should always work (no bug).
// ============================================================================

Deno.test({
  name: "event_dedup — corp member polling WITHOUT corp_id sees no duplicates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 100);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 30,
      });
    });

    await t.step("P1 polls WITHOUT corp_id: exactly 1 of each", async () => {
      // Poll with only character_id (no corp_id)
      const { events } = await eventsSince(p1Id, cursor);
      const counts = countByType(events);
      assertEquals(
        counts["warp.purchase"],
        1,
        `Expected 1 warp.purchase, got ${counts["warp.purchase"]}`,
      );
      assertEquals(
        counts["status.update"],
        1,
        `Expected 1 status.update, got ${counts["status.update"]}`,
      );
    });
  },
});

// ============================================================================
// Group 9: Corp observer (same corp, different player) — no duplicates
// P2 is in Corp A with P1. When P1 does an action, P2 should get exactly
// 1 copy via the corp row.
// ============================================================================

Deno.test({
  name: "event_dedup — corp observer gets exactly 1 event per action",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 100);
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 20,
      });
    });

    await t.step("P2 polls WITH corp_id: exactly 1 warp.purchase, 1 status.update", async () => {
      const { events } = await eventsSince(p2Id, cursorP2, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["warp.purchase"],
        1,
        `Expected 1 warp.purchase for P2, got ${counts["warp.purchase"]}`,
      );
      assertEquals(
        counts["status.update"],
        1,
        `Expected 1 status.update for P2, got ${counts["status.update"]}`,
      );
    });
  },
});

// ============================================================================
// Group 10: Cross-corp isolation — P4 (Corp B) shouldn't see P1's events
// ============================================================================

Deno.test({
  name: "event_dedup — cross-corp isolation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 100);
    });

    let cursorP4: number;

    await t.step("capture P4 cursor", async () => {
      cursorP4 = await getEventCursor(p4Id);
    });

    await t.step("P1 (Corp A) recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 10,
      });
    });

    await t.step("P4 (Corp B) polls: no warp.purchase events from P1", async () => {
      const warpEvents = await eventsOfType(p4Id, "warp.purchase", cursorP4, corpBId);
      // Filter to only events where character_id is P1 (not P4's own events)
      const p1WarpEvents = warpEvents.filter(
        (e) => e.character_id === p1Id,
      );
      assertEquals(
        p1WarpEvents.length,
        0,
        `P4 should NOT see P1's warp.purchase events (cross-corp isolation)`,
      );
    });
  },
});

// ============================================================================
// Group 11: DB-level verification — inspect raw event rows
// After the deduplication fix, a corp member action should create a single
// merged corp row with recipient_character_id set to the subject. No separate
// individual row should exist for the subject.
// ============================================================================

Deno.test({
  name: "event_dedup — DB raw rows: corp member action creates merged corp row (no individual)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let requestId: string;

    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipFighters(p1ShipId, 100);
    });

    await t.step("P1 purchases fighters (capture request_id)", async () => {
      const result = await apiOk("purchase_fighters", {
        character_id: p1Id,
        units: 5,
      });
      requestId = (result as Record<string, unknown>).request_id as string;
      assertExists(requestId, "Should return request_id");
    });

    await t.step("DB: inspect raw event rows for this request", async () => {
      const rows = await queryRawEventRows(requestId);
      // Find fighter.purchase events
      const purchaseRows = rows.filter(
        (r) => r.event_type === "fighter.purchase",
      );

      // No individual row for the subject (self-event exception removed)
      const subjectIndividualRows = purchaseRows.filter(
        (r) =>
          r.recipient_character_id === p1Id && r.corp_id === null,
      );
      assertEquals(
        subjectIndividualRows.length,
        0,
        `Expected 0 individual rows for subject, got ${subjectIndividualRows.length}`,
      );

      // One merged corp row with recipient_character_id = P1 and corp_id = Corp A
      const mergedCorpRows = purchaseRows.filter(
        (r) =>
          r.corp_id === corpAId && r.recipient_character_id === p1Id,
      );
      assertEquals(
        mergedCorpRows.length,
        1,
        `Expected 1 merged corp row, got ${mergedCorpRows.length}`,
      );

      // The merged row should have corp_broadcast reason
      assertEquals(
        mergedCorpRows[0].recipient_reason,
        "corp_broadcast",
        "Merged corp row should have corp_broadcast reason",
      );
    });
  },
});

// ============================================================================
// Group 12: Bank transfer — deposit events with corp
// Tests that bank_transfer events (which emit to target) don't duplicate.
// ============================================================================

Deno.test({
  name: "event_dedup — bank_transfer deposit no duplicates for target",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: give P1 credits", async () => {
      await setShipCredits(p1ShipId, 50000);
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 deposits 500 to P2's bank", async () => {
      await apiOk("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: P2,
        amount: 500,
      });
    });

    await t.step("P2 polls WITH corp_id: exactly 1 bank.transaction", async () => {
      const { events } = await eventsSince(p2Id, cursorP2, corpAId);
      const bankEvents = events.filter(
        (e) => e.event_type === "bank.transaction",
      );
      assertEquals(
        bankEvents.length,
        1,
        `Expected 1 bank.transaction for P2, got ${bankEvents.length}. ` +
          `Duplicate bug: target in corp may get individual + corp row.`,
      );
    });
  },
});

// ============================================================================
// Group 13: Multiple actions in sequence — cumulative duplicate count
// Verifies that duplicates compound across multiple actions.
// ============================================================================

Deno.test({
  name: "event_dedup — multiple actions: no cumulative duplicates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 50);
      await setShipFighters(p1ShipId, 50);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 does 3 actions in sequence", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 10,
      });
      await apiOk("purchase_fighters", {
        character_id: p1Id,
        units: 5,
      });
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 10,
      });
    });

    await t.step("P1 polls WITH corp_id: 2 warp.purchase, 1 fighter.purchase, 3 status.update", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["warp.purchase"],
        2,
        `Expected 2 warp.purchase (2 recharges), got ${counts["warp.purchase"]}. ` +
          `With duplicate bug this would be 4.`,
      );
      assertEquals(
        counts["fighter.purchase"],
        1,
        `Expected 1 fighter.purchase, got ${counts["fighter.purchase"]}. ` +
          `With duplicate bug this would be 2.`,
      );
      assertEquals(
        counts["status.update"],
        3,
        `Expected 3 status.update (one per action), got ${counts["status.update"]}. ` +
          `With duplicate bug this would be 6.`,
      );
    });
  },
});

// ============================================================================
// Group 14: Sector observer who is also a corp member
// P1 and P2 are in the same sector AND same corp.
// When P2 does an action that emits a sector event, P1 should get
// exactly 1 copy (either via sector observer or corp, not both).
// ============================================================================

Deno.test({
  name: "event_dedup — sector observer + corp member gets no duplicates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: ensure P1 and P2 are both in sector 0", async () => {
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE ship_instances SET current_sector = 0, in_hyperspace = false
           WHERE ship_id IN ($1, $2)`,
          [p1ShipId, p2ShipId],
        );
      });
      await setShipCredits(p2ShipId, 50000);
      await setShipWarpPower(p2ShipId, 100);
    });

    let cursorP1: number;

    await t.step("capture P1 cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P2 recharges warp power (P1 is sector observer + corp mate)", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p2Id,
        units: 20,
      });
    });

    await t.step("P1 polls WITH corp_id: at most 1 warp.purchase", async () => {
      const { events } = await eventsSince(p1Id, cursorP1, corpAId);
      const warpEvents = events.filter(
        (e) => e.event_type === "warp.purchase",
      );
      // P1 should see P2's warp purchase exactly once — either from the
      // corp row (corp_id match) or from a sector observer row, but not both.
      assertEquals(
        warpEvents.length,
        1,
        `Expected 1 warp.purchase for P1 as observer, got ${warpEvents.length}. ` +
          `Duplicate if P1 gets both a sector-observer individual row AND a corp row.`,
      );
    });
  },
});

// ============================================================================
// Group 15: ship_rename with corp — event subject duplicate
// ============================================================================

Deno.test({
  name: "event_dedup — ship_rename: corp member gets no duplicates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 renames ship", async () => {
      const name = `EventTest-${Date.now()}`;
      await apiOk("ship_rename", {
        character_id: p1Id,
        ship_name: name,
      });
    });

    await t.step("P1 polls WITH corp_id: exactly 1 ship.renamed", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const renameEvents = events.filter(
        (e) => e.event_type === "ship.renamed",
      );
      assertEquals(
        renameEvents.length,
        1,
        `Expected 1 ship.renamed, got ${renameEvents.length}. ` +
          `Duplicate bug: event subject in corp gets individual row + corp row.`,
      );
    });
  },
});

// ============================================================================
// Group 16: Movement — corp member moving gets duplicate map.local
// map.local is emitted with corpId on every move. The moving player (who
// is a corp member) gets individual row (self-event) + corp row → duplicate.
// ============================================================================

Deno.test({
  name: "event_dedup — movement: corp member gets no duplicate map.local",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: P1 in sector 0 with warp power", async () => {
      await setShipSector(p1ShipId, 0);
      await setShipWarpPower(p1ShipId, 500);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 moves from sector 0 → 1", async () => {
      await apiOk("move", {
        character_id: p1Id,
        to_sector: 1,
      });
    });

    await t.step("P1 polls WITH corp_id: exactly 1 map.local, 1 movement.complete", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["map.local"],
        1,
        `Expected 1 map.local, got ${counts["map.local"]}. ` +
          `Duplicate bug: move emits map.local with corpId, subject gets individual + corp row.`,
      );
      assertEquals(
        counts["movement.complete"],
        1,
        `Expected 1 movement.complete, got ${counts["movement.complete"]}`,
      );
    });

    await t.step("cleanup: move P1 back to sector 0", async () => {
      await setShipSector(p1ShipId, 0);
    });
  },
});

// ============================================================================
// Group 17: Movement — corp member visiting new sector gets duplicate map.update
// map.update is emitted with corpId when visiting a new sector for the first
// time. Same mechanism as map.local → duplicate for the moving player.
// ============================================================================

Deno.test({
  name: "event_dedup — movement: corp member gets no duplicate map.update on new sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    // We need a sector P1 hasn't visited yet. We'll clear P1's map knowledge
    // for sector 2 so the visit counts as "first personal visit".
    await t.step("setup: P1 in sector 0, clear sector 2 from personal knowledge", async () => {
      await setShipSector(p1ShipId, 0);
      await setShipWarpPower(p1ShipId, 500);
      // Clear personal map knowledge for sector 2 so it's treated as first visit
      await withPg(async (pg) => {
        await pg.queryObject(
          `UPDATE characters
           SET map_knowledge = jsonb_set(
             map_knowledge,
             '{sectors_visited}',
             (map_knowledge->'sectors_visited') - '2'
           )
           WHERE character_id = $1
             AND map_knowledge->'sectors_visited' ? '2'`,
          [p1Id],
        );
      });
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 moves from sector 0 → 2 (first visit)", async () => {
      await apiOk("move", {
        character_id: p1Id,
        to_sector: 2,
      });
    });

    await t.step("P1 polls WITH corp_id: at most 1 map.update", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const mapUpdateEvents = events.filter(
        (e) => e.event_type === "map.update",
      );
      // map.update may or may not fire (depends on whether corp already knows
      // the sector). But if it fires, there should be exactly 1.
      if (mapUpdateEvents.length > 0) {
        assertEquals(
          mapUpdateEvents.length,
          1,
          `Expected 0 or 1 map.update, got ${mapUpdateEvents.length}. ` +
            `Duplicate bug: map.update emitted with corpId, subject gets individual + corp row.`,
        );
      }
    });

    await t.step("P1 polls: also exactly 1 map.local", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const counts = countByType(events);
      assertEquals(
        counts["map.local"],
        1,
        `Expected 1 map.local, got ${counts["map.local"]}`,
      );
    });

    await t.step("cleanup: move P1 back to sector 0", async () => {
      await setShipSector(p1ShipId, 0);
    });
  },
});

// ============================================================================
// Group 18: Movement — corp observer sees depart + arrive but no duplicates
// When P1 moves into P2's sector, P2 (same corp, sector observer) should
// get exactly 2 character.moved events (1 depart + 1 arrive), not more.
// The arrival event is NOT duplicated — even though P2 is both a sector
// observer and a corp member, the observer system correctly filters the
// individual row (p_character_id is NULL in observer calls, so there's no
// self-event exception that would keep both individual + corp rows).
// ============================================================================

Deno.test({
  name: "event_dedup — movement: corp observer gets depart + arrive, no duplicates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup: P2 in sector 1, P1 in sector 0", async () => {
      await setShipSector(p2ShipId, 1);
      await setShipSector(p1ShipId, 0);
      await setShipWarpPower(p1ShipId, 500);
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 moves from sector 0 → 1 (where P2 is)", async () => {
      await apiOk("move", {
        character_id: p1Id,
        to_sector: 1,
      });
    });

    await t.step("P2 polls WITH corp_id: exactly 2 character.moved (1 depart + 1 arrive)", async () => {
      const { events } = await eventsSince(p2Id, cursorP2, corpAId);
      const movedEvents = events.filter(
        (e) => e.event_type === "character.moved",
      );
      // P2 sees 2 distinct events: depart (from sector 0, via corp row) +
      // arrive (at sector 1, via corp row — individual row is filtered).
      assertEquals(
        movedEvents.length,
        2,
        `Expected 2 character.moved (depart + arrive) for P2, got ${movedEvents.length}`,
      );

      // Verify they are distinct events (1 depart, 1 arrive)
      const movements = movedEvents.map(
        (e) => (e.payload as Record<string, unknown>)?.movement,
      );
      assert(
        movements.includes("depart"),
        `Expected a depart event, got movements: ${JSON.stringify(movements)}`,
      );
      assert(
        movements.includes("arrive"),
        `Expected an arrive event, got movements: ${JSON.stringify(movements)}`,
      );
    });

    await t.step("cleanup: move P1 and P2 back to sector 0", async () => {
      await setShipSector(p1ShipId, 0);
      await setShipSector(p2ShipId, 0);
    });
  },
});

// ============================================================================
// Group 19: Event wire format — subject can self-identify via event_context
// The bot/client identifies "this is my event" by checking either:
//   - event_context.reason in {"direct", "task_owner", "recipient"}
//   - event_context.character_id == self.character_id
// This test ensures at least one of these holds for the event subject.
// ============================================================================

Deno.test({
  name: "event_dedup — event_context: corp member subject can self-identify",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 100);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 10,
      });
    });

    await t.step("P1's warp.purchase has identifiable event_context", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const warpEvents = events.filter(
        (e) => e.event_type === "warp.purchase",
      );
      assert(warpEvents.length >= 1, "Expected at least 1 warp.purchase");

      const evt = warpEvents[0];
      const ctx = evt.event_context as Record<string, unknown>;
      assertExists(ctx, "event_context should exist");

      // The bot identifies its own events by checking:
      // 1. reason in {"direct", "task_owner", "recipient"}, OR
      // 2. character_id == self (the subject's ID)
      const reason = ctx.reason as string | null;
      const ctxCharId = ctx.character_id as string | null;
      const isDirectReason = reason !== null &&
        ["direct", "task_owner", "recipient"].includes(reason);
      const isSubjectMatch = ctxCharId === p1Id;

      assert(
        isDirectReason || isSubjectMatch,
        `Event subject must be identifiable. reason=${reason}, ` +
          `event_context.character_id=${ctxCharId}, expected p1Id=${p1Id}. ` +
          `At least one of: reason in {direct,task_owner,recipient} or character_id==subject.`,
      );
    });

    await t.step("P1's status.update also has identifiable event_context", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const statusEvents = events.filter(
        (e) => e.event_type === "status.update",
      );
      assert(statusEvents.length >= 1, "Expected at least 1 status.update");

      const ctx = statusEvents[0].event_context as Record<string, unknown>;
      const reason = ctx.reason as string | null;
      const ctxCharId = ctx.character_id as string | null;
      const isDirectReason = reason !== null &&
        ["direct", "task_owner", "recipient"].includes(reason);
      const isSubjectMatch = ctxCharId === p1Id;

      assert(
        isDirectReason || isSubjectMatch,
        `status.update: subject must be identifiable. reason=${reason}, ` +
          `character_id=${ctxCharId}, expected=${p1Id}`,
      );
    });
  },
});

// ============================================================================
// Group 20: Event wire format — join snapshot is identifiable by subject
// Regression guard: previously the bot missed its own status.snapshot after
// joining because the event was delivered via the corp row only and the
// bot couldn't identify it as a direct event.
// ============================================================================

Deno.test({
  name: "event_dedup — event_context: join snapshot identifiable by corp member",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("P1 re-joins", async () => {
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("status.snapshot has identifiable event_context for P1", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const snapshots = events.filter(
        (e) => e.event_type === "status.snapshot",
      );
      assert(snapshots.length >= 1, "Expected at least 1 status.snapshot");

      const ctx = snapshots[0].event_context as Record<string, unknown>;
      assertExists(ctx, "event_context should exist on status.snapshot");

      const reason = ctx.reason as string | null;
      const ctxCharId = ctx.character_id as string | null;
      const isDirectReason = reason !== null &&
        ["direct", "task_owner", "recipient"].includes(reason);
      const isSubjectMatch = ctxCharId === p1Id;

      assert(
        isDirectReason || isSubjectMatch,
        `Join status.snapshot must be identifiable by subject. ` +
          `reason=${reason}, character_id=${ctxCharId}, expected=${p1Id}. ` +
          `Without this, the bot ignores its own join snapshot.`,
      );
    });

    await t.step("map.local has identifiable event_context for P1", async () => {
      const { events } = await eventsSince(p1Id, cursor, corpAId);
      const mapEvents = events.filter(
        (e) => e.event_type === "map.local",
      );
      assert(mapEvents.length >= 1, "Expected at least 1 map.local");

      const ctx = mapEvents[0].event_context as Record<string, unknown>;
      assertExists(ctx, "event_context should exist on map.local");

      const reason = ctx.reason as string | null;
      const ctxCharId = ctx.character_id as string | null;
      const isDirectReason = reason !== null &&
        ["direct", "task_owner", "recipient"].includes(reason);
      const isSubjectMatch = ctxCharId === p1Id;

      assert(
        isDirectReason || isSubjectMatch,
        `Join map.local must be identifiable by subject. ` +
          `reason=${reason}, character_id=${ctxCharId}, expected=${p1Id}`,
      );
    });
  },
});

// ============================================================================
// Group 21: Event wire format — observer's event_context does NOT match observer
// When P2 receives P1's event via corp, event_context.character_id should
// be P1 (the subject), NOT P2. This prevents P2's bot from treating P1's
// events as "direct to P2".
// ============================================================================

Deno.test({
  name: "event_dedup — event_context: observer event_context does not match observer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p1ShipId, 50000);
      await setShipWarpPower(p1ShipId, 100);
    });

    let cursorP2: number;

    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P1 recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 10,
      });
    });

    await t.step("P2's received warp.purchase has event_context.character_id != P2", async () => {
      const { events } = await eventsSince(p2Id, cursorP2, corpAId);
      const warpEvents = events.filter(
        (e) => e.event_type === "warp.purchase",
      );
      assert(warpEvents.length >= 1, "P2 should see P1's warp.purchase via corp");

      const ctx = warpEvents[0].event_context as Record<string, unknown>;
      assertExists(ctx, "event_context should exist");

      // event_context.character_id should be P1 (the subject), NOT P2
      const ctxCharId = ctx.character_id as string | null;
      assert(
        ctxCharId !== p2Id,
        `Observer P2's event_context.character_id should NOT be P2's ID. ` +
          `Got ${ctxCharId}, P2=${p2Id}. ` +
          `If this matches P2, the bot would incorrectly treat P1's event as direct to P2.`,
      );

      // The reason should NOT be "direct" for P2 (P2 is an observer, not the subject)
      const reason = ctx.reason as string | null;
      const isDirectReason = reason !== null &&
        ["direct", "task_owner", "recipient"].includes(reason);
      const isSubjectMatch = ctxCharId === p2Id;
      assert(
        !isDirectReason && !isSubjectMatch,
        `Observer P2 should NOT be identified as direct recipient. ` +
          `reason=${reason}, character_id=${ctxCharId}. ` +
          `Neither reason nor character_id should indicate P2 is a direct target.`,
      );
    });
  },
});

// ============================================================================
// Group 22: Event wire format — solo player always gets reason=direct
// Baseline: solo players (no corp) always get standard individual delivery.
// ============================================================================

Deno.test({
  name: "event_dedup — event_context: solo player gets reason=direct",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("setup", async () => {
      await setShipCredits(p3ShipId, 50000);
      await setShipWarpPower(p3ShipId, 100);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p3Id);
    });

    await t.step("P3 recharges warp power", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p3Id,
        units: 10,
      });
    });

    await t.step("P3's warp.purchase has reason=direct and character_id=P3", async () => {
      const { events } = await eventsSince(p3Id, cursor);
      const warpEvents = events.filter(
        (e) => e.event_type === "warp.purchase",
      );
      assert(warpEvents.length >= 1, "Expected at least 1 warp.purchase");

      const ctx = warpEvents[0].event_context as Record<string, unknown>;
      assertExists(ctx, "event_context should exist");

      assertEquals(
        ctx.reason,
        "direct",
        `Solo player's event should have reason='direct', got '${ctx.reason}'`,
      );
      assertEquals(
        ctx.character_id,
        p3Id,
        `Solo player's event_context.character_id should match P3. ` +
          `Got ${ctx.character_id}, expected ${p3Id}`,
      );
    });
  },
});

// ============================================================================
// Group 22: Corp ship movement events include corp_id
// When a corporation ship moves, movement.start and movement.complete must
// carry corp_id so that corp members can poll them via events_since.
// ============================================================================

Deno.test({
  name: "event_dedup — corp ship movement events carry corp_id",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let corpShipCharacterId: string;

    await t.step("setup: buy corp ship for Corp A (P1)", async () => {
      await setShipSector(p1ShipId, 0);
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
      assertExists(corpShipId, "Should get corp ship ID");

      // For corp ships, the pseudo-character's character_id equals the ship_id
      corpShipCharacterId = corpShipId;

      // Give it warp power and place in sector 0
      await setShipWarpPower(corpShipId, 500);
      await setShipSector(corpShipId, 0);
    });

    let cursor: number;

    await t.step("capture cursor for P2 (corp member)", async () => {
      cursor = await getEventCursor(p2Id);
    });

    await t.step("move corp ship from sector 0 → 1", async () => {
      await apiOk("move", {
        character_id: corpShipCharacterId,
        to_sector: 1,
        actor_character_id: p1Id,
      });
    });

    await t.step("movement.complete in DB has corp row with corp_id", async () => {
      const rows = await queryEvents(
        `event_type = 'movement.complete' AND character_id = $1 AND corp_id = $2`,
        [corpShipCharacterId, corpAId],
      );
      const recent = rows.filter((r: Record<string, unknown>) => (r.id as number) > cursor);
      assert(
        recent.length >= 1,
        `Should have a movement.complete corp row with corp_id=${corpAId}`,
      );
    });

    await t.step("movement.start in DB has corp row with corp_id", async () => {
      const rows = await queryEvents(
        `event_type = 'movement.start' AND character_id = $1 AND corp_id = $2`,
        [corpShipCharacterId, corpAId],
      );
      const recent = rows.filter((r: Record<string, unknown>) => (r.id as number) > cursor);
      assert(
        recent.length >= 1,
        `Should have a movement.start corp row with corp_id=${corpAId}`,
      );
    });

    await t.step("P2 (corp member) can poll corp ship movement via corp_id", async () => {
      const moveEvents = await eventsOfType(
        p2Id,
        "movement.complete",
        cursor,
        corpAId,
      );
      const corpShipMoves = moveEvents.filter((e) => {
        const payload = e.payload as Record<string, unknown>;
        const player = payload.player as Record<string, unknown> | undefined;
        return player?.id === corpShipCharacterId;
      });
      assert(
        corpShipMoves.length >= 1,
        "P2 should see corp ship's movement.complete when polling with corp_id",
      );
    });

    await t.step("P3 (not in Corp A) cannot see corp ship movement", async () => {
      const moveEvents = await eventsOfType(
        p3Id,
        "movement.complete",
        cursor,
      );
      const corpShipMoves = moveEvents.filter((e) => {
        const payload = e.payload as Record<string, unknown>;
        const player = payload.player as Record<string, unknown> | undefined;
        return player?.id === corpShipCharacterId;
      });
      assertEquals(
        corpShipMoves.length,
        0,
        "P3 (non-corp-member) should NOT see corp ship's movement.complete",
      );
    });

    await t.step("cleanup: move corp ship back", async () => {
      await setShipSector(corpShipId, 0);
    });
  },
});
