/**
 * Integration tests for foreign key constraint edge cases.
 *
 * These tests reproduce FK constraint violations that occur when entities
 * (corporations, characters, ships) are deleted while the events table still
 * holds references to them.
 *
 * Known FK columns on `events` (all default to RESTRICT — no ON DELETE action):
 *   - character_id  → characters(character_id)
 *   - sender_id     → characters(character_id)
 *   - ship_id       → ship_instances(ship_id)
 *   - corp_id       → corporations(corp_id)
 *
 * Tests cover:
 *   1. Corp disband with corp ships that have events (pseudo-character FK)
 *   2. Corp disband after corp-scoped events exist (corp_id FK)
 *   3. Direct: deleting a ship that has event references (ship_id FK)
 *   4. Direct: deleting a character that has event references (character_id FK)
 *
 * Setup: 2 players in sector 0 (mega-port).
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
  setShipCredits,
  setMegabankBalance,
  createCorpShip,
  withPg,
  queryEvents,
  queryShip,
} from "./helpers.ts";

const P1 = "test_fk_p1";
const P2 = "test_fk_p2";

let p1Id: string;
let p2Id: string;
let p1ShipId: string;
let p2ShipId: string;

// ============================================================================
// Group 0: Start server
// ============================================================================

Deno.test({
  name: "fk_constraint — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

// ============================================================================
// Group 1: Corp disband with corp ship that has events
// ============================================================================
// When a corporation disbands (last member leaves), handleDisband() deletes
// the pseudo-character rows for corp ships. If those pseudo-characters have
// events referencing them (e.g., status.snapshot), the DELETE violates the
// FK constraint on events.character_id.

Deno.test({
  name: "fk_constraint — corp disband with corp ship events (character_id FK)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and create corp with ship", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "FK Test Corp Ships",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      // Create a corp ship (inserts pseudo-character with character_id = ship_id)
      const shipResult = await createCorpShip(corpId, 0, "FK Probe");
      corpShipId = shipResult.pseudoCharacterId;
    });

    await t.step("insert event referencing corp ship pseudo-character", async () => {
      // Directly insert an event with character_id = pseudo-character.
      // This simulates any event that references the corp ship's pseudo-character
      // (e.g., status.snapshot, move events, etc.).
      await withPg(async (pg) => {
        await pg.queryObject(
          `INSERT INTO events (
            direction, event_type, scope, character_id, payload,
            recipient_character_id, recipient_reason, inserted_at
          ) VALUES (
            'event_out', 'test.fk_probe', 'direct', $1, '{}'::jsonb,
            $2, 'direct', NOW()
          )`,
          [corpShipId, p1Id],
        );
      });

      // Verify the event exists and references the pseudo-character
      const events = await queryEvents(
        "character_id = $1",
        [corpShipId],
      );
      assert(
        events.length >= 1,
        `Expected events referencing corp ship pseudo-character, got ${events.length}`,
      );
    });

    await t.step("remove corp ship (so disband is allowed)", async () => {
      // Remove the corporation_ships link and mark ship unowned so the
      // disband guard passes. The event referencing the pseudo-character
      // remains — that's what this test is verifying.
      await withPg(async (pg) => {
        await pg.queryObject(
          `DELETE FROM corporation_ships WHERE ship_id = $1`,
          [corpShipId],
        );
        await pg.queryObject(
          `UPDATE ship_instances SET owner_type = 'unowned', owner_id = NULL,
           owner_character_id = NULL, owner_corporation_id = NULL
           WHERE ship_id = $1`,
          [corpShipId],
        );
      });
    });

    await t.step("P1 leaves corp (triggers disband) — succeeds with soft-delete", async () => {
      // Previously this failed because handleDisband() hard-deleted pseudo-
      // characters that had event FK references. The fix soft-deletes the
      // corporation and detaches (rather than deletes) pseudo-characters.
      const result = await api("corporation_leave", {
        character_id: p1Id,
        confirm: true,
      });
      assert(
        result.body.success,
        `corporation_leave should succeed but got: ${JSON.stringify(result.body)}`,
      );
    });

    await t.step("DB: corporation is soft-deleted", async () => {
      const rows = await withPg(async (pg) => {
        const r = await pg.queryObject<{ disbanded_at: string | null }>(
          `SELECT disbanded_at FROM corporations WHERE corp_id = $1`,
          [corpId],
        );
        return r.rows;
      });
      assertEquals(rows.length, 1, "Corporation row should still exist");
      assertExists(rows[0].disbanded_at, "disbanded_at should be set");
    });
  },
});

// ============================================================================
// Group 2: Corp disband preserves corp_id in events (soft-delete)
// ============================================================================
// With soft-delete, the corporation row is preserved so event FK references
// to corp_id remain valid. Events should keep their corp_id intact.

Deno.test({
  name: "fk_constraint — corp disband preserves corp_id in events",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step("reset and create corp with two members", async () => {
      p1Id = await characterIdFor(P1);
      p2Id = await characterIdFor(P2);
      p1ShipId = await shipIdFor(P1);
      p2ShipId = await shipIdFor(P2);
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "FK Test Corp Events",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      inviteCode = (createResult as Record<string, unknown>).invite_code as string;
    });

    await t.step("generate corp-scoped events", async () => {
      // P2 joins → corporation.member_joined event with corp_id
      await apiOk("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
    });

    await t.step("P2 leaves, then P1 leaves (triggers disband)", async () => {
      await apiOk("corporation_leave", { character_id: p2Id, confirm: true });

      const result = await api("corporation_leave", { character_id: p1Id, confirm: true });
      assert(
        result.body.success,
        `disband should succeed but got: ${JSON.stringify(result.body)}`,
      );
    });

    await t.step("DB: events still have corp_id (corp row preserved)", async () => {
      const events = await queryEvents("corp_id = $1", [corpId]);
      assert(
        events.length >= 1,
        `Expected events to retain corp_id after soft-delete disband, got ${events.length}`,
      );
    });

    await t.step("DB: corporation is soft-deleted", async () => {
      const rows = await withPg(async (pg) => {
        const r = await pg.queryObject<{ disbanded_at: string | null }>(
          `SELECT disbanded_at FROM corporations WHERE corp_id = $1`,
          [corpId],
        );
        return r.rows;
      });
      assertEquals(rows.length, 1);
      assertExists(rows[0].disbanded_at);
    });
  },
});

// ============================================================================
// Group 3: Ship hard-delete with event references (ship_id FK)
// ============================================================================
// The delete_character_cascade() stored procedure hard-deletes ships. If any
// events reference those ships via ship_id, the DELETE will fail.
// This test directly reproduces the FK violation at the DB level.

Deno.test({
  name: "fk_constraint — ship hard-delete blocked by events.ship_id FK",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let shipId: string;

    await t.step("reset and join", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      shipId = p1ShipId;
    });

    await t.step("generate an event referencing the ship", async () => {
      // my_status emits a status.snapshot event with ship_id set
      await apiOk("my_status", { character_id: p1Id });

      // Verify event has ship_id
      const events = await queryEvents("ship_id = $1", [shipId]);
      assert(
        events.length >= 1,
        `Expected events with ship_id=${shipId}, got ${events.length}`,
      );
    });

    await t.step("hard-deleting the ship fails due to FK constraint", async () => {
      // This reproduces what delete_character_cascade does: hard-delete the ship
      let threw = false;
      try {
        await withPg(async (pg) => {
          await pg.queryObject(
            `DELETE FROM ship_instances WHERE ship_id = $1`,
            [shipId],
          );
        });
      } catch (err) {
        threw = true;
        const msg = err instanceof Error ? err.message : String(err);
        assert(
          msg.includes("foreign key") || msg.includes("violates") || msg.includes("constraint"),
          `Expected FK constraint error, got: ${msg}`,
        );
      }
      assert(threw, "DELETE should have been blocked by FK constraint on events.ship_id");
    });
  },
});

// ============================================================================
// Group 4: Character hard-delete blocked by events.character_id FK
// ============================================================================
// The delete_character_cascade() stored procedure deletes the character record.
// If events reference that character via character_id or sender_id, it fails.

Deno.test({
  name: "fk_constraint — character hard-delete blocked by events.character_id FK",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("reset and join", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
    });

    await t.step("generate events referencing the character", async () => {
      await apiOk("my_status", { character_id: p1Id });

      const events = await queryEvents(
        "character_id = $1 OR sender_id = $1",
        [p1Id],
      );
      assert(
        events.length >= 1,
        `Expected events referencing character ${p1Id}`,
      );
    });

    await t.step("delete_character_cascade fails due to FK constraint", async () => {
      let threw = false;
      try {
        await withPg(async (pg) => {
          await pg.queryObject(
            `SELECT delete_character_cascade($1)`,
            [p1Id],
          );
        });
      } catch (err) {
        threw = true;
        const msg = err instanceof Error ? err.message : String(err);
        assert(
          msg.includes("foreign key") || msg.includes("violates") || msg.includes("constraint"),
          `Expected FK constraint error, got: ${msg}`,
        );
      }
      assert(threw, "delete_character_cascade should fail due to FK constraint on events");
    });
  },
});

// ============================================================================
// Group 5: Sold corp ship records survive disband (ship_id FK safe)
// ============================================================================
// After selling a corp ship (soft-delete: destroyed_at set, owner_type='unowned'),
// the ship_instances row persists so events.ship_id FK references remain valid.
// This test verifies the ship record survives through sell + disband.

Deno.test({
  name: "fk_constraint — sold corp ship records survive disband (ship_id FK safe)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset, create corp, buy and sell a ship", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "FK Ship Survive Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;

      // Insert an event referencing the corp ship via ship_id FK column.
      // This simulates any event that might reference the ship (e.g., combat,
      // move). We insert before selling so the FK reference exists when we
      // later verify it survives disband.
      await withPg(async (pg) => {
        await pg.queryObject(
          `INSERT INTO events (
            direction, event_type, scope, character_id, ship_id, payload,
            recipient_character_id, recipient_reason, inserted_at
          ) VALUES (
            'event_out', 'test.fk_ship_probe', 'direct', $1, $2, '{}'::jsonb,
            $1, 'direct', NOW()
          )`,
          [p1Id, corpShipId],
        );
      });

      // Sell the corp ship
      await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
    });

    await t.step("disband succeeds after selling ship", async () => {
      const result = await apiOk("corporation_leave", { character_id: p1Id, confirm: true });
      assert(result.success);
    });

    await t.step("DB: sold ship record still exists (ship_id FK intact)", async () => {
      const ship = await queryShip(corpShipId);
      assertExists(ship, "Ship record should still exist after sell + disband");
      assertExists(ship.destroyed_at, "Ship should have destroyed_at set");

      // Events still reference the ship — FK is valid because the row persists
      const events = await queryEvents("ship_id = $1", [corpShipId]);
      assert(
        events.length >= 1,
        "Events referencing ship_id should survive disband",
      );
    });
  },
});

// ============================================================================
// Group 6: Disbanded corp excluded from list and can't be joined
// ============================================================================

Deno.test({
  name: "fk_constraint — disbanded corp excluded from list and blocks join",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let inviteCode: string;

    await t.step("reset, create corp, then disband", async () => {
      p1Id = await characterIdFor(P1);
      p2Id = await characterIdFor(P2);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1, P2]);
      await apiOk("join", { character_id: p1Id });
      await apiOk("join", { character_id: p2Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Disbanded Test Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;
      inviteCode = (createResult as Record<string, unknown>).invite_code as string;

      // Disband by leaving as last member
      await apiOk("corporation_leave", { character_id: p1Id, confirm: true });
    });

    await t.step("disbanded corp not in corporation_list", async () => {
      const result = await apiOk("corporation_list", {
        character_id: p2Id,
      });
      const corps = (result as Record<string, unknown>).corporations as Array<Record<string, unknown>>;
      const found = corps?.find((c) => c.corp_id === corpId);
      assertEquals(found, undefined, "Disbanded corp should not appear in list");
    });

    await t.step("cannot join disbanded corp", async () => {
      const result = await api("corporation_join", {
        character_id: p2Id,
        corp_id: corpId,
        invite_code: inviteCode,
      });
      assert(!result.body.success, "Should not be able to join a disbanded corp");
    });
  },
});

// ============================================================================
// Group 7: Disbanded corp name can be reused
// ============================================================================

Deno.test({
  name: "fk_constraint — disbanded corp name can be reused",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const corpName = "Reusable Name Corp";

    await t.step("reset and create then disband corp", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 100000);

      await apiOk("corporation_create", {
        character_id: p1Id,
        name: corpName,
      });
      // Disband
      await apiOk("corporation_leave", { character_id: p1Id, confirm: true });
    });

    await t.step("can create new corp with same name", async () => {
      await setShipCredits(p1ShipId, 100000);
      const result = await apiOk("corporation_create", {
        character_id: p1Id,
        name: corpName,
      });
      assertExists(
        (result as Record<string, unknown>).corp_id,
        "Should be able to create corp with disbanded corp's name",
      );
    });
  },
});

// ============================================================================
// Group 8: Cannot leave corp as last member while corp still has ships
// ============================================================================

Deno.test({
  name: "fk_constraint — cannot disband corp that still has ships",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;

    await t.step("reset and create corp with a ship", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Ships Block Leave Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      // Buy a corp ship
      await setMegabankBalance(p1Id, 10000);
      await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
    });

    await t.step("leaving as last member fails — corp has ships", async () => {
      const result = await api("corporation_leave", {
        character_id: p1Id,
        confirm: true,
      });
      assert(
        !result.body.success,
        "Should not be able to disband corp while it still has ships",
      );
      assert(
        result.body.error?.includes("ship"),
        `Error should mention ships, got: ${result.body.error}`,
      );
    });

    await t.step("DB: P1 still in corporation", async () => {
      const char = await withPg(async (pg) => {
        const r = await pg.queryObject<{ corporation_id: string | null }>(
          `SELECT corporation_id FROM characters WHERE character_id = $1`,
          [p1Id],
        );
        return r.rows[0];
      });
      assertEquals(char.corporation_id, corpId, "P1 should still be in the corp");
    });
  },
});

// ============================================================================
// Group 9: Can leave corp after selling all corp ships
// ============================================================================

Deno.test({
  name: "fk_constraint — can disband corp after selling all ships",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    let corpId: string;
    let corpShipId: string;

    await t.step("reset and create corp with a ship", async () => {
      p1Id = await characterIdFor(P1);
      p1ShipId = await shipIdFor(P1);
      await resetDatabase([P1]);
      await apiOk("join", { character_id: p1Id });
      await setShipCredits(p1ShipId, 50000);

      const createResult = await apiOk("corporation_create", {
        character_id: p1Id,
        name: "Sell Then Leave Corp",
      });
      corpId = (createResult as Record<string, unknown>).corp_id as string;

      // Buy a corp ship
      await setMegabankBalance(p1Id, 10000);
      const purchaseResult = await apiOk("ship_purchase", {
        character_id: p1Id,
        ship_type: "autonomous_probe",
        purchase_type: "corporation",
      });
      corpShipId = (purchaseResult as Record<string, unknown>).ship_id as string;
    });

    await t.step("sell the corp ship", async () => {
      const result = await apiOk("ship_sell", {
        character_id: p1Id,
        ship_id: corpShipId,
        actor_character_id: p1Id,
      });
      assert(result.success);
    });

    await t.step("now leaving as last member succeeds", async () => {
      const result = await apiOk("corporation_leave", {
        character_id: p1Id,
        confirm: true,
      });
      assert(result.success);
    });

    await t.step("DB: corporation is soft-deleted", async () => {
      const rows = await withPg(async (pg) => {
        const r = await pg.queryObject<{ disbanded_at: string | null }>(
          `SELECT disbanded_at FROM corporations WHERE corp_id = $1`,
          [corpId],
        );
        return r.rows;
      });
      assertEquals(rows.length, 1);
      assertExists(rows[0].disbanded_at);
    });
  },
});
