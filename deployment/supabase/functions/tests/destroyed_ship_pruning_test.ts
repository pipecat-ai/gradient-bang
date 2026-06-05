import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  apiOk,
  characterIdFor,
  createCorpShip,
  ensureSectorHasPort,
  queryShip,
  setShipCredits,
  shipIdFor,
  withPg,
} from "./helpers.ts";

const P1 = "destroyed_ship_prune_p1";

let p1Id: string;
let p1ShipId: string;

async function detachDestroyedCorpShip(shipId: string): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `DELETE FROM corporation_ships WHERE ship_id = $1`,
      [shipId],
    );
    await pg.queryObject(
      `DELETE FROM characters WHERE character_id = $1`,
      [shipId],
    );
  });
}

async function setDestroyedAt(
  shipId: string,
  destroyedAt: string,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances
       SET destroyed_at = $1
       WHERE ship_id = $2`,
      [destroyedAt, shipId],
    );
  });
}

async function portIdForSector(sectorId: number): Promise<number> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ port_id: number }>(
      `SELECT port_id FROM ports WHERE sector_id = $1`,
      [sectorId],
    );
    return result.rows[0].port_id;
  });
}

Deno.test({
  name: "destroyed_ship_pruning — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
    p1Id = await characterIdFor(P1);
    p1ShipId = await shipIdFor(P1);
  },
});

Deno.test({
  name:
    "destroyed_ship_pruning — prune_destroyed_ships scrubs references then deletes old rows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let oldFreeShipId: string;
    let oldEventShipId: string;
    let oldPortShipId: string;
    let recentShipId: string;
    let portId: number;

    await t.step("reset, join, and create a corporation context", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
      await ensureSectorHasPort(0);
      portId = await portIdForSector(0);

      const create = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Destroyed Ship Prune Corp",
      });
      const corpId = (create as Record<string, unknown>).corp_id as string;

      const oldFree = await createCorpShip(corpId, 0, "Old Free Destroyed");
      const oldEvent = await createCorpShip(corpId, 0, "Old Event Destroyed");
      const oldPort = await createCorpShip(corpId, 0, "Old Port Destroyed");
      const recent = await createCorpShip(corpId, 0, "Recent Destroyed");

      oldFreeShipId = oldFree.shipId;
      oldEventShipId = oldEvent.shipId;
      oldPortShipId = oldPort.shipId;
      recentShipId = recent.shipId;

      await detachDestroyedCorpShip(oldFreeShipId);
      await detachDestroyedCorpShip(oldEventShipId);
      await detachDestroyedCorpShip(oldPortShipId);
      await detachDestroyedCorpShip(recentShipId);
    });

    await t.step(
      "mark ships destroyed with old and recent retention ages",
      async () => {
        const fifteenDaysAgo = new Date(
          Date.now() - 15 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const oneDayAgo = new Date(
          Date.now() - 24 * 60 * 60 * 1000,
        ).toISOString();

        await setDestroyedAt(oldFreeShipId, fifteenDaysAgo);
        await setDestroyedAt(oldEventShipId, fifteenDaysAgo);
        await setDestroyedAt(oldPortShipId, fifteenDaysAgo);
        await setDestroyedAt(recentShipId, oneDayAgo);
      },
    );

    await t.step(
      "add one event reference and one port transaction reference",
      async () => {
        await withPg(async (pg) => {
          await pg.queryObject(
            `INSERT INTO events (
            direction, event_type, scope, character_id, ship_id, payload,
            recipient_character_id, recipient_reason, inserted_at
          ) VALUES (
            'event_out', 'test.destroyed_ship_reference', 'direct', $1, $2, '{}'::jsonb,
            $1, 'direct', NOW()
          )`,
            [p1Id, oldEventShipId],
          );

          await pg.queryObject(
            `INSERT INTO port_transactions (
            sector_id, port_id, character_id, ship_id, commodity, quantity,
            transaction_type, price_per_unit, total_price
          ) VALUES (
            0, $1, $2, $3, 'QF', 1, 'buy', 100, 100
          )`,
            [portId, p1Id, oldPortShipId],
          );
        });
      },
    );

    await t.step(
      "manual pruning removes only the old unreferenced ship",
      async () => {
        const pruned = await withPg(async (pg) => {
          const result = await pg.queryObject<{ pruned: number }>(
            `SELECT prune_destroyed_ships() AS pruned`,
          );
          return Number(result.rows[0].pruned);
        });

        assertEquals(pruned, 3, "All old destroyed ships should be pruned after scrubbing references");

        const oldFree = await queryShip(oldFreeShipId);
        const oldEvent = await queryShip(oldEventShipId);
        const oldPort = await queryShip(oldPortShipId);
        const recent = await queryShip(recentShipId);

        assertEquals(
          oldFree,
          null,
          "Old destroyed ship with no remaining references should be deleted",
        );
        assertEquals(
          oldEvent,
          null,
          "Old destroyed ship with an event reference should be deleted after event scrub",
        );
        assertEquals(
          oldPort,
          null,
          "Old destroyed ship with a port transaction reference should be deleted after transaction scrub",
        );
        assertExists(
          recent,
          "Recent destroyed ship must be retained until it ages past retention",
        );
      },
    );

    await t.step(
      "historical events are retained with ship_id nulled and port transactions are deleted",
      async () => {
        await withPg(async (pg) => {
          const eventResult = await pg.queryObject<{ ship_id: string | null }>(
            `SELECT ship_id
             FROM events
             WHERE event_type = 'test.destroyed_ship_reference'`,
          );
          assertEquals(eventResult.rows.length, 1, "Historical event row should remain");
          assertEquals(
            eventResult.rows[0].ship_id,
            null,
            "Historical event ship_id should be nulled before pruning the ship row",
          );

          const txResult = await pg.queryObject<{ count: number }>(
            `SELECT COUNT(*)::int AS count
             FROM port_transactions
             WHERE ship_id = $1`,
            [oldPortShipId],
          );
          assertEquals(
            txResult.rows[0].count,
            0,
            "Port transactions for pruned ships should be removed",
          );
        });
      },
    );
  },
});
