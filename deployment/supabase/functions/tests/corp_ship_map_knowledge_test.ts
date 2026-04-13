/**
 * TDD tests for corp ship map knowledge. These encode the *desired* behavior
 * and currently fail against the unfixed codebase. Each group targets one
 * half of the planned fix so that passing both requires both halves.
 *
 * Option A — seed the spawn sector into the corp ship's knowledge at
 *   purchase time so that a freshly spawned ship knows where it is.
 * Option B — merge the driving actor's personal map knowledge into the
 *   corp ship's map knowledge at read time so that the ship can see
 *   through the player controlling it.
 *
 * Group 1 isolates Option A (spawn sector is unknown to the actor, so B
 *   alone cannot rescue it). Group 2 isolates Option B (the query sector
 *   is different from the corp ship's spawn sector, so A alone cannot
 *   rescue it). Group 3 sanity-checks what the player knows at the point
 *   these tests branch.
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
  createCorpShip,
  setShipCredits,
  withPg,
} from "./helpers.ts";

const P1 = "test_corp_ship_map_p1";

let p1Id: string;
let p1ShipId: string;

// The test universe spawns 10 sectors (ids 0..9). See test_reset/index.ts.
const UNIVERSE_SECTOR_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

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

/**
 * Pick a universe sector id that is NOT in `known`. Asserts that at least
 * one such sector exists to keep test intent unambiguous.
 */
function pickUnknownSector(known: number[]): number {
  const knownSet = new Set(known);
  for (const id of UNIVERSE_SECTOR_IDS) {
    if (!knownSet.has(id)) return id;
  }
  throw new Error(
    `No universe sector found outside known set: ${known.join(",")}`,
  );
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
// Group 1: Option A — corp ship knows its own spawn sector
//
// Targets Option A in isolation: the corp ship is spawned at a sector the
// *actor* does not know, so merging the actor's personal knowledge (Option B)
// cannot make this test pass on its own. Only a fix that records the spawn
// sector in the corp ship's knowledge at purchase time will.
// ============================================================================

Deno.test({
  name: "corp_ship_map — corp ship knows its spawn sector (requires Option A)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p1ShipId = await shipIdFor(P1);

    let corpId: string;
    let corpShipId: string;
    let spawnSector: number;

    await t.step("reset + join player", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("spawn corp ship at a sector the actor does not know", async () => {
      const playerKnown = await getPersonalVisitedSectors(p1Id);
      assert(
        playerKnown.length > 0,
        "Sanity: player should know at least their join sector",
      );
      spawnSector = pickUnknownSector(playerKnown);
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Spawn Sector Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const shipResult = await createCorpShip(corpId, spawnSector, "Spawn Probe");
      corpShipId = shipResult.pseudoCharacterId;
    });

    await t.step(
      "list_known_ports from the spawn sector succeeds for the corp ship",
      async () => {
        // With Option A the corp ship's map knowledge contains its spawn
        // sector, regardless of what the actor knows. Option B alone cannot
        // satisfy this test because the actor does not know `spawnSector`.
        const result = await apiOk("list_known_ports", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          from_sector: spawnSector,
          max_hops: 5,
        });
        assert(result.success);
      },
    );
  },
});

// ============================================================================
// Group 2: Option B — corp ship inherits the actor's explored sectors
//
// Targets Option B in isolation: the corp ship is spawned at a sector
// disjoint from the query sector. Option A alone (seeding only the spawn
// sector) cannot make this test pass — only merging the actor's personal
// knowledge into the corp ship's read-time view will.
// ============================================================================

Deno.test({
  name: "corp_ship_map — corp ship inherits actor knowledge (requires Option B)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;
    let actorKnownSector: number;
    let spawnSector: number;

    await t.step("reset + join player", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      const playerKnown = await getPersonalVisitedSectors(p1Id);
      assert(playerKnown.length > 0, "Sanity: player should know its join sector");
      actorKnownSector = playerKnown[0];
    });

    await t.step(
      "spawn corp ship at a sector different from the actor's known sector",
      async () => {
        spawnSector = pickUnknownSector([actorKnownSector]);
        assert(
          spawnSector !== actorKnownSector,
          "Test precondition: spawnSector must differ from actorKnownSector",
        );
        await setShipCredits(p1ShipId, 50000);
        const createResult = await apiOk("corporation_create", {
          character_id: p1Id,
          name: "Actor Merge Corp",
        });
        corpId = (createResult as Record<string, unknown>).corp_id as string;
        const shipResult = await createCorpShip(corpId, spawnSector, "Merge Probe");
        corpShipId = shipResult.pseudoCharacterId;
      },
    );

    await t.step(
      "list_known_ports from an actor-known (non-spawn) sector succeeds",
      async () => {
        // With Option B the corp ship's merged knowledge includes the
        // actor's personal sectors, so `actorKnownSector` is accepted.
        // Option A alone cannot satisfy this test because `actorKnownSector`
        // is not the corp ship's spawn sector.
        const result = await apiOk("list_known_ports", {
          character_id: corpShipId,
          actor_character_id: p1Id,
          from_sector: actorKnownSector,
          max_hops: 5,
        });
        assert(result.success);
      },
    );
  },
});

// ============================================================================
// Group 3: Sanity — document the preconditions that make A and B separable
// ============================================================================

Deno.test({
  name: "corp_ship_map — preconditions: player knows exactly one sector after join",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset + join player", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step(
      "player's personal knowledge holds exactly the join sector",
      async () => {
        // Groups 1 and 2 rely on the fact that a freshly joined player knows
        // only their spawn sector — that's what lets us construct a sector
        // the actor does NOT know for the corp ship to spawn at. If this
        // test breaks (e.g. join starts seeding more sectors) the A/B
        // separation in Groups 1 and 2 may need to be rethought.
        const visited = await getPersonalVisitedSectors(p1Id);
        assertEquals(
          visited.length,
          1,
          `Expected player to know exactly 1 sector after join, got ${visited.length}: ` +
            JSON.stringify(visited),
        );
      },
    );
  },
});
