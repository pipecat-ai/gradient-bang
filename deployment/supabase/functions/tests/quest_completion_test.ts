/**
 * Integration tests for quest completion — step-by-step progression.
 *
 * Tests cover:
 *   Tutorial 1 ("Taking Flight") — all 7 steps
 *   Tutorial 2 ("Corporations & Fleet Command") — both steps
 *   Catch-up mechanism — backwards-seeking query for timing edge cases
 *   Negative tests — wrong event types, payload filter mismatches
 *
 * Setup: P1, P2 in sector 0 (mega-port).
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  advanceQuestToStep,
  api,
  apiOk,
  assertNoEventsOfType,
  characterIdFor,
  createCorpShip,
  ensureSectorHasPort,
  eventsOfType,
  getEventCursor,
  queryPlayerQuest,
  queryPlayerQuestStep,
  queryShip,
  seedQuestDefinitions,
  setShipCargo,
  setShipCredits,
  setShipFighters,
  setShipSector,
  setShipType,
  setShipWarpPower,
  shipIdFor,
  withPg,
} from "./helpers.ts";

const P1 = "test_qc_p1";
const P2 = "test_qc_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

/**
 * Reset database AND re-seed quest definitions.
 * Needed because harness TRUNCATE wipes all quest tables.
 */
async function resetWithQuests(characterIds: string[]): Promise<void> {
  await resetDatabase(characterIds);
  await seedQuestDefinitions();
}

async function seedPortBuyTransaction(params: {
  characterId: string;
  shipId: string;
  sectorId: number;
  commodity: "QF" | "RO" | "NS";
  quantity: number;
  pricePerUnit: number;
}): Promise<void> {
  await withPg(async (pg) => {
    const port = await pg.queryObject<{ port_id: number }>(
      `SELECT port_id FROM ports WHERE sector_id = $1`,
      [params.sectorId],
    );
    const portRow = port.rows[0];
    assertExists(portRow, `Expected sector ${params.sectorId} to have a port`);
    await pg.queryObject(
      `INSERT INTO port_transactions (
        sector_id, port_id, character_id, ship_id,
        commodity, quantity, transaction_type,
        price_per_unit, total_price
      ) VALUES ($1, $2, $3, $4, $5, $6, 'buy', $7, $8)`,
      [
        params.sectorId,
        portRow.port_id,
        params.characterId,
        params.shipId,
        params.commodity,
        params.quantity,
        params.pricePerUnit,
        params.quantity * params.pricePerUnit,
      ],
    );
  });
}

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "quest_completion — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Verify seeding works (resetWithQuests re-seeds each time)
// ============================================================================

Deno.test({
  name: "quest_completion — verify quest seeding after reset",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("resolve IDs", async () => {
      p1Id = await characterIdFor(P1);
      p2Id = await characterIdFor(P2);
      p1ShipId = await shipIdFor(P1);
      p2ShipId = await shipIdFor(P2);
    });

    await t.step("reset + seed", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("quest definitions exist", async () => {
      await withPg(async (pg) => {
        const quests = await pg.queryObject<{ code: string }>(
          `SELECT code FROM quest_definitions WHERE code IN ('tutorial', 'tutorial_corporations') ORDER BY code`,
        );
        assertEquals(quests.rows.length, 2);
        assertEquals(quests.rows[0].code, "tutorial");
        assertEquals(quests.rows[1].code, "tutorial_corporations");
      });
    });

    await t.step("step definitions exist (9 total)", async () => {
      await withPg(async (pg) => {
        const steps = await pg.queryObject<{ count: bigint }>(
          `SELECT COUNT(*) as count FROM quest_step_definitions qsd
           JOIN quest_definitions qd ON qd.id = qsd.quest_id
           WHERE qd.code IN ('tutorial', 'tutorial_corporations')`,
        );
        assertEquals(Number(steps.rows[0].count), 9);
      });
    });

    await t.step("event subscriptions exist", async () => {
      await withPg(async (pg) => {
        const subs = await pg.queryObject<{ count: bigint }>(
          `SELECT COUNT(*) as count FROM quest_event_subscriptions`,
        );
        assert(
          Number(subs.rows[0].count) >= 9,
          `Expected >= 9 subscriptions, got ${subs.rows[0].count}`,
        );
      });
    });

    await t.step("quest_assign works after seeding", async () => {
      const result = await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial",
      });
      assert(result.success);
    });
  },
});

// ============================================================================
// Group 2: Tutorial 1 — Step 1: Travel to adjacent sector
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial step 1: travel to adjacent sector",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("assign tutorial quest", async () => {
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial",
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("move to sector 1", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("receives quest.step_completed event", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      assert(
        events.length >= 1,
        `Expected quest.step_completed, got ${events.length}`,
      );
      const payload = events[0].payload;
      assertEquals(payload.quest_code, "tutorial");
      assertEquals(payload.step_index, 1);
      // Should include next step info
      assertExists(
        (payload as Record<string, unknown>).next_step,
        "Should have next_step",
      );
    });

    await t.step("DB: step 1 completed, quest at step 2", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.status, "active");
      assertEquals(pq.current_step_index, 2);

      const step = await queryPlayerQuestStep(p1Id, "tutorial", 1);
      assertExists(step);
      assertEquals(Number(step.current_value), 1);
      assertExists(step.completed_at, "Step 1 should be completed");
    });
  },
});

// ============================================================================
// Group 3: Tutorial 1 — Step 2: Locate the Megaport
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial step 2: locate the megaport",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      // Sector 0 has no port row in test fixtures — insert one so
      // movement.complete includes has_megaport: true
      await ensureSectorHasPort(0);
      // Advance quest directly to step 2
      await advanceQuestToStep(p1Id, "tutorial", 2);
    });

    let cursor: number;

    await t.step("move to sector 1 (no megaport) — no completion", async () => {
      cursor = await getEventCursor(p1Id);
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
      await assertNoEventsOfType(p1Id, "quest.step_completed", cursor);
    });

    await t.step(
      "move back to sector 0 (megaport) — step completes",
      async () => {
        cursor = await getEventCursor(p1Id);
        await apiOk("move", { character_id: p1Id, to_sector: 0 });

        const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
        assert(
          events.length >= 1,
          `Expected quest.step_completed, got ${events.length}`,
        );
        assertEquals(events[0].payload.step_index, 2);
      },
    );

    await t.step("DB: step 2 completed, quest at step 3", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.current_step_index, 3);
    });
  },
});

// ============================================================================
// Group 4: Tutorial 1 — Step 3: Refuel your ship
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial step 3: refuel your ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await advanceQuestToStep(p1Id, "tutorial", 3);
      // Deplete warp so we can recharge
      await setShipWarpPower(p1ShipId, 200);
      await setShipCredits(p1ShipId, 50000);
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("buy warp fuel at megaport", async () => {
      await apiOk("recharge_warp_power", {
        character_id: p1Id,
        units: 50,
      });
    });

    await t.step("receives quest.step_completed", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      assert(
        events.length >= 1,
        `Expected quest.step_completed, got ${events.length}`,
      );
      assertEquals(events[0].payload.step_index, 3);
    });

    await t.step("DB: step 3 completed", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.current_step_index, 4);
    });
  },
});

// ============================================================================
// Group 5: Tutorial 1 — Step 4: Purchase a commodity
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial step 4: purchase a commodity",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await advanceQuestToStep(p1Id, "tutorial", 4);
      // Move to sector 1 (has BBS port that sells neuro_symbolics)
      await setShipSector(p1ShipId, 1);
      await setShipCredits(p1ShipId, 50000);
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("buy neuro_symbolics from sector 1 port", async () => {
      await apiOk("trade", {
        character_id: p1Id,
        commodity: "neuro_symbolics",
        trade_type: "buy",
        quantity: 5,
      });
    });

    await t.step("receives quest.step_completed", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      assert(
        events.length >= 1,
        `Expected quest.step_completed, got ${events.length}`,
      );
      assertEquals(events[0].payload.step_index, 4);
    });

    await t.step("DB: step 4 completed", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.current_step_index, 5);
    });
  },
});

// ============================================================================
// Group 6: Tutorial 1 — Step 5: Earn 1000 credits trading (aggregate)
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial step 5: earn 1000 credits trading",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await advanceQuestToStep(p1Id, "tutorial", 5);
      // Place at sector 1 (BBS port buys quantum_foam)
      await setShipSector(p1ShipId, 1);
      // Load cargo for selling
      await setShipCargo(p1ShipId, { qf: 200, ro: 0, ns: 0 });
      await seedPortBuyTransaction({
        characterId: p1Id,
        shipId: p1ShipId,
        sectorId: 2,
        commodity: "QF",
        quantity: 200,
        pricePerUnit: 1,
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    // Sell quantum_foam at sector 1 port. Profit is revenue minus FIFO cost.
    // Sell in batches to test aggregate accumulation.
    let totalProfit = 0;
    const costPerUnit = 1;

    await t.step("sell quantum_foam — first batch", async () => {
      const result = await apiOk("trade", {
        character_id: p1Id,
        commodity: "quantum_foam",
        trade_type: "sell",
        quantity: 50,
      });
      // Extract profit from trade event
      const events = await eventsOfType(p1Id, "trade.executed", cursor);
      assert(events.length >= 1);
      const trade = events[0].payload.trade as Record<string, unknown>;
      const totalPrice = Number(trade.total_price ?? 0);
      const profit = Number(events[0].payload.profit ?? 0);
      assertEquals(profit, totalPrice - 50 * costPerUnit);
      totalProfit += profit;
    });

    await t.step("check progress or sell more if needed", async () => {
      if (totalProfit < 1000) {
        // Sell more to exceed 1000
        cursor = await getEventCursor(p1Id);
        await apiOk("trade", {
          character_id: p1Id,
          commodity: "quantum_foam",
          trade_type: "sell",
          quantity: 100,
        });
        const events = await eventsOfType(p1Id, "trade.executed", cursor);
        assert(events.length >= 1);
        const trade = events[0].payload.trade as Record<string, unknown>;
        const totalPrice = Number(trade.total_price ?? 0);
        const profit = Number(events[0].payload.profit ?? 0);
        assertEquals(profit, totalPrice - 100 * costPerUnit);
        totalProfit += profit;
      }
    });

    await t.step("receives quest.step_completed", async () => {
      // Fetch all step_completed events since the very start
      const events = await eventsOfType(p1Id, "quest.step_completed", 0);
      const stepFive = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial" && e.payload.step_index === 5,
      );
      assert(
        stepFive.length >= 1,
        `Expected step 5 completion event, got ${stepFive.length}`,
      );
    });

    await t.step("DB: step 5 completed, aggregate >= 1000", async () => {
      const step = await queryPlayerQuestStep(p1Id, "tutorial", 5);
      assertExists(step);
      assert(
        Number(step.current_value) >= 1000,
        `Expected >= 1000, got ${step.current_value}`,
      );
      assertEquals(Number(step.current_value), totalProfit);
      assertExists(step.completed_at);

      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.current_step_index, 6);
    });
  },
});

// ============================================================================
// Group 7: Tutorial 1 — Step 6: Purchase a kestrel
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial step 6: purchase a kestrel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await advanceQuestToStep(p1Id, "tutorial", 6);
      // Change ship to sparrow_scout so trade-in triggers ship.traded_in
      // with new_ship_type = kestrel_courier
      await setShipType(p1ShipId, "sparrow_scout");
      await setShipCredits(p1ShipId, 100000);
      await setShipFighters(p1ShipId, 0);
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("buy kestrel_courier at megaport", async () => {
      const result = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "kestrel_courier",
      });
      assertExists(result);
    });

    await t.step("receives quest.step_completed", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      assert(
        events.length >= 1,
        `Expected quest.step_completed, got ${events.length}`,
      );
      assertEquals(events[0].payload.step_index, 6);
    });

    await t.step("ship.traded_in event has correct new_ship_type", async () => {
      const events = await eventsOfType(p1Id, "ship.traded_in", cursor);
      assert(events.length >= 1);
      assertEquals(events[0].payload.new_ship_type, "kestrel_courier");
    });

    await t.step("DB: step 6 completed", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.current_step_index, 7);
    });
  },
});

// ============================================================================
// Group 8: Tutorial 1 — Step 7: Accept tutorial_corporations + quest complete
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial step 7: accept contract + quest completes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await advanceQuestToStep(p1Id, "tutorial", 7);
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("assign tutorial_corporations quest", async () => {
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial_corporations",
      });
    });

    await t.step("receives quest.step_completed for step 7", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      const step7 = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial" && e.payload.step_index === 7,
      );
      assert(
        step7.length >= 1,
        `Expected step 7 completion, got ${step7.length}`,
      );
    });

    await t.step("receives quest.completed for tutorial", async () => {
      const events = await eventsOfType(p1Id, "quest.completed", cursor);
      const completed = events.filter((e) =>
        e.payload.quest_code === "tutorial"
      );
      assert(
        completed.length >= 1,
        `Expected quest.completed, got ${completed.length}`,
      );
    });

    await t.step("DB: tutorial quest completed", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.status, "completed");
      assertExists(pq.completed_at);
    });
  },
});

// ============================================================================
// Group 9: Tutorial 2 — Step 1: Create a corporation
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial_corporations step 1: create a corporation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("assign tutorial_corporations", async () => {
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial_corporations",
      });
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("create corporation", async () => {
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "QC Test Corp Create",
      });
    });

    await t.step("receives quest.step_completed", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      const step1 = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial_corporations" &&
          e.payload.step_index === 1,
      );
      assert(
        step1.length >= 1,
        `Expected step 1 completion, got ${step1.length}`,
      );
    });

    await t.step("DB: step 1 completed, quest at step 2", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial_corporations");
      assertExists(pq);
      assertEquals(pq.current_step_index, 2);
    });
  },
});

// ============================================================================
// Group 10: Tutorial 2 — Step 1 (alt): Join a corporation
// ============================================================================

Deno.test({
  name: "quest_completion — tutorial_corporations step 1: join a corporation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let inviteCode: string;
    let corpId: string;

    await t.step("reset and setup", async () => {
      await resetWithQuests([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("P1 creates corporation", async () => {
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "QC Test Corp Join",
      });
      const body = result as Record<string, unknown>;
      corpId = body.corp_id as string;
      inviteCode = body.invite_code as string;
      assertExists(corpId, "Should have corp_id");
      assertExists(inviteCode, "Should have invite code");
    });

    await t.step("assign tutorial_corporations to P2", async () => {
      await apiOk("quest_assign", {
        character_id: p2Id,
        quest_code: "tutorial_corporations",
      });
    });

    let cursorP2: number;
    await t.step("capture P2 cursor", async () => {
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("P2 joins corporation", async () => {
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("P2 receives quest.step_completed", async () => {
      const events = await eventsOfType(p2Id, "quest.step_completed", cursorP2);
      const step1 = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial_corporations" &&
          e.payload.step_index === 1,
      );
      assert(
        step1.length >= 1,
        `Expected step 1 completion for P2, got ${step1.length}`,
      );
    });

    await t.step("DB: P2 step 1 completed", async () => {
      const pq = await queryPlayerQuest(p2Id, "tutorial_corporations");
      assertExists(pq);
      assertEquals(pq.current_step_index, 2);
    });
  },
});

// ============================================================================
// Group 11: Tutorial 2 — Step 2: Run task on corp ship + quest complete
// ============================================================================

Deno.test({
  name:
    "quest_completion — tutorial_corporations step 2: run task on corp ship",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let pseudoCharId: string;

    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("create corporation", async () => {
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "QC Test Corp Task",
      });
      corpId = (result as Record<string, unknown>).corp_id as string;
      assertExists(corpId, "Should have corp_id");
    });

    await t.step("advance quest to step 2", async () => {
      await advanceQuestToStep(p1Id, "tutorial_corporations", 2);
    });

    await t.step("create corp ship", async () => {
      const { pseudoCharacterId } = await createCorpShip(
        corpId,
        0,
        "QC Corp Scout",
      );
      pseudoCharId = pseudoCharacterId;
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("start task on corp ship", async () => {
      const taskId = crypto.randomUUID();
      await apiOk("task_lifecycle", {
        character_id: pseudoCharId,
        actor_character_id: p1Id,
        task_id: taskId,
        event_type: "start",
        task_description: "Quest completion test task",
      });
    });

    await t.step("P1 receives quest.step_completed", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      const step2 = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial_corporations" &&
          e.payload.step_index === 2,
      );
      assert(
        step2.length >= 1,
        `Expected step 2 completion, got ${step2.length}`,
      );
    });

    await t.step(
      "P1 receives quest.completed for tutorial_corporations",
      async () => {
        const events = await eventsOfType(p1Id, "quest.completed", cursor);
        const completed = events.filter(
          (e) => e.payload.quest_code === "tutorial_corporations",
        );
        assert(
          completed.length >= 1,
          `Expected quest.completed, got ${completed.length}`,
        );
      },
    );

    await t.step("DB: tutorial_corporations completed", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial_corporations");
      assertExists(pq);
      assertEquals(pq.status, "completed");
      assertExists(pq.completed_at);
    });
  },
});

// ============================================================================
// Group 12: Edge case — Corp already exists when tutorial 2 is assigned
// (catch-up mechanism replays corporation.created event)
// ============================================================================

Deno.test({
  name: "quest_completion — catch-up: corp exists before tutorial 2 assignment",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step(
      "create corporation FIRST (before quest assignment)",
      async () => {
        await apiOk("corporation_create", {
          character_id: p1Id,
          name: "QC Catch-Up Corp",
        });
      },
    );

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step(
      "assign tutorial_corporations AFTER corp creation",
      async () => {
        await apiOk("quest_assign", {
          character_id: p1Id,
          quest_code: "tutorial_corporations",
        });
      },
    );

    await t.step("step 1 auto-completes via catch-up", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      const step1 = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial_corporations" &&
          e.payload.step_index === 1,
      );
      assert(
        step1.length >= 1,
        `Expected auto-completion of step 1, got ${step1.length}`,
      );
    });

    await t.step("DB: quest advanced to step 2", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial_corporations");
      assertExists(pq);
      assertEquals(pq.current_step_index, 2);
    });
  },
});

// ============================================================================
// Group 13: Edge case — tutorial_corporations accepted before tutorial step 7
// is current (catch-up replays quest.assigned event)
// ============================================================================

Deno.test({
  name:
    "quest_completion — catch-up: tutorial_corporations accepted before step 7 is current",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("assign tutorial (starts at step 1)", async () => {
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial",
      });
    });

    await t.step(
      "assign tutorial_corporations EARLY (while tutorial at step 1)",
      async () => {
        await apiOk("quest_assign", {
          character_id: p1Id,
          quest_code: "tutorial_corporations",
        });
      },
    );

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("advance tutorial to step 7 — catch-up fires", async () => {
      // This uses direct SQL to set current_step_index = 7 and insert
      // the step row. The catch-up trigger will replay past events,
      // finding the quest.assigned event for tutorial_corporations.
      await advanceQuestToStep(p1Id, "tutorial", 7);
    });

    await t.step("step 7 auto-completes via catch-up", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      const step7 = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial" && e.payload.step_index === 7,
      );
      assert(
        step7.length >= 1,
        `Expected auto-completion of step 7, got ${step7.length}`,
      );
    });

    await t.step("tutorial quest is fully completed", async () => {
      const events = await eventsOfType(p1Id, "quest.completed", cursor);
      const completed = events.filter((e) =>
        e.payload.quest_code === "tutorial"
      );
      assert(
        completed.length >= 1,
        `Expected quest.completed, got ${completed.length}`,
      );

      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.status, "completed");
    });
  },
});

// ============================================================================
// Group 14: Edge case — Both: corp exists + tutorial_corporations accepted early
// ============================================================================

Deno.test({
  name:
    "quest_completion — catch-up: corp exists AND tutorial_corporations accepted early",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);
    });

    await t.step("create corporation", async () => {
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "QC Double Edge Corp",
      });
    });

    await t.step("assign tutorial (starts at step 1)", async () => {
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial",
      });
    });

    await t.step("assign tutorial_corporations early", async () => {
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial_corporations",
      });
    });

    // tutorial_corporations step 1 should auto-complete (corp already created)
    await t.step("tutorial_corporations step 1 auto-completed", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial_corporations");
      assertExists(pq);
      assertEquals(
        pq.current_step_index,
        2,
        "tutorial_corporations should be at step 2 (corp catch-up)",
      );
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("advance tutorial to step 7", async () => {
      await advanceQuestToStep(p1Id, "tutorial", 7);
    });

    await t.step("tutorial step 7 auto-completes via catch-up", async () => {
      const events = await eventsOfType(p1Id, "quest.step_completed", cursor);
      const step7 = events.filter(
        (e) =>
          e.payload.quest_code === "tutorial" && e.payload.step_index === 7,
      );
      assert(
        step7.length >= 1,
        `Expected auto-completion of step 7, got ${step7.length}`,
      );
    });

    await t.step("tutorial quest is fully completed", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.status, "completed");
    });
  },
});

// ============================================================================
// Group 15: Negative — Wrong event type doesn't trigger progress
// ============================================================================

Deno.test({
  name: "quest_completion — negative: wrong event type has no effect",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial",
      });
      // Quest is at step 1 which expects movement.complete
      // Move to sector 1 so we're at a port for trading
      await setShipSector(p1ShipId, 1);
      await setShipCredits(p1ShipId, 50000);
    });

    let cursor: number;
    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("perform a trade (wrong event type for step 1)", async () => {
      await apiOk("trade", {
        character_id: p1Id,
        commodity: "neuro_symbolics",
        trade_type: "buy",
        quantity: 1,
      });
    });

    await t.step(
      "no quest.step_completed or quest.progress received",
      async () => {
        await assertNoEventsOfType(p1Id, "quest.step_completed", cursor);
        await assertNoEventsOfType(p1Id, "quest.progress", cursor);
      },
    );

    await t.step("DB: step 1 still at 0", async () => {
      const step = await queryPlayerQuestStep(p1Id, "tutorial", 1);
      assertExists(step);
      assertEquals(Number(step.current_value), 0);
    });
  },
});

// ============================================================================
// Group 16: Negative — Payload filter mismatch doesn't trigger
// ============================================================================

Deno.test({
  name: "quest_completion — negative: payload filter mismatch (no megaport)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
      // Ensure sector 0 has a port so the test is meaningful
      // (sector 1 won't have mega flag regardless)
      await ensureSectorHasPort(0);
      // Advance to step 2 (expects movement.complete with has_megaport: true)
      await advanceQuestToStep(p1Id, "tutorial", 2);
    });

    let cursor: number;

    await t.step("move to sector 1 first to leave sector 0", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 1 });
    });

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("move to sector 3 (no megaport)", async () => {
      await apiOk("move", { character_id: p1Id, to_sector: 3 });
    });

    await t.step(
      "no quest.step_completed received (filter doesn't match)",
      async () => {
        await assertNoEventsOfType(p1Id, "quest.step_completed", cursor);
      },
    );

    await t.step("DB: step 2 still at 0", async () => {
      const step = await queryPlayerQuestStep(p1Id, "tutorial", 2);
      assertExists(step);
      assertEquals(Number(step.current_value), 0);
    });
  },
});

// ============================================================================
// Group 17: Negative — Duplicate quest assignment rejected
// ============================================================================

Deno.test({
  name: "quest_completion — negative: duplicate quest assignment rejected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetWithQuests([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("assign tutorial quest", async () => {
      await apiOk("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial",
      });
    });

    await t.step("second assignment returns not-assigned", async () => {
      const result = await api("quest_assign", {
        character_id: p1Id,
        quest_code: "tutorial",
      });
      // Should not crash
      assert(result.status !== 500, "Should not crash on duplicate assignment");
      // The assign_quest function returns NULL for duplicates,
      // which the endpoint handles gracefully
      if (result.ok && result.body.success) {
        const body = result.body as Record<string, unknown>;
        assert(
          body.assigned === false || body.player_quest_id === null,
          "Should indicate quest was not re-assigned",
        );
      }
    });

    await t.step("DB: quest state unchanged (still at step 1)", async () => {
      const pq = await queryPlayerQuest(p1Id, "tutorial");
      assertExists(pq);
      assertEquals(pq.status, "active");
      assertEquals(pq.current_step_index, 1);
    });
  },
});
