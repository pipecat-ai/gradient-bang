/**
 * Map knowledge coverage tests.
 *
 * Complements the focused corp_ship_map_knowledge_test.ts (which isolates
 * Options A and B against list_known_ports) with broader integration
 * coverage across every endpoint that reads map knowledge and the edge
 * cases around corp-ship purchase seeding.
 *
 * Covered here:
 *   - Option A: fresh corp ship purchase seeds the spawn sector into
 *     corporation_map_knowledge with adjacent_sectors populated.
 *   - Option A: second corp ship purchase does NOT clobber prior corp
 *     knowledge accumulated via corp-ship movement.
 *   - Option B in plot_course: a corp-ship plot_course accepts a
 *     from_sector that is only in the driving actor's personal knowledge.
 *   - Option B in path_with_region: path decoration uses the actor's
 *     personal knowledge when a corp ship is the target.
 *   - Option B in local_map_region: the returned payload marks the actor's
 *     personal sectors as visited for a corp-ship center query, and the
 *     merge's source tagging correctly reports 'player' / 'corp' / 'both'.
 *   - Regression: human-player endpoints still work when actor_character_id
 *     is supplied and equals character_id.
 *
 * Single-player setup: P1 is pinned to sector 0 (mega-port), creates a
 * corp, buys corp ships, moves around. Each group resets the DB.
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  apiOk,
  characterIdFor,
  shipIdFor,
  setShipCredits,
  queryCorpMapKnowledge,
  eventsOfType,
  getEventCursor,
  withPg,
} from "./helpers.ts";

const P1 = "test_mknow_p1"; // pinned to sector 0 (mega-port)

let p1Id: string;
let p1ShipId: string;

interface LocalMapSector {
  id: number;
  visited: boolean;
  source?: "player" | "corp" | "both";
  [key: string]: unknown;
}

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
  const row = await queryCorpMapKnowledge(corpId);
  if (!row) return [];
  const mk = row.map_knowledge as
    | { sectors_visited?: Record<string, unknown> }
    | null;
  return Object.keys(mk?.sectors_visited ?? {}).map(Number);
}

/** Shared setup: reset, join P1, top up credits, create corp. */
async function setupCorp(corpName: string): Promise<string> {
  await resetDatabase([P1]);
  await apiOk("join", { character_id: p1Id });
  await setShipCredits(p1ShipId, 50000);
  const createResult = await apiOk("corporation_create", {
    character_id: p1Id,
    name: corpName,
  });
  // corporation_create costs 10000 credits; top up for subsequent ship buys.
  await setShipCredits(p1ShipId, 50000);
  return (createResult as Record<string, unknown>).corp_id as string;
}

async function purchaseCorpShip(): Promise<string> {
  const result = await apiOk("ship_purchase", {
    character_id: p1Id,
    ship_type: "autonomous_probe",
    purchase_type: "corporation",
  });
  return (result as Record<string, unknown>).ship_id as string;
}

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "map_knowledge — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    p1Id = await characterIdFor(P1);
    p1ShipId = await shipIdFor(P1);
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Option A — fresh corp ship seeds spawn sector into corp knowledge
// with adjacency populated (not just a stub entry). Regression guard for the
// ship_purchase → pgUpsertCorporationSectorKnowledge wiring.
// ============================================================================

Deno.test({
  name: "map_knowledge — fresh corp ship seeds spawn sector with full shape",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("setup + purchase corp ship", async () => {
      corpId = await setupCorp("Spawn Seed Corp");
      await purchaseCorpShip();
    });

    await t.step(
      "corp map knowledge has spawn sector 0 with adjacent_sectors populated",
      async () => {
        const row = await queryCorpMapKnowledge(corpId);
        assertExists(row, "corp map knowledge row must exist after purchase");
        const mk = row.map_knowledge as {
          sectors_visited?: Record<string, {
            adjacent_sectors?: number[];
            position?: number[];
            last_visited?: string;
          }>;
          total_sectors_visited?: number;
        };
        const entry = mk.sectors_visited?.["0"];
        assertExists(entry, "sector 0 entry missing from corp knowledge");
        assert(
          Array.isArray(entry.adjacent_sectors) &&
            entry.adjacent_sectors.length > 0,
          "Option A should seed adjacent_sectors via buildSectorSnapshot, " +
            `got: ${JSON.stringify(entry.adjacent_sectors)}`,
        );
        assert(
          Array.isArray(entry.position) && entry.position.length === 2,
          `Expected 2-element position array, got: ${JSON.stringify(entry.position)}`,
        );
        assert(
          typeof entry.last_visited === "string" && entry.last_visited.length > 0,
          "Expected last_visited timestamp string",
        );
      },
    );
  },
});

// ============================================================================
// Group 2: Option A — second corp ship purchase must not clobber corp
// knowledge that a previous corp ship already accumulated via movement.
// ============================================================================

Deno.test({
  name: "map_knowledge — second corp ship purchase preserves prior corp knowledge",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let firstShipId: string;

    await t.step("setup + buy first corp ship, move it to sector 1", async () => {
      corpId = await setupCorp("Preserve Corp");
      firstShipId = await purchaseCorpShip();
      await apiOk("move", {
        character_id: firstShipId,
        actor_character_id: p1Id,
        to_sector: 1,
      });
    });

    await t.step("precondition: corp knows sectors 0 and 1", async () => {
      const visited = await getCorpVisitedSectors(corpId);
      assert(visited.includes(0), `expected 0 in corp knowledge, got ${visited}`);
      assert(visited.includes(1), `expected 1 in corp knowledge, got ${visited}`);
    });

    await t.step("buy a second corp ship at sector 0", async () => {
      await setShipCredits(p1ShipId, 50000);
      await purchaseCorpShip();
    });

    await t.step(
      "corp knowledge retains both sectors 0 and 1 (no clobber)",
      async () => {
        const visited = await getCorpVisitedSectors(corpId);
        assert(
          visited.includes(0),
          `Sector 0 should still be in corp knowledge, got ${JSON.stringify(visited)}`,
        );
        assert(
          visited.includes(1),
          `Sector 1 must survive the second purchase seeding, got ${JSON.stringify(visited)}. ` +
            "If this fails, Option A's upsert is overwriting the corp knowledge row " +
            "instead of merging.",
        );
      },
    );
  },
});

// ============================================================================
// Group 3: Option B — plot_course on a corp ship uses actor's knowledge.
// ============================================================================

Deno.test({
  name: "map_knowledge — plot_course on corp ship inherits actor personal knowledge",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("setup corp + corp ship at sector 0", async () => {
      corpId = await setupCorp("Plot Course Corp");
      corpShipId = await purchaseCorpShip();
    });

    await t.step("P1 moves personal ship 0 → 1 to learn sector 1", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      const visited = await getPersonalVisitedSectors(p1Id);
      assert(
        visited.includes(1),
        `P1 should know sector 1 after moving there, got ${JSON.stringify(visited)}`,
      );
    });

    await t.step("sanity: corp knowledge does NOT include sector 1", async () => {
      const corpVisited = await getCorpVisitedSectors(corpId);
      assertEquals(
        corpVisited.includes(1),
        false,
        `Corp should not know sector 1 (only the corp ship's movements ` +
          `update corp knowledge, and it hasn't moved): ${JSON.stringify(corpVisited)}`,
      );
    });

    await t.step(
      "plot_course for corp ship from actor-known sector 1 succeeds",
      async () => {
        // Without Option B in plot_course, this would fail with 403
        // "from_sector must be a sector you or your corporation have
        // discovered", because the corp ship's pseudo-character and
        // corp both lack sector 1 — only the actor (P1) knows it.
        const result = await apiOk("plot_course", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          from_sector: 1,
          to_sector: 2,
        });
        assert(result.success);
      },
    );
  },
});

// ============================================================================
// Group 4: Option B — path_with_region on a corp ship uses actor knowledge.
// The response decorates sectors with 'visited' flags; actor-known sectors
// should show up as visited for the corp ship's region payload.
// ============================================================================

Deno.test({
  name: "map_knowledge — path_with_region on corp ship marks actor sectors visited",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let cursor: number;

    await t.step("setup corp + corp ship", async () => {
      await setupCorp("Path Region Corp");
      corpShipId = await purchaseCorpShip();
    });

    await t.step("P1 moves personal ship 0 → 1 to learn sector 1", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step(
      "path_with_region for corp ship: sector 1 is visited in emitted event",
      async () => {
        // path_with_region returns only { request_id } in the HTTP body; the
        // actual sectors[] payload arrives as a `path.region` event scoped
        // to the corp ship's pseudo-character. Seeing that event routed to
        // the actor's event stream is a separate concern (handled by
        // events_since_ship_ids); here we just poll for it directly off the
        // corp ship character and inspect the payload. Corp ship is at 0;
        // route it to sector 2 so the region spans sector 1.
        cursor = await getEventCursor(corpShipId);
        const result = await apiOk("path_with_region", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          to_sector: 2,
          region_hops: 3,
        });
        assert(result.success);

        const events = await eventsOfType(corpShipId, "path.region", cursor);
        assert(
          events.length >= 1,
          `Expected a path.region event for the corp ship, got ${events.length}`,
        );
        const payload = events[events.length - 1].payload as {
          sectors?: Array<{ sector_id: number; visited: boolean }>;
        };
        const sectors = payload.sectors;
        assertExists(sectors, "path.region event missing sectors[]");
        const sector1 = sectors.find((s) => s.sector_id === 1);
        assertExists(
          sector1,
          `Sector 1 should appear in the region payload, got ids: ${
            sectors.map((s) => s.sector_id).join(",")
          }`,
        );
        assertEquals(
          sector1.visited,
          true,
          "Sector 1 should be marked visited for the corp ship (P1 knows it). " +
            "If this fails, path_with_region is not threading actor_character_id " +
            "into loadMapKnowledge.",
        );
      },
    );
  },
});

// ============================================================================
// Group 5: Option B — local_map_region on a corp ship merges actor knowledge.
// Also validates merge source tagging: sectors only in actor personal should
// show source='player', only in corp should show 'corp', in both 'both'.
// ============================================================================

Deno.test({
  name: "map_knowledge — local_map_region source tagging on corp ship (player/corp/both)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("setup corp + corp ship at sector 0", async () => {
      corpId = await setupCorp("Source Tag Corp");
      corpShipId = await purchaseCorpShip();
    });

    await t.step("corp ship moves 0 → 1 → 3 (corp learns 1 and 3)", async () => {
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
      const corpVisited = await getCorpVisitedSectors(corpId);
      assert(corpVisited.includes(1), `corp should know 1, got ${corpVisited}`);
      assert(corpVisited.includes(3), `corp should know 3, got ${corpVisited}`);
    });

    await t.step(
      "P1 personal ship moves 0 → 2 (P1 learns sector 2; corp does not)",
      async () => {
        await apiOk("move", { character_id: p1Id, to_sector: 2 });
        const p1Visited = await getPersonalVisitedSectors(p1Id);
        assert(p1Visited.includes(2), `P1 should know 2, got ${p1Visited}`);
        const corpVisited = await getCorpVisitedSectors(corpId);
        assertEquals(
          corpVisited.includes(2),
          false,
          `Corp should NOT know sector 2 (only P1 went there), got ${corpVisited}`,
        );
      },
    );

    await t.step(
      "local_map_region for corp ship reports correct source tags",
      async () => {
        // Corp ship is at sector 3. Center the region there; the map should
        // span enough of the universe to include 0, 1, 2, 3.
        const result = await apiOk<{
          sectors?: LocalMapSector[];
        }>("local_map_region", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          center_sector: 3,
          max_hops: 4,
          max_sectors: 20,
        });
        const sectors = result.sectors ?? [];
        const byId = new Map<number, LocalMapSector>();
        for (const s of sectors) byId.set(s.id, s);

        // Sector 0: known to P1 (join + still there as personal-ship origin)
        // AND known to corp (spawn-seeded by Option A, also corp ship passed
        // through it). Expect source='both'.
        const s0 = byId.get(0);
        assertExists(s0, "sector 0 missing from local_map_region");
        assertEquals(
          s0.visited,
          true,
          "sector 0 should be visited for corp ship (actor+corp)",
        );
        assertEquals(
          s0.source,
          "both",
          `sector 0 should be source='both' (known to both actor and corp), got '${s0.source}'`,
        );

        // Sector 2: known only to P1 personally (corp ship never went).
        // Expect source='player' and visited=true (via Option B).
        const s2 = byId.get(2);
        assertExists(
          s2,
          "sector 2 should appear in local_map_region (actor knows it)",
        );
        assertEquals(
          s2.visited,
          true,
          "sector 2 should be visited via actor merge (Option B)",
        );
        assertEquals(
          s2.source,
          "player",
          `sector 2 should be source='player' (only actor knows it), got '${s2.source}'`,
        );

        // Sector 3: corp ship's current sector, corp learned it via move,
        // P1 never personally visited. Expect source='corp' and visited.
        const s3 = byId.get(3);
        assertExists(s3, "sector 3 missing from local_map_region");
        assertEquals(
          s3.visited,
          true,
          "sector 3 should be visited for corp ship (corp knows it)",
        );
        assertEquals(
          s3.source,
          "corp",
          `sector 3 should be source='corp' (only corp knows it), got '${s3.source}'`,
        );
      },
    );
  },
});

// ============================================================================
// Group 6: Regression — loadMapKnowledge for a human player with
// actor_character_id=self works unchanged and returns the player's own
// personal+corp union.
// ============================================================================

Deno.test({
  name: "map_knowledge — human player with actor=self behaves identically",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset + join + move to populate knowledge", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step(
      "plot_course for human target with actor=self from a known sector succeeds",
      async () => {
        const result = await apiOk("plot_course", {
          character_id: p1Id,
          actor_character_id: p1Id,
          from_sector: 0, // P1 knows sector 0 from join
          to_sector: 1,
        });
        assert(result.success);
      },
    );

    await t.step(
      "plot_course for human target from an unknown sector still fails",
      async () => {
        // Without Option B accidentally turning humans into "actor-merged"
        // identities, an unknown sector should still be rejected. We use a
        // sector the player has not visited as from_sector.
        const visited = new Set(await getPersonalVisitedSectors(p1Id));
        let unknownSector = -1;
        for (let id = 0; id < 10; id++) {
          if (!visited.has(id)) {
            unknownSector = id;
            break;
          }
        }
        assert(unknownSector >= 0, "test universe should have an unknown sector");
        const result = await apiOk("plot_course", {
          character_id: p1Id,
          to_sector: 1,
          // Try to route from an unknown sector; should be rejected.
          from_sector: unknownSector,
        }).catch((err) => ({ error: String(err) }));
        assert(
          "error" in result,
          `Expected plot_course to fail from unknown sector ${unknownSector}, got success`,
        );
      },
    );
  },
});
