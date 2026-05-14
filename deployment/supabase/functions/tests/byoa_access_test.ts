/**
 * BYOA access control + ship_byoa_configure tests.
 *
 * Covers the BYOA-owner enforcement and configure rules. The DB-persistent
 * ship-task lock was removed; "task in progress" is now derived from
 * task.start/task.finish/task.cancel events in the events table.
 *
 *   - task_lifecycle blocks non-owners from starting/finishing a task on a
 *     BYOA corp ship (403 byoa_private_not_owner).
 *   - task_cancel blocks non-owners from cancelling a BYOA task;
 *     force=true is still allowed for corp members.
 *   - ship_byoa_configure claim/clear happy paths and rejections.
 *
 * Setup:
 *   - P1 (BYOA owner candidate), P2 (other corp member), P3 (non-corp)
 *   - One corp with a corp ship.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiAs,
  apiAsOk,
  apiOk,
  characterIdFor,
  createCorpShip,
  eventsOfType,
  getEventCursor,
  provisionUser,
  setShipCredits,
  setShipSector,
  shipIdFor,
  type TestUser,
  withPg,
} from "./helpers.ts";

const P1 = "test_byoa_p1";
const P2 = "test_byoa_p2";
const P3 = "test_byoa_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
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

async function readShipByoa(
  shipId: string,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT byoa_owner_character_id, byoa_mode
         FROM ship_instances
        WHERE ship_id = $1`,
      [shipId],
    );
    return result.rows[0] ?? null;
  });
}

/**
 * Server's events-derived view of "which task is currently running on this
 * ship", matching the logic in functions/_shared/tasks.ts: latest task.start
 * for the ship within the active-task window, minus any task with a
 * matching task.finish/task.cancel.
 */
async function activeTaskIdForShip(shipId: string): Promise<string | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ task_id: string | null }>(
      `SELECT s.task_id
         FROM events s
        WHERE s.event_type = 'task.start'
          AND s.ship_id = $1
          AND s.inserted_at > NOW() - INTERVAL '60 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM events f
            WHERE f.task_id = s.task_id
              AND f.event_type IN ('task.finish', 'task.cancel')
              AND f.inserted_at >= s.inserted_at
          )
        ORDER BY s.inserted_at DESC
        LIMIT 1`,
      [shipId],
    );
    return result.rows[0]?.task_id ?? null;
  });
}

// ============================================================================
// Bootstrap
// ============================================================================

Deno.test({
  name: "byoa_access — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: task_lifecycle BYOA owner check
// ============================================================================

Deno.test({
  name: "byoa_access — BYOA ship blocks non-owner; owner succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p1ShipId = await shipIdFor(P1);

    let corpShipId: string;

    let p1User: TestUser;

    await t.step("seed corp + members + corp ship", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "BYOA Test Corp");
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("byoa-p1", p1Id);
    });

    await t.step("P1 claims BYOA on the corp ship", async () => {
      const result = await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
      const body = result as Record<string, unknown>;
      assertEquals(body.byoa_owner_character_id, p1Id);
      assertEquals(body.byoa_mode, "private");
      assertEquals(body.changed, true);

      const row = await readShipByoa(corpShipId);
      assertEquals(row?.byoa_owner_character_id, p1Id);
      assertEquals(row?.byoa_mode, "private");
    });

    await t.step(
      "P2 (non-owner) task.start → 403 byoa_private_not_owner",
      async () => {
        const result = await api("task_lifecycle", {
          character_id: corpShipId,
          actor_character_id: p2Id,
          task_id: crypto.randomUUID(),
          event_type: "start",
          task_description: "should be blocked",
        });
        assertEquals(result.status, 403);
        const body = result.body as Record<string, unknown>;
        assertEquals(body.error, "byoa_private_not_owner");
        assertEquals(
          body.byoa_owner_character_id_prefix,
          p1Id.replace(/-/g, "").slice(0, 12),
        );

        // Non-owner was blocked before any task.start was emitted.
        assertEquals(await activeTaskIdForShip(corpShipId), null);
      },
    );

    await t.step("P1 (owner) task.start succeeds", async () => {
      const taskId = crypto.randomUUID();
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "owner task",
      });
      assertEquals(await activeTaskIdForShip(corpShipId), taskId);

      // Cleanup so subsequent tests don't see this task as active.
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "finish",
      });
    });
  },
});

// ============================================================================
// Group 2: task_cancel respects BYOA ownership; force=true escapes
// ============================================================================

Deno.test({
  name:
    "byoa_access — task_cancel blocks non-owner on BYOA; force=true bypasses",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    const taskId = crypto.randomUUID();

    let p1User: TestUser;

    await t.step("seed corp + claim private + start task", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(
        p1Id,
        [p2Id],
        "Cancel BYOA Corp",
      );
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("byoa-cancel-p1", p1Id);
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "owner task",
      });
    });

    await t.step("P2 normal cancel → 403 byoa_private_not_owner", async () => {
      const result = await api("task_cancel", {
        character_id: p2Id,
        task_id: taskId,
      });
      assertEquals(result.status, 403);
      assertEquals(
        (result.body as Record<string, unknown>).error,
        "byoa_private_not_owner",
      );

      // No cancel event was emitted — task still appears active.
      assertEquals(await activeTaskIdForShip(corpShipId), taskId);
    });

    await t.step(
      "P2 task.finish → 403; task still appears active",
      async () => {
        const result = await api("task_lifecycle", {
          character_id: corpShipId,
          actor_character_id: p2Id,
          task_id: taskId,
          event_type: "finish",
          task_summary: "should not finish BYOA task",
        });
        assertEquals(result.status, 403);
        assertEquals(
          (result.body as Record<string, unknown>).error,
          "byoa_private_not_owner",
        );

        assertEquals(await activeTaskIdForShip(corpShipId), taskId);
      },
    );

    await t.step(
      "P2 force=true succeeds; cancel event emitted, task no longer active",
      async () => {
        const result = await api("task_cancel", {
          character_id: p2Id,
          task_id: taskId,
          force: true,
        });
        assertEquals(result.status, 200);
        assertEquals(await activeTaskIdForShip(corpShipId), null);
      },
    );
  },
});

// ============================================================================
// Group 3: ship_byoa_configure happy paths + rejections
// ============================================================================

Deno.test({
  name: "byoa_access — ship_byoa_configure self-only claim",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let p1User: TestUser;
    let p2User: TestUser;
    let p3User: TestUser;

    await t.step("seed corp", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      p3Id = await characterIdFor(P3);
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Configure Corp");
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("byoa-cfg-p1", p1Id);
      p2User = await provisionUser("byoa-cfg-p2", p2Id);
      p3User = await provisionUser("byoa-cfg-p3", p3Id);
    });

    await t.step("P3 (non-corp) cannot configure", async () => {
      const result = await apiAs(p3User.accessToken, "ship_byoa_configure", {
        character_id: p3Id,
        ship_id: corpShipId,
        action: "claim",
      });
      assertEquals(result.status, 403);
    });

    await t.step("P1 claims", async () => {
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
    });

    await t.step("P2 cannot re-claim while P1 owns", async () => {
      const result = await apiAs(p2User.accessToken, "ship_byoa_configure", {
        character_id: p2Id,
        ship_id: corpShipId,
        action: "claim",
      });
      assertEquals(result.status, 409);
    });

    await t.step("shared mode is rejected", async () => {
      const result = await apiAs(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
        mode: "shared",
      });
      assertEquals(result.status, 400);
    });

    await t.step("P1 clears; row is back to defaults", async () => {
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "clear",
      });
      const row = await readShipByoa(corpShipId);
      assertEquals(row?.byoa_owner_character_id, null);
      assertEquals(row?.byoa_mode, "private"); // back to migration default
    });
  },
});

Deno.test({
  name: "byoa_access — clearing BYOA enforces purchaser corp ship owner cap",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const previousCap = Deno.env.get("CORPORATION_SHIP_OWNER_CAP");
    Deno.env.set("CORPORATION_SHIP_OWNER_CAP", "1");
    try {
      let firstCorpShipId: string;
      let p1User: TestUser;

      await t.step("seed corp and buy first ship", async () => {
        await resetDatabase([P1]);
        await apiOk("join", { character_id: p1Id });
        await setShipSector(p1ShipId, 0);
        await setShipCredits(p1ShipId, 50000);
        await apiOk("corporation_create", {
          character_id: p1Id,
          name: "BYOA Cap Corp",
        });
        await setShipCredits(p1ShipId, 50000);
        p1User = await provisionUser("byoa-cap-p1", p1Id);

        const result = await apiOk("ship_purchase", {
          character_id: p1Id,
          ship_type: "autonomous_probe",
          purchase_type: "corporation",
        });
        firstCorpShipId = (result as Record<string, unknown>).ship_id as string;
      });

      await t.step("claiming first ship exempts it from the cap", async () => {
        await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
          character_id: p1Id,
          ship_id: firstCorpShipId,
          action: "claim",
        });

        const result = await apiOk("ship_purchase", {
          character_id: p1Id,
          ship_type: "autonomous_probe",
          purchase_type: "corporation",
        });
        assert((result as Record<string, unknown>).ship_id);
      });

      await t.step(
        "clearing the claim would exceed the cap and fails",
        async () => {
          const result = await apiAs(
            p1User.accessToken,
            "ship_byoa_configure",
            {
              character_id: p1Id,
              ship_id: firstCorpShipId,
              action: "clear",
            },
          );
          assertEquals(result.status, 409);
          assert(
            result.body.error?.includes("corp_ship_owner_limit_exceeded"),
            `Expected owner cap error, got: ${result.body.error}`,
          );

          const row = await readShipByoa(firstCorpShipId);
          assertEquals(row?.byoa_owner_character_id, p1Id);
        },
      );
    } finally {
      if (previousCap === undefined) {
        Deno.env.delete("CORPORATION_SHIP_OWNER_CAP");
      } else {
        Deno.env.set("CORPORATION_SHIP_OWNER_CAP", previousCap);
      }
    }
  },
});

async function readShipWakeConfig(
  shipId: string,
): Promise<{ source_url: string | null; wake_secret: string | null }> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{
      source_url: string | null;
      wake_secret: string | null;
    }>(
      `SELECT source_url, wake_secret
         FROM public.get_ship_byoa_wake_config($1::uuid)`,
      [shipId],
    );
    return result.rows[0] ?? { source_url: null, wake_secret: null };
  });
}

Deno.test({
  name: "byoa_access — ship_byoa_configure set writes wake config",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let p1User: TestUser;
    let p2User: TestUser;
    const wakeSecret = "deadbeef".repeat(8);
    const sourceUrl = "https://example.test/api/wake";

    await t.step("seed corp + P1 claims", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [p2Id], "Set Corp");
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("byoa-set-p1", p1Id);
      p2User = await provisionUser("byoa-set-p2", p2Id);
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
    });

    await t.step("P2 (non-owner) set → 403", async () => {
      const result = await apiAs(p2User.accessToken, "ship_byoa_configure", {
        character_id: p2Id,
        ship_id: corpShipId,
        action: "set",
        wake_secret: wakeSecret,
      });
      assertEquals(result.status, 403);
    });

    await t.step("set with neither field → 400", async () => {
      const result = await apiAs(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "set",
      });
      assertEquals(result.status, 400);
    });

    await t.step("set with bad source_url → 400", async () => {
      const result = await apiAs(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "set",
        source_url: "ftp://nope",
      });
      assertEquals(result.status, 400);
    });

    await t.step(
      "P1 set wake_secret + source_url; round-trip via getter",
      async () => {
        const result = await apiAsOk(
          p1User.accessToken,
          "ship_byoa_configure",
          {
            character_id: p1Id,
            ship_id: corpShipId,
            action: "set",
            wake_secret: wakeSecret,
            source_url: sourceUrl,
          },
        );
        const body = result as Record<string, unknown>;
        assertEquals(body.wake_secret_updated, true);
        assertEquals(body.source_url_updated, true);

        const cfg = await readShipWakeConfig(corpShipId);
        assertEquals(cfg.wake_secret, wakeSecret);
        assertEquals(cfg.source_url, sourceUrl);
      },
    );

    await t.step("set source_url only leaves wake_secret intact", async () => {
      const newUrl = "https://example.test/v2/wake";
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "set",
        source_url: newUrl,
      });
      const cfg = await readShipWakeConfig(corpShipId);
      assertEquals(cfg.wake_secret, wakeSecret);
      assertEquals(cfg.source_url, newUrl);
    });
  },
});

Deno.test({
  name: "byoa_access — ship_byoa_configure refuses while a task is running",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    let p1User: TestUser;

    await t.step("seed corp + active task (non-BYOA)", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(
        p1Id,
        [],
        "Locked Configure Corp",
      );
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("byoa-busy-p1", p1Id);
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: crypto.randomUUID(),
        event_type: "start",
        task_description: "blocks configure",
      });
    });

    await t.step("claim while held → 409 ship_busy", async () => {
      const result = await apiAs(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
      assertEquals(result.status, 409);
      assertEquals(
        (result.body as Record<string, unknown>).error,
        "ship_busy",
      );
    });
  },
});

// ============================================================================
// Group 5: Ship-list payload shape (BYOA + current_task_actor blocks)
// ============================================================================

Deno.test({
  name:
    "byoa_access — list_user_ships payload includes byoa + current_task_actor blocks",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpShipId: string;
    const taskId = crypto.randomUUID();

    let p1User: TestUser;

    await t.step("seed corp + claim BYOA + start a task", async () => {
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50_000);
      const seeded = await seedCorpWithMembers(p1Id, [], "Payload Corp");
      corpShipId = seeded.corpShipId;
      p1User = await provisionUser("byoa-payload-p1", p1Id);
      await apiAsOk(p1User.accessToken, "ship_byoa_configure", {
        character_id: p1Id,
        ship_id: corpShipId,
        action: "claim",
      });
      await apiOk("task_lifecycle", {
        character_id: corpShipId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "payload smoke",
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step(
      "list_user_ships emits BYOA + actor blocks (truncated)",
      async () => {
        await apiOk("list_user_ships", { character_id: p1Id });
        const events = await eventsOfType(p1Id, "ships.list", cursor);
        assert(events.length >= 1);
        const ships = (events[0].payload as Record<string, unknown>)
          .ships as Array<Record<string, unknown>>;

        const corpShip = ships.find((s) => s.ship_id === corpShipId);
        assert(corpShip, "corp ship present in payload");

        // current_task_actor: truncated, 12 chars, no dashes
        const actor = corpShip.current_task_actor as
          | Record<string, unknown>
          | null;
        assert(actor, "current_task_actor populated for active task");
        assertEquals(
          actor!.character_id_prefix,
          p1Id.replace(/-/g, "").slice(0, 12),
        );

        // byoa: truncated owner only; mode is intentionally not surfaced.
        const byoa = corpShip.byoa as Record<string, unknown> | null;
        assert(byoa, "byoa block populated for BYOA ship");
        assertEquals(
          byoa!.owner_character_id_prefix,
          p1Id.replace(/-/g, "").slice(0, 12),
        );
        assertEquals("mode" in byoa!, false);

        // Personal ship has no BYOA, no active task — both blocks null.
        const personalShip = ships.find((s) => s.ship_id === p1ShipId);
        assert(personalShip, "personal ship present");
        assertEquals(personalShip.byoa, null);
        assertEquals(personalShip.current_task_actor, null);

        // Regression: no full UUIDs of p1Id appear under any block alongside
        // a truncated prefix (full UUIDs stay server-side).
        const serialised = JSON.stringify(ships);
        // Pattern: 8-4-4-4-12 hex UUID.
        const fullUuidPattern = new RegExp(p1Id, "i");
        const truncatedPattern = new RegExp(
          p1Id.replace(/-/g, "").slice(0, 12),
          "i",
        );
        assert(truncatedPattern.test(serialised), "truncated prefix present");
        assert(
          !fullUuidPattern.test(serialised),
          "full character UUID should NOT appear in payload",
        );
      },
    );
  },
});
