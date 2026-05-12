/**
 * wake_agent edge-function tests.
 *
 * Covers the Phase 3.1 stub: standard authenticate + canActOnCharacter,
 * BYOA-ship guard, and the {success:true, status:"stub"} response shape.
 * The wake mechanism itself is intentionally not exercised — there isn't
 * one yet, the endpoint just logs.
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
  createCorpShip,
  setShipCredits,
  shipIdFor,
  withPg,
} from "./helpers.ts";

const P1 = "test_wake_p1";
const P2 = "test_wake_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;

async function seedCorpWithMembers(
  founderId: string,
  members: string[],
  corpName: string,
): Promise<{ corpId: string; corpShipId: string }> {
  const createResult = await apiOk("corporation_create", {
    character_id: founderId,
    name: corpName,
  });
  const corpId = (createResult as Record<string, unknown>).corp_id as string;
  for (const memberId of members) {
    await withPg(async (pg) => {
      await pg.queryObject(
        `INSERT INTO corporation_members (corp_id, character_id, joined_at)
         VALUES ($1, $2, NOW())`,
        [corpId, memberId],
      );
    });
  }
  const ship = await createCorpShip(corpId, 0, `${corpName} Probe`);
  return { corpId, corpShipId: ship.pseudoCharacterId };
}

Deno.test({
  name: "wake_agent — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

Deno.test({
  name: "wake_agent — stub returns success for a claimed BYOA ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);

    let corpShipId: string;

    await t.step("seed corp + claim BYOA", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Wake Stub Corp");
      corpShipId = seeded.corpShipId;
      await apiOk("ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "private",
      });
    });

    await t.step("happy path → 200 with status:'stub'", async () => {
      const result = await apiOk("wake_agent", {
        ship_id: corpShipId,
        character_id: p1Id,
        task_id: crypto.randomUUID(),
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.status, "stub");
      assertEquals(body.ship_id, corpShipId);
      assert(typeof body.request_id === "string");
    });

    await t.step("non-BYOA ship → 400 not_a_byoa_ship", async () => {
      const result = await api("wake_agent", {
        ship_id: p1ShipId,
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
      assertEquals(
        (result.body as Record<string, unknown>).error,
        "not_a_byoa_ship",
      );
    });

    await t.step("unknown ship_id → 404 ship_not_found", async () => {
      const result = await api("wake_agent", {
        ship_id: crypto.randomUUID(),
        character_id: p1Id,
      });
      assertEquals(result.status, 404);
    });

    await t.step("invalid ship_id → 400", async () => {
      const result = await api("wake_agent", {
        ship_id: "not-a-uuid",
        character_id: p1Id,
      });
      assertEquals(result.status, 400);
    });
  },
});
