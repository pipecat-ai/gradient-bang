/**
 * TDD tests for corp ship map knowledge. These encode the *desired* behavior
 * and only pass once both halves of the fix (Option A write-side + Option B
 * read-side) are in place. Each group targets one half in isolation so that
 * removing either half fails a specific group.
 *
 * Option A — at ship purchase time, seed the spawn sector into the
 *   corporation's map knowledge (corporation_map_knowledge). Without this,
 *   a brand-new corp ship has zero known sectors — not even its own.
 *
 * Option B — when loading map knowledge for a corp ship pseudo-character
 *   and an actor is supplied, use the actor's personal knowledge as the
 *   "personal" half of the merge. Without this, a corp ship cannot see
 *   any sectors the driving player explored alone.
 *
 * Setup: P1 is pinned to the mega-port (sector 0); P2 is pinned elsewhere
 * (sector 2). P1 creates the corp, P2 joins as a corp member, P1 purchases
 * the corp ship (which spawns at sector 0). Because P2 is in a different
 * sector and never moved to 0, P2's personal knowledge does not include
 * sector 0.
 *
 *   - Group 1 asks a P2-driven corp ship to list ports from sector 0
 *     (its spawn sector, which P2 does not know). Only Option A can seed
 *     that sector into the corp's map knowledge so the merge sees it;
 *     Option B cannot help because P2 lacks it too.
 *   - Group 2 asks a P2-driven corp ship to list ports from sector 2
 *     (which P2 knows but is not the spawn sector and is not in corp
 *     knowledge). Only Option B can merge P2's personal knowledge into
 *     the corp ship's view; Option A cannot help because sector 2 is
 *     not in corp or ship knowledge without the actor merge.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  apiOk,
  characterIdFor,
  shipIdFor,
  setShipCredits,
  withPg,
} from "./helpers.ts";

const P1 = "test_corp_ship_map_p1"; // pinned to sector 0 (mega-port)
const P2 = "test_corp_ship_map_p2"; // pinned to sector 2

let p1Id: string;
let p1ShipId: string;
let p2Id: string;
let p2ShipId: string;

/** Read a character's personal sectors_visited keys directly. */
async function getPersonalVisitedSectors(
  characterId: string,
): Promise<number[]> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ map_knowledge: unknown }>(
      `SELECT map_knowledge FROM characters WHERE character_id = $1`,
      [characterId],
    );
    const row = result.rows[0];
    if (!row) return [];
    const mk = row.map_knowledge as
      | { sectors_visited?: Record<string, unknown> }
      | null;
    return Object.keys(mk?.sectors_visited ?? {}).map(Number);
  });
}

/** Read a corporation's sectors_visited keys directly. */
async function getCorpVisitedSectors(corpId: string): Promise<number[]> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ map_knowledge: unknown }>(
      `SELECT map_knowledge FROM corporation_map_knowledge WHERE corp_id = $1`,
      [corpId],
    );
    const row = result.rows[0];
    if (!row) return [];
    const mk = row.map_knowledge as
      | { sectors_visited?: Record<string, unknown> }
      | null;
    return Object.keys(mk?.sectors_visited ?? {}).map(Number);
  });
}

/** Shared setup: reset, join both players, create corp, P2 joins corp, P1 buys corp ship. */
async function setupCorpWithShip(): Promise<{
  corpId: string;
  corpShipId: string;
}> {
  await resetDatabase([P1, P2]);
  await apiOk("join", { character_id: p1Id });
  await apiOk("join", { character_id: p2Id });
  await setShipCredits(p1ShipId, 50000);

  const createResult = await apiOk("corporation_create", {
    character_id: p1Id,
    name: "Map Knowledge Corp",
  });
  const corpId = (createResult as Record<string, unknown>).corp_id as string;
  const inviteCode = (createResult as Record<string, unknown>)
    .invite_code as string;

  // corporation_create costs 10000 credits; top up again before the buy.
  await setShipCredits(p1ShipId, 50000);

  await apiOk("corporation_join", {
    character_id: p2Id,
    corp_id: corpId,
    invite_code: inviteCode,
  });

  const purchaseResult = await apiOk("ship_purchase", {
    character_id: p1Id,
    ship_type: "autonomous_probe",
    purchase_type: "corporation",
  });
  const corpShipId = (purchaseResult as Record<string, unknown>)
    .ship_id as string;

  return { corpId, corpShipId };
}

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "corp_ship_map — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Option A — spawn sector is visible to a corp member who was not
// present at the purchase. This isolates the write-side fix: without the
// spawn sector landing in corporation_map_knowledge at purchase time, no
// amount of read-time actor merging can surface it for P2.
// ============================================================================

Deno.test({
  name: "corp_ship_map — corp ship spawn sector visible to other corp member (requires Option A)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p1ShipId = await shipIdFor(P1);
    p2Id = await characterIdFor(P2);
    p2ShipId = await shipIdFor(P2);

    let corpId: string;
    let corpShipId: string;

    await t.step("setup: 2-player corp with freshly purchased corp ship", async () => {
      const result = await setupCorpWithShip();
      corpId = result.corpId;
      corpShipId = result.corpShipId;
    });

    await t.step("sanity: P2 does not know sector 0", async () => {
      const p2Visited = await getPersonalVisitedSectors(p2Id);
      assertEquals(
        p2Visited.includes(0),
        false,
        `P2 should not know sector 0, got: ${JSON.stringify(p2Visited)}`,
      );
    });

    await t.step(
      "corp map knowledge includes the spawn sector after purchase",
      async () => {
        // This is Option A's observable effect in the database.
        const corpVisited = await getCorpVisitedSectors(corpId);
        assert(
          corpVisited.includes(0),
          `Expected corp map knowledge to include spawn sector 0, got: ` +
            JSON.stringify(corpVisited),
        );
      },
    );

    await t.step(
      "list_known_ports from sector 0 succeeds for P2-driven corp ship",
      async () => {
        // With Option A, corp knowledge has sector 0 → visible through the
        // corp half of the merge regardless of who is driving. Option B
        // alone cannot satisfy this test because P2 does not know sector 0.
        const result = await apiOk("list_known_ports", {
          character_id: corpShipId,
          actor_character_id: p2Id,
          from_sector: 0,
          max_hops: 5,
        });
        assert(result.success);
      },
    );
  },
});

// ============================================================================
// Group 2: Option B — the actor's personal knowledge is merged into the
// corp ship's view at read time. Query from a sector that the actor knows
// but which is neither the spawn sector nor in corp knowledge.
// ============================================================================

Deno.test({
  name: "corp_ship_map — corp ship inherits actor's personal knowledge (requires Option B)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("setup: 2-player corp with freshly purchased corp ship", async () => {
      const result = await setupCorpWithShip();
      corpId = result.corpId;
      corpShipId = result.corpShipId;
    });

    await t.step("sanity: P2 knows sector 2, corp does not", async () => {
      const p2Visited = await getPersonalVisitedSectors(p2Id);
      assert(
        p2Visited.includes(2),
        `P2 should know sector 2, got: ${JSON.stringify(p2Visited)}`,
      );
      const corpVisited = await getCorpVisitedSectors(corpId);
      assertEquals(
        corpVisited.includes(2),
        false,
        `Corp should not know sector 2, got: ${JSON.stringify(corpVisited)}`,
      );
    });

    await t.step(
      "list_known_ports from sector 2 succeeds for P2-driven corp ship",
      async () => {
        // With Option B, loadMapKnowledge for the corp ship substitutes
        // P2's personal knowledge for the corp ship's (empty) own personal
        // knowledge. Sector 2 thus shows up via the personal half of the
        // merge. Option A alone cannot satisfy this test because sector 2
        // is neither the spawn sector nor in corp knowledge.
        const result = await apiOk("list_known_ports", {
          character_id: corpShipId,
          actor_character_id: p2Id,
          from_sector: 2,
          max_hops: 5,
        });
        assert(result.success);
      },
    );
  },
});
