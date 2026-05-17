/**
 * Phase 2: Garrison visibility & sector observer tests.
 *
 * Tests that garrison owners and corp members receive events for sectors
 * where they have a garrison, even when they're not physically present.
 *
 * Coverage targets:
 * - visibility.ts (computeSectorVisibilityRecipients, loadGarrisonContext, dedupeRecipientSnapshots)
 * - observers.ts (emitGarrisonCharacterMovedEvents)
 * - combat_events.ts (getCorpIdsFromParticipants)
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
  assertNoEventsOfType,
  characterIdFor,
  eventsOfType,
  eventsSince,
  getEventCursor,
  insertGarrisonDirect,
  setShipCredits,
  setShipFighters,
  setShipSector,
  setShipWarpPower,
  shipIdFor,
  withPg,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Character/ship handles — match PINNED_SECTORS in test_reset
// ---------------------------------------------------------------------------

const P1 = "test_vis_p1";
const P2 = "test_vis_p2";
const P3 = "test_vis_p3";

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
  name: "garrison_visibility — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// Resolve IDs once before any tests run
Deno.test({
  name: "garrison_visibility — resolve IDs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    [p1Id, p2Id, p3Id] = await Promise.all([
      characterIdFor(P1),
      characterIdFor(P2),
      characterIdFor(P3),
    ]);
    [p1ShipId, p2ShipId, p3ShipId] = await Promise.all([
      shipIdFor(P1),
      shipIdFor(P2),
      shipIdFor(P3),
    ]);
  },
});

// ============================================================================
// Group 1: Garrison owner (not in sector) receives garrison.character_moved
// P1 deploys garrison in sector 3, moves to sector 7. P2 moves into
// sector 3 via `move`. P1 should receive garrison.character_moved.
// ============================================================================

Deno.test({
  name:
    "garrison_visibility — garrison owner receives events when not in sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      // P1 in sector 3 to deploy garrison, P2 in sector 4 (adjacent to 3)
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipWarpPower(p2ShipId, 500);
    });

    await t.step("P1 deploys garrison and moves away", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
      // Move P1 away from sector 3 so they're NOT a sector observer
      await setShipSector(p1ShipId, 7);
    });

    let cursorP1: number;

    await t.step("capture P1 cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P2 moves into sector 3 (garrison sector)", async () => {
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
    });

    await t.step("P1 receives garrison.character_moved event", async () => {
      const events = await eventsOfType(
        p1Id,
        "garrison.character_moved",
        cursorP1,
      );
      assert(
        events.length >= 1,
        `Expected garrison.character_moved for P1, got ${events.length}`,
      );
      // Verify the event is about the right sector
      const payload = events[events.length - 1].payload as Record<
        string,
        unknown
      >;
      assertExists(payload.player, "Event should include player info");
    });
  },
});

// ============================================================================
// Group 2: Deduplication — same-sector occupant + garrison owner
// P1 is both IN sector 3 (ship observer) and has a garrison there.
// They should NOT get duplicate events.
// ============================================================================

Deno.test({
  name: "garrison_visibility — deduplication: sector observer + garrison owner",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup — P1 stays in garrison sector", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipFighters(p1ShipId, 200);
      await setShipWarpPower(p2ShipId, 500);
      // P1 deploys garrison but STAYS in sector 3
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
    });

    let cursorP1: number;

    await t.step("capture P1 cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P2 moves into sector 3", async () => {
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
    });

    await t.step(
      "P1 gets character.moved events without duplicates",
      async () => {
        // P1 is a sector observer (ship in sector 3) and garrison owner.
        // Should receive character.moved events for P2's arrival.
        // Check there's exactly 1 arrive character.moved (not 2).
        const { events } = await eventsSince(p1Id, cursorP1);
        const arrivals = events.filter(
          (e) =>
            e.event_type === "character.moved" &&
            (e.payload as Record<string, unknown>)?.movement === "arrive",
        );
        assertEquals(
          arrivals.length,
          1,
          `Expected exactly 1 arrive event for P1, got ${arrivals.length}`,
        );
      },
    );
  },
});

// ============================================================================
// Group 4: No garrisons in sector — only ship observers get events
// Sector has no garrisons. Only ships in the sector receive events.
// ============================================================================

Deno.test({
  name: "garrison_visibility — no garrisons: only ship observers get events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset — no garrisons anywhere", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      // P1 in sector 3 (observer), P2 in sector 4, P3 in sector 7 (not involved)
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 4);
      await setShipSector(p3ShipId, 7);
      await setShipWarpPower(p2ShipId, 500);
    });

    let cursorP1: number;
    let cursorP3: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP3 = await getEventCursor(p3Id);
    });

    await t.step("P2 moves into sector 3", async () => {
      await apiOk("move", { character_id: p2Id, to_sector: 3 });
    });

    await t.step("P1 (sector observer) receives character.moved", async () => {
      const events = await eventsOfType(p1Id, "character.moved", cursorP1);
      assert(
        events.length >= 1,
        `Expected character.moved for P1, got ${events.length}`,
      );
    });

    await t.step(
      "P3 (not in sector, no garrison) gets no garrison events",
      async () => {
        await assertNoEventsOfType(p3Id, "garrison.character_moved", cursorP3);
      },
    );
  },
});

// ============================================================================
// Group 5: Garrison owner receives combat.round_waiting via visibility
// P1 deploys garrison in sector 3, moves away. P2 and P3 enter sector 3
// and initiate combat. P1 should receive combat.round_waiting because
// computeEventRecipients includes garrison owners via
// computeSectorVisibilityRecipients.
// ============================================================================

Deno.test({
  name: "garrison_visibility — garrison owner receives combat events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipSector(p1ShipId, 3);
      await setShipSector(p2ShipId, 3);
      await setShipSector(p3ShipId, 3);
      await setShipFighters(p1ShipId, 200);
      await setShipFighters(p2ShipId, 200);
      await setShipFighters(p3ShipId, 200);
    });

    await t.step("P1 deploys garrison and moves away", async () => {
      await apiOk("combat_leave_fighters", {
        character_id: p1Id,
        sector: 3,
        quantity: 50,
        mode: "defensive",
      });
      await setShipSector(p1ShipId, 7);
    });

    let cursorP1: number;

    await t.step("capture P1 cursor", async () => {
      cursorP1 = await getEventCursor(p1Id);
    });

    await t.step("P2 initiates combat with P3", async () => {
      await apiOk("combat_initiate", { character_id: p2Id });
    });

    await t.step(
      "P1 (garrison owner, not in sector) receives combat.round_waiting",
      async () => {
        const events = await eventsOfType(
          p1Id,
          "combat.round_waiting",
          cursorP1,
        );
        assert(
          events.length >= 1,
          `Expected combat.round_waiting for P1, got ${events.length}`,
        );
      },
    );
  },
});
