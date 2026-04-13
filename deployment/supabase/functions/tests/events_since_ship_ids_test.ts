/**
 * Integration tests for events_since `ship_ids` filtering.
 *
 * Tests cover:
 *   - events_since accepts a `ship_ids` parameter and returns events whose
 *     recipient_character_id matches one of the supplied ids.
 *   - A request with only `ship_ids` (no character_id / corp_id) is valid.
 *   - Without `ship_ids`, corp-ship-recipient events are NOT returned to a
 *     poller querying only by the actor's character_id (regression guard).
 *   - End-to-end: list_known_ports called for a corp ship emits a ports.list
 *     event that is discoverable via events_since with ship_ids.
 *
 * Background: corp ships are registered as pseudo-characters in the
 * `characters` table with character_id == ship_id (see
 * ship_purchase/ensureCorporationShipCharacter). Tools like list_known_ports
 * emit events with recipient_character_id set to that pseudo-character id.
 * Before this fix, events_since ignored the `ship_ids` payload field, so the
 * bot's polling loop could not see these events.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiOk,
  characterIdFor,
  shipIdFor,
  createCorpShip,
  getEventCursor,
  setShipCredits,
  withPg,
} from "./helpers.ts";

const P1 = "test_events_since_ship_ids_p1";

let p1Id: string;
let p1ShipId: string;

interface EventsSinceResponse {
  events: Array<{
    id: number;
    event_type: string;
    payload: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  last_event_id: number | null;
  has_more: boolean;
}

/**
 * Directly insert a synthetic event with recipient_character_id = targetId.
 * Returns the inserted event id.
 */
async function insertRecipientEvent(
  targetCharacterId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ id: bigint | number }>(
      `INSERT INTO events (
        event_type, direction, scope, payload,
        recipient_character_id, is_broadcast, timestamp
      ) VALUES (
        $1, 'event_out', 'direct', $2::jsonb,
        $3, false, now()
      )
      RETURNING id`,
      [eventType, JSON.stringify(payload), targetCharacterId],
    );
    // events.id is bigint → deno-postgres returns BigInt; coerce to Number
    // so comparisons against JSON-decoded ids work.
    return Number(result.rows[0].id);
  });
}

/**
 * Seed the pseudo-character's map knowledge so list_known_ports accepts
 * `from_sector` as a visited sector.
 */
async function seedCorpShipVisited(
  corpShipCharacterId: string,
  sectorId: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE characters
         SET map_knowledge = jsonb_build_object(
           'total_sectors_visited', 1,
           'sectors_visited', jsonb_build_object($2::text, jsonb_build_object(
             'last_visited', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ))
         )
       WHERE character_id = $1`,
      [corpShipCharacterId, String(sectorId)],
    );
  });
}

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "events_since_ship_ids — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: events_since returns recipient-character events via ship_ids
// ============================================================================

Deno.test({
  name: "events_since_ship_ids — ship_ids surfaces recipient events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p1ShipId = await shipIdFor(P1);

    let corpId: string;
    let corpShipId: string;
    let cursor: number;
    let insertedEventId: number;

    await t.step("reset + create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "ShipIds Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const shipResult = await createCorpShip(corpId, 0, "ShipIds Probe");
      corpShipId = shipResult.pseudoCharacterId;
    });

    await t.step("capture cursor, insert synthetic corp-ship event", async () => {
      cursor = await getEventCursor(p1Id);
      insertedEventId = await insertRecipientEvent(
        corpShipId,
        "ports.list",
        { marker: "ship_ids_test", total_ports_found: 0 },
      );
      assert(insertedEventId > cursor, "sanity: new event id above cursor");
    });

    await t.step("polling with ship_ids returns the event", async () => {
      const result = await apiOk<EventsSinceResponse>("events_since", {
        character_id: p1Id,
        ship_ids: [corpShipId],
        since_event_id: cursor,
      });
      const match = result.events.find((e) => e.id === insertedEventId);
      assert(
        match,
        `Expected synthetic ports.list event ${insertedEventId} to be ` +
          `returned via ship_ids filter. Got ${result.events.length} events: ` +
          JSON.stringify(result.events.map((e) => [e.id, e.event_type])),
      );
      assertEquals(match!.event_type, "ports.list");
      assertEquals(
        (match!.payload as { marker?: string }).marker,
        "ship_ids_test",
      );
    });

    await t.step("polling without ship_ids does NOT return the event", async () => {
      // Regression guard: without ship_ids, a poller using only the actor's
      // character_id (and no corp_id) must not see corp-ship-recipient events.
      // This is what the original bug looked like before the fix.
      const result = await apiOk<EventsSinceResponse>("events_since", {
        character_id: p1Id,
        since_event_id: cursor,
      });
      const match = result.events.find((e) => e.id === insertedEventId);
      assertEquals(
        match,
        undefined,
        "Without ship_ids, the corp-ship-recipient event should not be " +
          "returned to a poller querying only by the actor's character_id.",
      );
    });
  },
});

// ============================================================================
// Group 2: events_since with only ship_ids is a valid request
// ============================================================================

Deno.test({
  name: "events_since_ship_ids — ship_ids alone is a valid request",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;
    let cursor: number;
    let insertedEventId: number;

    await t.step("reset + create corp with ship", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "ShipIds Only Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const shipResult = await createCorpShip(corpId, 0, "ShipIds Only Probe");
      corpShipId = shipResult.pseudoCharacterId;
    });

    await t.step("capture cursor, insert synthetic event", async () => {
      cursor = await getEventCursor(p1Id);
      insertedEventId = await insertRecipientEvent(
        corpShipId,
        "ports.list",
        { marker: "ship_ids_only" },
      );
    });

    await t.step("request with only ship_ids is accepted (not 400)", async () => {
      const result = await api<EventsSinceResponse>("events_since", {
        ship_ids: [corpShipId],
        since_event_id: cursor,
      });
      assertEquals(
        result.status,
        200,
        `Expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
      );
      assert(result.body.success);
      const match = (result.body as unknown as EventsSinceResponse).events
        .find((e) => e.id === insertedEventId);
      assert(match, "Synthetic event should be returned");
    });

    await t.step("request with nothing still returns 400", async () => {
      const result = await api("events_since", {
        since_event_id: 0,
      });
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 3: End-to-end — list_known_ports → ports.list via ship_ids polling
// ============================================================================

Deno.test({
  name: "events_since_ship_ids — list_known_ports end-to-end via ship_ids",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;
    let cursor: number;

    await t.step("reset + create corp with ship + seed sector visited", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "E2E Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      // Place the corp ship in fed space sector 8 (known visited-safe in
      // practice; we still seed explicitly so the test is self-contained).
      const shipResult = await createCorpShip(corpId, 8, "E2E Probe");
      corpShipId = shipResult.pseudoCharacterId;
      await seedCorpShipVisited(corpShipId, 8);
    });

    await t.step("capture cursor, call list_known_ports for corp ship", async () => {
      cursor = await getEventCursor(p1Id);
      const result = await apiOk("list_known_ports", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        from_sector: 8,
        max_hops: 10,
      });
      assert(result.success);
    });

    await t.step("ports.list is discoverable via ship_ids polling", async () => {
      const result = await apiOk<EventsSinceResponse>("events_since", {
        character_id: p1Id,
        ship_ids: [corpShipId],
        since_event_id: cursor,
      });
      const portsList = result.events.find((e) => e.event_type === "ports.list");
      assert(
        portsList,
        `Expected a ports.list event for the corp ship via ship_ids polling. ` +
          `Got: ${JSON.stringify(result.events.map((e) => e.event_type))}`,
      );
    });

    await t.step("ports.list is NOT visible without ship_ids", async () => {
      // Confirms the fix is what makes the event reach the poller: querying
      // only with the actor's character_id returns no ports.list.
      const result = await apiOk<EventsSinceResponse>("events_since", {
        character_id: p1Id,
        since_event_id: cursor,
      });
      const portsList = result.events.find((e) => e.event_type === "ports.list");
      assertEquals(
        portsList,
        undefined,
        "Without ship_ids, the corp-ship ports.list event should not appear " +
          "in the actor-only poll (this is the bug the fix addresses).",
      );
    });
  },
});
