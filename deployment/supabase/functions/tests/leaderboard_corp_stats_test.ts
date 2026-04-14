/**
 * TDD tests: corporation stats roll into each member's leaderboard row.
 *
 * Expected behavior once implemented (option 1 — full add):
 *   - wealth.total_wealth for a corp member = personal wealth + full sum of
 *     corporation-owned ship wealth (ship credits + cargo value + ship value).
 *     Corp pseudo-chars (player_type = 'corporation_ship') do NOT get a corp
 *     bonus on their own row.
 *   - exploration.sectors_visited for a corp member = |personal ∪ corp| (union,
 *     no double counting of overlapping sectors).
 *   - territory and trading remain personal-only.
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
  setShipCargo,
  setMegabankBalance,
  withPg,
} from "./helpers.ts";

const P1 = "lb_corp_p1";
const P2 = "lb_corp_p2";
const P3 = "lb_corp_p3"; // solo — control group

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p1ShipId: string;
let p2ShipId: string;

interface WealthRow {
  player_id: string;
  player_type: string;
  total_wealth: number;
  bank_credits: number;
  ship_credits: number;
  cargo_value: number;
  ship_value: number;
  ships_owned: number;
}

interface WealthBreakdown {
  ships_owned: number;
  ship_credits: number;
  cargo_value: number;
  ship_value: number;
  bank_credits: number;
}

/** Expected member breakdown: personal + full corp for each column. */
async function expectedMemberBreakdown(
  charId: string,
  corpId: string,
): Promise<WealthBreakdown> {
  return await withPg(async (pg) => {
    const r = await pg.queryObject<{
      ships_owned: string;
      ship_credits: string;
      cargo_value: string;
      ship_value: string;
      bank_credits: string;
    }>(
      `WITH personal AS (
         SELECT
           COUNT(*)::int AS ships_owned,
           COALESCE(SUM(si.credits), 0)::bigint AS ship_credits,
           COALESCE(SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100), 0)::bigint AS cargo_value,
           COALESCE(SUM(sd.base_value), 0)::bigint AS ship_value
         FROM ship_instances si
         JOIN ship_definitions sd ON sd.ship_type = si.ship_type
         WHERE NOT si.is_escape_pod
           AND si.owner_id = $1
           AND si.owner_type IS DISTINCT FROM 'corporation'
       ),
       corp AS (
         SELECT
           COUNT(*)::int AS ships_owned,
           COALESCE(SUM(si.credits), 0)::bigint AS ship_credits,
           COALESCE(SUM(si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100), 0)::bigint AS cargo_value,
           COALESCE(SUM(sd.base_value), 0)::bigint AS ship_value
         FROM ship_instances si
         JOIN ship_definitions sd ON sd.ship_type = si.ship_type
         WHERE NOT si.is_escape_pod
           AND si.owner_type = 'corporation'
           AND si.owner_corporation_id = $2
       )
       SELECT
         (p.ships_owned + c.ships_owned)::text AS ships_owned,
         (p.ship_credits + c.ship_credits)::text AS ship_credits,
         (p.cargo_value + c.cargo_value)::text AS cargo_value,
         (p.ship_value + c.ship_value)::text AS ship_value,
         ch.credits_in_megabank::text AS bank_credits
       FROM personal p, corp c, characters ch
       WHERE ch.character_id = $1`,
      [charId, corpId],
    );
    const row = r.rows[0];
    return {
      ships_owned: Number(row.ships_owned),
      ship_credits: Number(row.ship_credits),
      cargo_value: Number(row.cargo_value),
      ship_value: Number(row.ship_value),
      bank_credits: Number(row.bank_credits),
    };
  });
}
interface ExplorationRow {
  player_id: string;
  player_type: string;
  sectors_visited: number;
}
interface TerritoryRow {
  player_id: string;
  sectors_controlled: number;
  total_fighters_deployed: number;
}
interface TradingRow {
  player_id: string;
  total_trade_volume: number;
}

interface LbResp {
  wealth: WealthRow[];
  exploration: ExplorationRow[];
  territory: TerritoryRow[];
  trading: TradingRow[];
  cached: boolean;
  success: boolean;
}

async function fetchLeaderboard(): Promise<LbResp> {
  return await apiOk<LbResp>("leaderboard_resources", { force_refresh: true });
}

function findRow<T extends { player_id: string }>(
  rows: T[],
  id: string,
): T | undefined {
  return rows.find((r) => r.player_id === id);
}

/** Personal wealth: bank + all personally-owned (non-escape-pod) ships. */
async function personalWealth(charId: string): Promise<number> {
  return await withPg(async (pg) => {
    const r = await pg.queryObject<{ w: string }>(
      `SELECT (
         c.credits_in_megabank + COALESCE((
           SELECT SUM(
             si.credits
             + si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100
             + sd.base_value
           )
           FROM ship_instances si
           JOIN ship_definitions sd ON sd.ship_type = si.ship_type
           WHERE si.owner_id = c.character_id AND NOT si.is_escape_pod
         ), 0)
       )::text AS w
       FROM characters c WHERE c.character_id = $1`,
      [charId],
    );
    return Number(r.rows[0]?.w ?? 0);
  });
}

/** Total wealth of all ships owned by a corporation. */
async function corpShipWealth(corpId: string): Promise<number> {
  return await withPg(async (pg) => {
    const r = await pg.queryObject<{ w: string }>(
      `SELECT COALESCE(SUM(
         si.credits
         + si.cargo_qf * 100 + si.cargo_ro * 100 + si.cargo_ns * 100
         + sd.base_value
       ), 0)::text AS w
       FROM ship_instances si
       JOIN ship_definitions sd ON sd.ship_type = si.ship_type
       WHERE si.owner_type = 'corporation'
         AND si.owner_corporation_id = $1
         AND NOT si.is_escape_pod`,
      [corpId],
    );
    return Number(r.rows[0]?.w ?? 0);
  });
}

async function setCharacterMapKnowledge(
  charId: string,
  sectorIds: number[],
): Promise<void> {
  const sectors: Record<string, boolean> = {};
  for (const s of sectorIds) sectors[String(s)] = true;
  const mk = {
    sectors_visited: sectors,
    total_sectors_visited: sectorIds.length,
  };
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE characters SET map_knowledge = $1::jsonb WHERE character_id = $2`,
      [JSON.stringify(mk), charId],
    );
  });
}

async function setCorpMapKnowledge(
  corpId: string,
  sectorIds: number[],
): Promise<void> {
  const sectors: Record<string, boolean> = {};
  for (const s of sectorIds) sectors[String(s)] = true;
  const mk = {
    sectors_visited: sectors,
    total_sectors_visited: sectorIds.length,
  };
  await withPg(async (pg) => {
    await pg.queryObject(
      `INSERT INTO corporation_map_knowledge (corp_id, map_knowledge)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (corp_id) DO UPDATE SET map_knowledge = $2::jsonb`,
      [corpId, JSON.stringify(mk)],
    );
  });
}

// ============================================================================
// Group 0: start server + resolve IDs
// ============================================================================

Deno.test({
  name: "leaderboard_corp_stats — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p3Id = await characterIdFor(P3);
    p1ShipId = await shipIdFor(P1);
    p2ShipId = await shipIdFor(P2);
  },
});

// ============================================================================
// Group 1: wealth — single corp ship contributes credits + cargo + ship value
// to every active corp member; non-members and corp pseudo-chars unaffected.
// ============================================================================

Deno.test({
  name:
    "leaderboard_corp_stats — wealth: corp ship adds to all members, pseudo-char excluded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and form a 2-member corp with a solo control", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });

      await setMegabankBalance(p1Id, 500);
      await setMegabankBalance(p2Id, 200);
      await setMegabankBalance(p3Id, 100);

      // P1 funds and creates corp, P2 joins, P3 stays solo
      await setShipCredits(p1ShipId, 50000);
      const create = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Wealth Corp",
      });
      corpId = (create as Record<string, unknown>).corp_id as string;
      const invite = (create as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: invite,
      });

      // Predictable personal ship credits (post-fee state)
      await setShipCredits(p1ShipId, 1234);
      await setShipCredits(p2ShipId, 2345);
    });

    await t.step("insert one corp-owned ship with credits + cargo", async () => {
      const { shipId } = await createCorpShip(corpId, 0, "WealthShip");
      await setShipCredits(shipId, 7000);
      await setShipCargo(shipId, { qf: 3, ro: 2, ns: 1 }); // 600 cargo value
    });

    await t.step("both members' total_wealth includes full corp ship value", async () => {
      const lb = await fetchLeaderboard();

      const expectedCorp = await corpShipWealth(corpId);
      assert(expectedCorp > 0, "precondition: corp has positive ship wealth");

      const p1Expected = (await personalWealth(p1Id)) + expectedCorp;
      const p2Expected = (await personalWealth(p2Id)) + expectedCorp;
      const p3Expected = await personalWealth(p3Id);

      const p1Row = findRow(lb.wealth, p1Id);
      const p2Row = findRow(lb.wealth, p2Id);
      const p3Row = findRow(lb.wealth, p3Id);

      assert(p1Row, "P1 present in wealth leaderboard");
      assert(p2Row, "P2 present in wealth leaderboard");
      assert(p3Row, "P3 (solo) present in wealth leaderboard");

      assertEquals(
        Number(p1Row!.total_wealth),
        p1Expected,
        "P1 total = personal + full corp ship wealth",
      );
      assertEquals(
        Number(p2Row!.total_wealth),
        p2Expected,
        "P2 total = personal + full corp ship wealth",
      );
      assertEquals(
        Number(p3Row!.total_wealth),
        p3Expected,
        "P3 (no corp) total is personal-only",
      );
    });

    await t.step("breakdown columns reflect personal + corp sums", async () => {
      const lb = await fetchLeaderboard();
      const p1Row = findRow(lb.wealth, p1Id)!;
      const p2Row = findRow(lb.wealth, p2Id)!;

      const p1Exp = await expectedMemberBreakdown(p1Id, corpId);
      const p2Exp = await expectedMemberBreakdown(p2Id, corpId);

      // P1
      assertEquals(Number(p1Row.bank_credits), p1Exp.bank_credits, "P1 bank_credits");
      assertEquals(Number(p1Row.ship_credits), p1Exp.ship_credits, "P1 ship_credits = personal + corp");
      assertEquals(Number(p1Row.cargo_value), p1Exp.cargo_value, "P1 cargo_value = personal + corp");
      assertEquals(Number(p1Row.ship_value), p1Exp.ship_value, "P1 ship_value = personal + corp");
      assertEquals(Number(p1Row.ships_owned), p1Exp.ships_owned, "P1 ships_owned = personal + corp");

      // P2
      assertEquals(Number(p2Row.ship_credits), p2Exp.ship_credits, "P2 ship_credits = personal + corp");
      assertEquals(Number(p2Row.cargo_value), p2Exp.cargo_value, "P2 cargo_value = personal + corp");
      assertEquals(Number(p2Row.ship_value), p2Exp.ship_value, "P2 ship_value = personal + corp");
      assertEquals(Number(p2Row.ships_owned), p2Exp.ships_owned, "P2 ships_owned = personal + corp");

      // Sanity: total_wealth equals the four breakdown columns + bank
      const p1Sum = Number(p1Row.bank_credits) + Number(p1Row.ship_credits)
        + Number(p1Row.cargo_value) + Number(p1Row.ship_value);
      assertEquals(Number(p1Row.total_wealth), p1Sum, "P1 total_wealth reconciles with breakdown");
    });

    await t.step("corp pseudo-char rows must NOT receive the corp bonus", async () => {
      const lb = await fetchLeaderboard();
      const pseudoRows = lb.wealth.filter(
        (r) => r.player_type === "corporation_ship",
      );
      for (const row of pseudoRows) {
        // Either excluded entirely, or present with only their own personal calc.
        // Guards against naive join on characters.corporation_id double-counting
        // the ship against itself.
        const expected = await personalWealth(row.player_id);
        assertEquals(
          Number(row.total_wealth),
          expected,
          `pseudo-char ${row.player_id} should not receive corp bonus`,
        );
      }
    });
  },
});

// ============================================================================
// Group 2: wealth — multiple corp ships all sum into each member's total
// ============================================================================

Deno.test({
  name: "leaderboard_corp_stats — wealth: multiple corp ships all contribute",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and form corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const create = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Fleet Corp",
      });
      corpId = (create as Record<string, unknown>).corp_id as string;
      const invite = (create as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: invite,
      });
      await setShipCredits(p1ShipId, 0);
      await setShipCredits(p2ShipId, 0);
    });

    await t.step("insert three corp ships with distinct credit balances", async () => {
      const a = await createCorpShip(corpId, 0, "Alpha");
      const b = await createCorpShip(corpId, 0, "Bravo");
      const c = await createCorpShip(corpId, 0, "Charlie");
      await setShipCredits(a.shipId, 1000);
      await setShipCredits(b.shipId, 2000);
      await setShipCredits(c.shipId, 3000);
    });

    await t.step("both members' total_wealth includes the whole corp fleet", async () => {
      const lb = await fetchLeaderboard();
      const expectedCorp = await corpShipWealth(corpId);
      const p1Expected = (await personalWealth(p1Id)) + expectedCorp;
      const p2Expected = (await personalWealth(p2Id)) + expectedCorp;

      assertEquals(
        Number(findRow(lb.wealth, p1Id)!.total_wealth),
        p1Expected,
      );
      assertEquals(
        Number(findRow(lb.wealth, p2Id)!.total_wealth),
        p2Expected,
      );
    });
  },
});

// ============================================================================
// Group 3: exploration — corp map knowledge unioned into sectors_visited
// ============================================================================

Deno.test({
  name:
    "leaderboard_corp_stats — exploration: corp sectors unioned into member totals",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset, form corp, leave P3 solo", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50000);
      const create = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Explorer Corp",
      });
      corpId = (create as Record<string, unknown>).corp_id as string;
      const invite = (create as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: invite,
      });
    });

    await t.step("set disjoint personal and corp map knowledge", async () => {
      await setCharacterMapKnowledge(p1Id, [100, 101, 102]); // 3
      await setCharacterMapKnowledge(p2Id, [200, 201]); // 2
      await setCharacterMapKnowledge(p3Id, [300]); // 1 (solo)
      await setCorpMapKnowledge(corpId, [500, 501, 502, 503]); // 4
    });

    await t.step("sectors_visited equals personal ∪ corp for members", async () => {
      const lb = await fetchLeaderboard();
      assertEquals(
        Number(findRow(lb.exploration, p1Id)!.sectors_visited),
        3 + 4,
        "P1: 3 personal + 4 corp, no overlap",
      );
      assertEquals(
        Number(findRow(lb.exploration, p2Id)!.sectors_visited),
        2 + 4,
        "P2: 2 personal + 4 corp, no overlap",
      );
      assertEquals(
        Number(findRow(lb.exploration, p3Id)!.sectors_visited),
        1,
        "P3 (solo) unchanged = 1",
      );
    });
  },
});

// ============================================================================
// Group 4: exploration — overlapping sectors must not be double-counted
// ============================================================================

Deno.test({
  name:
    "leaderboard_corp_stats — exploration: overlapping sectors counted once",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset, form corp", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const create = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Overlap Corp",
      });
      corpId = (create as Record<string, unknown>).corp_id as string;
      const invite = (create as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: invite,
      });
    });

    await t.step("set overlapping personal ∩ corp map knowledge", async () => {
      // P1 personal {5,6,7}; corp {6,7,8,9}; union = {5,6,7,8,9} = 5
      await setCharacterMapKnowledge(p1Id, [5, 6, 7]);
      // P2 personal {} (0); corp same as above = 4
      await setCharacterMapKnowledge(p2Id, []);
      await setCorpMapKnowledge(corpId, [6, 7, 8, 9]);
    });

    await t.step("union-size is correct, no double counting", async () => {
      const lb = await fetchLeaderboard();
      assertEquals(
        Number(findRow(lb.exploration, p1Id)!.sectors_visited),
        5,
        "overlap {6,7} should not double-count — union is 5",
      );
      assertEquals(
        Number(findRow(lb.exploration, p2Id)!.sectors_visited),
        4,
        "empty personal + 4 corp = 4",
      );
    });
  },
});

// ============================================================================
// Group 5: regression — territory and trading must stay personal-only
// ============================================================================

Deno.test({
  name:
    "leaderboard_corp_stats — territory + trading remain personal-only (regression)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset, form corp, add a corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
      const create = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Regress Corp",
      });
      corpId = (create as Record<string, unknown>).corp_id as string;
      const invite = (create as Record<string, unknown>).invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: invite,
      });
      await createCorpShip(corpId, 0, "TerritoryShip");
    });

    await t.step("territory: no personal garrisons means no row", async () => {
      const lb = await fetchLeaderboard();
      // territory view uses INNER JOIN on garrisons; with no personal garrisons
      // the members must not appear even though a corp ship exists.
      assertEquals(findRow(lb.territory, p1Id), undefined);
      assertEquals(findRow(lb.territory, p2Id), undefined);
    });

    await t.step("trading: no personal trades means no row", async () => {
      const lb = await fetchLeaderboard();
      assertEquals(findRow(lb.trading, p1Id), undefined);
      assertEquals(findRow(lb.trading, p2Id), undefined);
    });
  },
});
