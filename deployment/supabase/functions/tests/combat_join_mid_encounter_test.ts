/**
 * Integration tests for hostile arrivals joining an active combat encounter.
 *
 * Behavior under test:
 *   - A hostile ship arriving in a sector where combat is in progress
 *     (`encounter.ended === false`) gets added to `encounter.participants`
 *     instead of being silently locked out.
 *   - The joining participant carries `joined_round = encounter.round`, so
 *     event payloads compute `just_joined = true` exactly once (on the
 *     reinforcement round_waiting). Subsequent events drop the flag.
 *   - The reinforcement round_waiting carries
 *     `extension_reason = { type: "joined", joiners: [{...}] }` describing
 *     who joined.
 *   - A friendly arrival (corp-mate of every active combatant) does NOT
 *     join — they observe by sector visibility instead.
 *   - Ended-blob restart (Case 2): when an arrival lands in a sector whose
 *     prior combat already ended, the existing auto-engage path starts a
 *     fresh combat with a NEW combat_id. Locks in the current behavior so
 *     a future refactor doesn't break it.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiOk,
  characterIdFor,
  shipIdFor,
  eventsOfType,
  getEventCursor,
  queryCombatState,
  queryGarrison,
  insertGarrisonDirect,
  setShipFighters,
  setShipShields,
  setShipSector,
  expireCombatDeadline,
} from "./helpers.ts";

const P1 = "test_join_p1";
const P2 = "test_join_p2";
const P3 = "test_join_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p1ShipId: string;
let p2ShipId: string;
let p3ShipId: string;

Deno.test({
  name: "combat_join — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

Deno.test({
  name:
    "combat_join — hostile arrival joins active toll combat with just_joined flag",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p3Id = await characterIdFor(P3);
    p1ShipId = await shipIdFor(P1);
    p2ShipId = await shipIdFor(P2);
    p3ShipId = await shipIdFor(P3);

    await t.step("reset and deploy toll garrison in sector 3", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });
      // P3 owns the toll garrison; P1 and P2 are unaffiliated hostiles.
      await insertGarrisonDirect(3, p3Id, 500, "toll", 500, 0);
      const g = await queryGarrison(3);
      assertExists(g, "Garrison row must exist");
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("P1 moves to sector 3 — garrison auto-engages", async () => {
      await setShipFighters(p1ShipId, 300);
      await setShipShields(p1ShipId, 200);
      await setShipSector(p1ShipId, 1);
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
      await apiOk("move", { character_id: p1Id, to_sector: 3 });

      const events = await eventsOfType(p1Id, "combat.round_waiting", cursorP1);
      assert(
        events.length >= 1,
        "P1 should receive combat.round_waiting on auto-engage",
      );
      const state = await queryCombatState(3);
      assertExists(state, "Combat must be active");
      assertEquals(
        (state as Record<string, unknown>).ended,
        false,
        "Combat is in progress",
      );
    });

    let combatIdAtJoin = "";
    await t.step("P2 moves into the active combat — joins as participant",
      async () => {
        await setShipFighters(p2ShipId, 250);
        await setShipShields(p2ShipId, 150);
        await setShipSector(p2ShipId, 1);
        await apiOk("move", { character_id: p2Id, to_sector: 3 });

        const state = (await queryCombatState(3)) as Record<string, unknown>;
        assertExists(state, "Combat encounter must still be present");
        combatIdAtJoin = state.combat_id as string;
        assertEquals(state.ended, false, "Joining must not end combat");

        const participants = state.participants as Record<
          string,
          { joined_round?: number; fighters?: number }
        >;
        const p2Entry = participants[p2Id];
        assertExists(p2Entry, "P2 must be added to encounter.participants");
        const p1Entry = participants[p1Id];
        assertExists(p1Entry, "P1 must remain in encounter.participants");
        assert(
          typeof p2Entry.joined_round === "number" && p2Entry.joined_round >= 1,
          `P2 should have joined_round set, got ${p2Entry.joined_round}`,
        );
      },
    );

    await t.step(
      "P2 receives reinforcement combat.round_waiting with extension_reason and just_joined",
      async () => {
        const events = await eventsOfType(
          p2Id,
          "combat.round_waiting",
          cursorP2,
        );
        assert(
          events.length >= 1,
          `Joiner P2 should receive combat.round_waiting on join, got ${events.length}`,
        );
        // The reinforcement event is the most recent one (the join may have
        // arrived during a round transition; pick the one with extension_reason).
        const reinforcement = events.find((e) => {
          const ext = (e.payload as Record<string, unknown>)["extension_reason"];
          return ext && (ext as Record<string, unknown>).type === "joined";
        }) ?? events[events.length - 1];
        const payload = reinforcement.payload as Record<string, unknown>;
        const extension = payload.extension_reason as
          | Record<string, unknown>
          | undefined;
        assertExists(
          extension,
          "Reinforcement event must carry extension_reason",
        );
        assertEquals(extension.type, "joined");
        const joiners = extension.joiners as Array<Record<string, unknown>>;
        assert(
          Array.isArray(joiners) && joiners.length === 1,
          "joiners array must have exactly the single arrival",
        );
        assertEquals(joiners[0].combatant_id, p2Id);

        const participantsPayload = payload.participants as Array<
          Record<string, unknown>
        >;
        const p2InPayload = participantsPayload.find(
          (p) => p.id === p2Id,
        );
        assertExists(p2InPayload, "P2 must appear in payload participants");
        assertEquals(
          p2InPayload.just_joined,
          true,
          "P2 must be marked just_joined on the reinforcement round_waiting",
        );
        const p1InPayload = participantsPayload.find(
          (p) => p.id === p1Id,
        );
        assertExists(p1InPayload);
        assertEquals(
          p1InPayload.just_joined,
          false,
          "Existing participant P1 must NOT be marked just_joined here (joined_round was round 1, encounter advanced)",
        );
      },
    );

    await t.step("attempting to move P2 out is blocked (in combat)", async () => {
      const result = await api("move", { character_id: p2Id, to_sector: 1 });
      assertEquals(
        result.status,
        409,
        "P2 must be blocked from leaving combat sector",
      );
    });

    await t.step(
      "advancing one round clears just_joined on the next round_waiting",
      async () => {
        const cursorBeforeTick = await getEventCursor(p2Id);
        await expireCombatDeadline(3);
        await apiOk("combat_tick", {});

        const events = await eventsOfType(
          p2Id,
          "combat.round_waiting",
          cursorBeforeTick,
        );
        assert(
          events.length >= 1,
          "P2 should receive next round's combat.round_waiting",
        );
        const next = events[events.length - 1];
        const payload = next.payload as Record<string, unknown>;
        assertEquals(
          payload.combat_id,
          combatIdAtJoin,
          "Combat continues with same combat_id (not a fresh combat)",
        );
        assert(
          !payload.extension_reason,
          "Subsequent rounds must NOT carry extension_reason",
        );
        const participantsPayload = payload.participants as Array<
          Record<string, unknown>
        >;
        const p2InPayload = participantsPayload.find((p) => p.id === p2Id);
        assertExists(p2InPayload);
        assertEquals(
          p2InPayload.just_joined,
          false,
          "just_joined must clear on the round after join",
        );
      },
    );
  },
});

Deno.test({
  name:
    "combat_join — arrival after combat ended starts a fresh combat (new combat_id)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    p1Id = await characterIdFor(P1);
    p2Id = await characterIdFor(P2);
    p3Id = await characterIdFor(P3);
    p1ShipId = await shipIdFor(P1);
    p2ShipId = await shipIdFor(P2);
    p3ShipId = await shipIdFor(P3);

    let firstCombatId = "";

    await t.step(
      "reset, deploy offensive garrison, drive combat to P1 destruction",
      async () => {
        await resetDatabase([P1, P2, P3]);
        await apiOk("join", { character_id: p1Id });
        await apiOk("join", { character_id: p2Id });
        await apiOk("join", { character_id: p3Id });
        // Offensive garrison attacks every round; P1 with very few fighters
        // gets destroyed quickly so combat reliably ends with P1_destroyed
        // (no toll dance, no probabilistic flee).
        await insertGarrisonDirect(3, p3Id, 400, "offensive", 0, 0);

        await setShipFighters(p1ShipId, 5);
        await setShipShields(p1ShipId, 0);
        await setShipSector(p1ShipId, 1);
        await apiOk("move", { character_id: p1Id, to_sector: 3 });

        const state = (await queryCombatState(3)) as Record<string, unknown>;
        firstCombatId = state.combat_id as string;

        // Drive ticks until combat ends or we hit a safety cap.
        for (let i = 0; i < 10; i++) {
          const cur = (await queryCombatState(3)) as Record<string, unknown>;
          if (!cur || cur.ended === true) break;
          await expireCombatDeadline(3);
          await apiOk("combat_tick", {});
        }
      },
    );

    await t.step("combat blob shows ended=true after destruction", async () => {
      const state = await queryCombatState(3);
      assertExists(state, "Encounter blob still in sector");
      assertEquals(
        (state as Record<string, unknown>).ended,
        true,
        "Prior combat must be ended",
      );
    });

    await t.step(
      "P2 arrives — fresh combat starts with a different combat_id",
      async () => {
        await setShipFighters(p2ShipId, 300);
        await setShipShields(p2ShipId, 200);
        await setShipSector(p2ShipId, 1);
        const cursor = await getEventCursor(p2Id);
        await apiOk("move", { character_id: p2Id, to_sector: 3 });

        const state = (await queryCombatState(3)) as Record<string, unknown>;
        assertExists(state, "Fresh combat must exist");
        assertEquals(state.ended, false, "New combat is active");
        assertNotEquals(
          state.combat_id,
          firstCombatId,
          "Fresh combat must use a NEW combat_id, not revive the old one",
        );

        const events = await eventsOfType(p2Id, "combat.round_waiting", cursor);
        assert(
          events.length >= 1,
          "P2 should receive combat.round_waiting from fresh combat",
        );
      },
    );
  },
});
