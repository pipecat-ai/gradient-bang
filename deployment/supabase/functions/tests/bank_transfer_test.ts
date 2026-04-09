/**
 * Integration tests for bank_transfer (deposit / withdraw).
 *
 * Tests cover:
 *   - Deposit happy path (ship credits → bank)
 *   - Deposit via character_id (auto-derives ship)
 *   - Deposit fails: insufficient credits, not at mega-port, wrong corp, target is corp ship
 *   - Withdraw happy path (bank → ship credits)
 *   - Withdraw fails: corp ship, in combat, insufficient balance, not at mega-port
 *   - Invalid direction
 *
 * Setup: P1, P2, P3 all in sector 0 (mega-port). P1 + P2 in same corp.
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { resetDatabase, startServerInProcess } from "./harness.ts";
import {
  api,
  apiOk,
  characterIdFor,
  shipIdFor,
  eventsOfType,
  getEventCursor,
  queryCharacter,
  queryShip,
  setShipCredits,
  setShipSector,
  setShipFighters,
  setMegabankBalance,
  createCorpShip,
} from "./helpers.ts";

const P1 = "test_bank_p1";
const P2 = "test_bank_p2";
const P3 = "test_bank_p3";

let p1Id: string;
let p2Id: string;
let p3Id: string;
let p1ShipId: string;
let p2ShipId: string;
let p3ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "bank_transfer — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Deposit happy path
// ============================================================================

Deno.test({
  name: "bank_transfer — deposit happy path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("resolve IDs", async () => {
      p1Id = await characterIdFor(P1);
      p2Id = await characterIdFor(P2);
      p3Id = await characterIdFor(P3);
      p1ShipId = await shipIdFor(P1);
      p2ShipId = await shipIdFor(P2);
      p3ShipId = await shipIdFor(P3);
    });

    await t.step("reset and setup corp", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });

      // P1 creates corp, P2 joins
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Bank Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("give P1 ship 5000 credits", async () => {
      await setShipCredits(p1ShipId, 5000);
    });

    let cursorP1: number;
    let cursorP2: number;

    await t.step("capture cursors", async () => {
      cursorP1 = await getEventCursor(p1Id);
      cursorP2 = await getEventCursor(p2Id);
    });

    await t.step("deposit 1000 from P1's ship to P2's bank", async () => {
      const result = await apiOk("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: P2,
        amount: 1000,
      });
      assertExists(
        (result as Record<string, unknown>).ship_credits_after,
        "Should return ship_credits_after",
      );
      assertEquals(
        (result as Record<string, unknown>).ship_credits_after,
        4000,
        "Ship should have 4000 credits left",
      );
      assertEquals(
        (result as Record<string, unknown>).credits_in_bank_after,
        1000,
        "Bank should have 1000 credits",
      );
    });

    await t.step("DB: P1 ship credits deducted", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.credits, 4000);
    });

    await t.step("DB: P2 bank balance increased", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 1000);
    });

    await t.step("bank.transaction event emitted to depositor", async () => {
      // For personal ships depositing to same-corp member, event goes to target
      const events = await eventsOfType(p2Id, "bank.transaction", cursorP2);
      assert(events.length >= 1, `Expected bank.transaction for P2, got ${events.length}`);
      assertEquals(events[0].payload.direction, "deposit");
      assertEquals(events[0].payload.amount, 1000);
    });
  },
});

// ============================================================================
// Group 1b: Corp ship deposit happy path
// ============================================================================

Deno.test({
  name: "bank_transfer — corp ship deposit happy path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and setup corp with corp ship", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });

      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Corp Deposit Test",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });

      const ship = await createCorpShip(corpId, 0, "Deposit Probe");
      corpShipId = ship.shipId;
      await setShipCredits(corpShipId, 3000);
    });

    await t.step("corp ship deposits 1000 to P1's bank via ship_id", async () => {
      await setMegabankBalance(p1Id, 0);
      const result = await apiOk("bank_transfer", {
        direction: "deposit",
        ship_id: corpShipId,
        actor_character_id: p1Id,
        target_player_name: P1,
        amount: 1000,
      });
      assertEquals(
        (result as Record<string, unknown>).ship_credits_after,
        2000,
        "Corp ship should have 2000 credits left",
      );
      assertEquals(
        (result as Record<string, unknown>).credits_in_bank_after,
        1000,
        "P1 bank should have 1000 credits",
      );
    });

    await t.step("DB: corp ship credits deducted", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship);
      assertEquals(ship.credits, 2000);
    });

    await t.step("DB: P1 bank balance increased", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 1000);
    });

    await t.step("corp ship deposits 500 to P2's bank (different member)", async () => {
      await setMegabankBalance(p2Id, 0);
      const result = await apiOk("bank_transfer", {
        direction: "deposit",
        ship_id: corpShipId,
        actor_character_id: p1Id,
        target_player_name: P2,
        amount: 500,
      });
      assertEquals(
        (result as Record<string, unknown>).ship_credits_after,
        1500,
        "Corp ship should have 1500 credits left",
      );
      assertEquals(
        (result as Record<string, unknown>).credits_in_bank_after,
        500,
        "P2 bank should have 500 credits",
      );
    });

    await t.step("DB: P2 bank balance increased", async () => {
      const char = await queryCharacter(p2Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 500);
    });
  },
});

// ============================================================================
// Group 1c: Self-deposit (no corp membership required)
// ============================================================================

Deno.test({
  name: "bank_transfer — self-deposit without corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset — P3 has no corp", async () => {
      await resetDatabase([P3]);
      await apiOk("join", { character_id: p3Id });
      await setShipCredits(p3ShipId, 5000);
      await setMegabankBalance(p3Id, 0);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p3Id);
    });

    await t.step("P3 deposits 2000 to own bank", async () => {
      const result = await apiOk("bank_transfer", {
        character_id: p3Id,
        direction: "deposit",
        target_player_name: P3,
        amount: 2000,
      });
      assertEquals(
        (result as Record<string, unknown>).ship_credits_after,
        3000,
        "Ship should have 3000 credits left",
      );
      assertEquals(
        (result as Record<string, unknown>).credits_in_bank_after,
        2000,
        "Bank should have 2000 credits",
      );
    });

    await t.step("DB: P3 ship credits deducted", async () => {
      const ship = await queryShip(p3ShipId);
      assertExists(ship);
      assertEquals(ship.credits, 3000);
    });

    await t.step("DB: P3 bank balance increased", async () => {
      const char = await queryCharacter(p3Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 2000);
    });

    await t.step("bank.transaction event emitted", async () => {
      const events = await eventsOfType(p3Id, "bank.transaction", cursor);
      assert(events.length >= 1, `Expected bank.transaction for P3, got ${events.length}`);
      assertEquals(events[0].payload.direction, "deposit");
      assertEquals(events[0].payload.amount, 2000);
    });
  },
});

// ============================================================================
// Group 1d: Self-deposit (with corp membership)
// ============================================================================

Deno.test({
  name: "bank_transfer — self-deposit with corp",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup corp for P1", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });

      await setShipCredits(p1ShipId, 50000);
      await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Self Deposit Corp",
      });
      await setShipCredits(p1ShipId, 5000);
      await setMegabankBalance(p1Id, 0);
    });

    await t.step("P1 deposits 1500 to own bank", async () => {
      const result = await apiOk("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: P1,
        amount: 1500,
      });
      assertEquals(
        (result as Record<string, unknown>).ship_credits_after,
        3500,
        "Ship should have 3500 credits left",
      );
      assertEquals(
        (result as Record<string, unknown>).credits_in_bank_after,
        1500,
        "Bank should have 1500 credits",
      );
    });

    await t.step("DB: P1 bank balance increased", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 1500);
    });
  },
});

// ============================================================================
// Group 2: Deposit failure cases
// ============================================================================

Deno.test({
  name: "bank_transfer — deposit failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step("reset and setup corp (P1+P2)", async () => {
      await resetDatabase([P1, P2, P3]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await apiOk("join", { character_id: p3Id });

      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Deposit Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      inviteCode = (createResult as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
      await setShipCredits(p1ShipId, 5000);
    });

    await t.step("fails: insufficient ship credits", async () => {
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: P2,
        amount: 999999,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Insufficient"),
        `Expected insufficient error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: not at mega-port", async () => {
      // Move P1 to sector 3 (not a mega-port)
      await setShipSector(p1ShipId, 3);
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: P2,
        amount: 100,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("mega-port"),
        `Expected mega-port error, got: ${result.body.error}`,
      );
      // Move back
      await setShipSector(p1ShipId, 0);
    });

    await t.step("fails: different corporation (P3 not in corp)", async () => {
      await setShipCredits(p3ShipId, 5000);
      const result = await api("bank_transfer", {
        character_id: p3Id,
        direction: "deposit",
        target_player_name: P2,
        amount: 100,
      });
      assertEquals(result.status, 403);
      assert(
        result.body.error?.includes("corporation"),
        `Expected corporation error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: target player not found", async () => {
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: "nonexistent_player_xyz",
        amount: 100,
      });
      assertEquals(result.status, 404);
    });

    await t.step("fails: target is corp ship pseudo-character", async () => {
      const ship = await createCorpShip(corpId, 0, "Bank Test Ship");
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: `corp-ship-Bank Test Ship`,
        amount: 100,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Corporation ships"),
        `Expected corp ship error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: invalid direction", async () => {
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "invalid",
        target_player_name: P2,
        amount: 100,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("direction"),
        `Expected direction error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: negative amount", async () => {
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "deposit",
        target_player_name: P2,
        amount: -100,
      });
      assertEquals(result.status, 400);
    });
  },
});

// ============================================================================
// Group 3: Withdraw happy path
// ============================================================================

Deno.test({
  name: "bank_transfer — withdraw happy path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });

      // P1 creates corp (needed for deposit to set up bank balance)
      await setShipCredits(p1ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Withdraw Corp",
      });
      const corpId = (createResult as Record<string, unknown>).corp_id as string;
      const inviteCode = (createResult as Record<string, unknown>)
        .invite_code as string;
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });

      // Give P1 some bank balance directly
      await setMegabankBalance(p1Id, 5000);
      await setShipCredits(p1ShipId, 1000);
    });

    let cursor: number;

    await t.step("capture cursor", async () => {
      cursor = await getEventCursor(p1Id);
    });

    await t.step("withdraw 2000 from P1's bank to ship", async () => {
      const result = await apiOk("bank_transfer", {
        character_id: p1Id,
        direction: "withdraw",
        amount: 2000,
      });
      assertExists(result, "Withdraw should succeed");
    });

    await t.step("DB: P1 bank balance decreased", async () => {
      const char = await queryCharacter(p1Id);
      assertExists(char);
      assertEquals(char.credits_in_megabank, 3000, "Bank should have 3000 left");
    });

    await t.step("DB: P1 ship credits increased", async () => {
      const ship = await queryShip(p1ShipId);
      assertExists(ship);
      assertEquals(ship.credits, 3000, "Ship should have 1000 + 2000 = 3000");
    });

    await t.step("bank.transaction event emitted for withdraw", async () => {
      const events = await eventsOfType(p1Id, "bank.transaction", cursor);
      assert(events.length >= 1, `Expected bank.transaction event, got ${events.length}`);
      assertEquals(events[0].payload.direction, "withdraw");
      assertEquals(events[0].payload.amount, 2000);
    });
  },
});

// ============================================================================
// Group 4: Withdraw failure cases
// ============================================================================

Deno.test({
  name: "bank_transfer — withdraw failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and setup", async () => {
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setMegabankBalance(p1Id, 5000);
      await setShipCredits(p1ShipId, 1000);

      // Create corp for corp ship test
      await setShipCredits(p2ShipId, 50000);
      const createResult = await apiOk("corporation_create", {
        character_id: p2Id,
        name: "Withdraw Fail Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
    });

    await t.step("fails: insufficient bank balance", async () => {
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "withdraw",
        amount: 999999,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("Insufficient"),
        `Expected insufficient error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: not at mega-port", async () => {
      await setShipSector(p1ShipId, 3);
      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "withdraw",
        amount: 100,
      });
      assertEquals(result.status, 400);
      assert(
        result.body.error?.includes("mega-port"),
        `Expected mega-port error, got: ${result.body.error}`,
      );
      await setShipSector(p1ShipId, 0);
    });

    await t.step("fails: corp ship cannot withdraw", async () => {
      const ship = await createCorpShip(corpId, 0, "No Withdraw Ship");
      await setMegabankBalance(ship.pseudoCharacterId, 5000);
      const result = await api("bank_transfer", {
        character_id: ship.pseudoCharacterId,
        direction: "withdraw",
        amount: 100,
      });
      assertEquals(result.status, 403);
      assert(
        result.body.error?.includes("Corporation ships"),
        `Expected corp ship error, got: ${result.body.error}`,
      );
    });

    await t.step("fails: in combat", async () => {
      // Put P1 and P2 in same sector for combat
      await setShipSector(p1ShipId, 0);
      await setShipSector(p2ShipId, 0);
      await setShipFighters(p1ShipId, 100);
      await setShipFighters(p2ShipId, 100);
      await apiOk("combat_initiate", { character_id: p1Id });

      const result = await api("bank_transfer", {
        character_id: p1Id,
        direction: "withdraw",
        amount: 100,
      });
      assertEquals(result.status, 409);
      assert(
        result.body.error?.includes("combat"),
        `Expected combat error, got: ${result.body.error}`,
      );
    });
  },
});
