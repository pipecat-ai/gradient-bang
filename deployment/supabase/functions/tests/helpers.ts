/**
 * Test helpers for Gradient Bang integration tests.
 *
 * Provides an API client, event polling utilities, UUID generation
 * (matching production _shared/ids.ts), and direct DB query helpers.
 */

import { Client } from "postgres";
import {
  v5,
  validate as validateUuid,
} from "https://deno.land/std@0.197.0/uuid/mod.ts";
import { getBaseUrl, getPgUrl } from "./harness.ts";

// ============================================================================
// UUID generation — mirrors _shared/ids.ts exactly
// ============================================================================

const LEGACY_NAMESPACE = "5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b";
const SHIP_NAMESPACE = "b7b87641-1c44-4ed1-8e9c-5f671484b1a9";

/** Derive the canonical character UUID from a legacy string name. */
export async function characterIdFor(name: string): Promise<string> {
  const trimmed = name.trim();
  if (validateUuid(trimmed)) return trimmed;
  const data = new TextEncoder().encode(trimmed);
  return await v5.generate(LEGACY_NAMESPACE, data);
}

/** Derive the canonical ship UUID from a legacy string name. */
export async function shipIdFor(name: string): Promise<string> {
  const data = new TextEncoder().encode(name.trim());
  return await v5.generate(SHIP_NAMESPACE, data);
}

// ============================================================================
// API client
// ============================================================================

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  body: T & { success: boolean; error?: string };
}

/** Make an API call to the test server. */
export async function api<T = Record<string, unknown>>(
  endpoint: string,
  payload: Record<string, unknown> = {},
): Promise<ApiResponse<T>> {
  const baseUrl = getBaseUrl();
  const resp = await fetch(`${baseUrl}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await resp.json();
  return {
    status: resp.status,
    ok: resp.ok,
    body: body as T & { success: boolean; error?: string },
  };
}

/** Make a GET API call to the test server. */
export async function apiGet<T = Record<string, unknown>>(
  endpoint: string,
  query: Record<string, string | number | boolean> = {},
): Promise<ApiResponse<T>> {
  const baseUrl = getBaseUrl();
  const url = new URL(`${baseUrl}/${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  const resp = await fetch(url);
  const body = await resp.json();
  return {
    status: resp.status,
    ok: resp.ok,
    body: body as T & { success: boolean; error?: string },
  };
}

/** Make a raw API call (for sending non-JSON bodies like invalid payloads). */
export async function apiRaw(
  endpoint: string,
  rawBody: string,
): Promise<ApiResponse> {
  const baseUrl = getBaseUrl();
  const resp = await fetch(`${baseUrl}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  const body = await resp.json();
  return {
    status: resp.status,
    ok: resp.ok,
    body: body as Record<string, unknown> & { success: boolean; error?: string },
  };
}

/** Call API and assert success. Throws on non-success responses. */
export async function apiOk<T = Record<string, unknown>>(
  endpoint: string,
  payload: Record<string, unknown> = {},
): Promise<T & { success: boolean }> {
  const result = await api<T>(endpoint, payload);
  if (!result.ok || !result.body.success) {
    throw new Error(
      `API ${endpoint} failed: status=${result.status} ` +
        `body=${JSON.stringify(result.body)}`,
    );
  }
  return result.body as T & { success: boolean };
}

// ============================================================================
// Event types
// ============================================================================

export interface EventRow {
  id: number;
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
  scope: string;
  actor_character_id: string | null;
  sector_id: number | null;
  corp_id: string | null;
  task_id: string | null;
  inserted_at: string;
  request_id: string | null;
  meta: Record<string, unknown> | null;
  direction: string;
  character_id: string | null;
  sender_id: string | null;
  ship_id: string | null;
  recipient_reason: string | null;
  recipient_ids: string[];
  recipient_reasons: string[];
  event_context: Record<string, unknown>;
  [key: string]: unknown;
}

interface EventsSinceResponse {
  events: EventRow[];
  last_event_id: number | null;
  has_more: boolean;
}

// ============================================================================
// Event polling — uses the real events_since endpoint
// ============================================================================

/**
 * Fetch all events visible to a character since a given event ID.
 * Optionally include corp_id to also fetch corporation-scoped events.
 */
export async function eventsSince(
  characterId: string,
  sinceEventId: number = 0,
  corpId?: string,
): Promise<{ events: EventRow[]; lastEventId: number | null }> {
  const payload: Record<string, unknown> = {
    character_id: characterId,
    since_event_id: sinceEventId,
  };
  if (corpId) {
    payload.corp_id = corpId;
  }
  const result = await apiOk<EventsSinceResponse>("events_since", payload);
  return {
    events: (result.events ?? []) as EventRow[],
    lastEventId: result.last_event_id ?? null,
  };
}

/**
 * Get the current event cursor (latest event ID) for a character
 * without fetching any events.
 */
export async function getEventCursor(characterId: string): Promise<number> {
  const result = await apiOk<EventsSinceResponse>("events_since", {
    character_id: characterId,
    initial_only: true,
  });
  return result.last_event_id ?? 0;
}

/**
 * Fetch events of a specific type for a character since a cursor.
 * Optionally include corpId to also fetch corporation-scoped events.
 */
export async function eventsOfType(
  characterId: string,
  eventType: string,
  sinceEventId: number = 0,
  corpId?: string,
): Promise<EventRow[]> {
  const { events } = await eventsSince(characterId, sinceEventId, corpId);
  return events.filter((e) => e.event_type === eventType);
}

// ============================================================================
// Direct DB queries — for assertion and verification
// ============================================================================

/**
 * Execute a function with a PG connection that is automatically closed.
 */
export async function withPg<T>(fn: (pg: Client) => Promise<T>): Promise<T> {
  const pg = new Client(getPgUrl());
  try {
    await pg.connect();
    return await fn(pg);
  } finally {
    await pg.end();
  }
}

/** Read a character row directly from the database. */
export async function queryCharacter(
  characterId: string,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT * FROM characters WHERE character_id = $1`,
      [characterId],
    );
    return result.rows[0] ?? null;
  });
}

/** Read a ship_instances row directly from the database. */
export async function queryShip(
  shipId: string,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT * FROM ship_instances WHERE ship_id = $1`,
      [shipId],
    );
    return result.rows[0] ?? null;
  });
}

/** Query events directly from the database with a WHERE clause. */
export async function queryEvents(
  where: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT * FROM events WHERE ${where} ORDER BY id ASC`,
      params,
    );
    return result.rows;
  });
}

/** Count events matching a WHERE clause. */
export async function countEvents(
  where: string,
  params: unknown[] = [],
): Promise<number> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ count: bigint }>(
      `SELECT COUNT(*) as count FROM events WHERE ${where}`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

// ============================================================================
// Convenience helpers for multi-suite test setup
// ============================================================================

/**
 * Assert that a character has NO events of a given type since a cursor.
 * Useful for verifying event isolation (e.g., P3 should not see P1's events).
 */
export async function assertNoEventsOfType(
  characterId: string,
  eventType: string,
  sinceEventId: number = 0,
): Promise<void> {
  const events = await eventsOfType(characterId, eventType, sinceEventId);
  if (events.length > 0) {
    throw new Error(
      `Expected 0 ${eventType} events for ${characterId}, got ${events.length}: ` +
        JSON.stringify(events.map((e) => e.id)),
    );
  }
}

/** Set a ship's credits directly in the database. */
export async function setShipCredits(
  shipId: string,
  credits: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET credits = $1 WHERE ship_id = $2`,
      [credits, shipId],
    );
  });
}

/** Set a ship's warp power directly in the database. */
export async function setShipWarpPower(
  shipId: string,
  warpPower: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET current_warp_power = $1 WHERE ship_id = $2`,
      [warpPower, shipId],
    );
  });
}

/** Set a ship's fighter count directly in the database. */
export async function setShipFighters(
  shipId: string,
  fighters: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET current_fighters = $1 WHERE ship_id = $2`,
      [fighters, shipId],
    );
  });
}

/** Set a ship's shield count directly in the database. */
export async function setShipShields(
  shipId: string,
  shields: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET current_shields = $1 WHERE ship_id = $2`,
      [shields, shipId],
    );
  });
}

/** Set a ship's hyperspace state directly in the database. */
export async function setShipHyperspace(
  shipId: string,
  inHyperspace: boolean,
  destination: number | null = null,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET in_hyperspace = $1, hyperspace_destination = $2 WHERE ship_id = $3`,
      [inHyperspace, destination, shipId],
    );
  });
}

/** Move a ship to a specific sector directly in the database. */
export async function setShipSector(
  shipId: string,
  sector: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET current_sector = $1, in_hyperspace = false, hyperspace_destination = NULL WHERE ship_id = $2`,
      [sector, shipId],
    );
  });
}

/** Read corporation map knowledge directly from the database. */
export async function queryCorpMapKnowledge(
  corpId: string,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT * FROM corporation_map_knowledge WHERE corp_id = $1`,
      [corpId],
    );
    return result.rows[0] ?? null;
  });
}

/**
 * Create a corporation ship with its pseudo-character for testing.
 * Returns { shipId, pseudoCharacterId } where pseudoCharacterId === shipId.
 */
export async function createCorpShip(
  corpId: string,
  sectorId: number,
  shipName: string = "Corp Scout",
): Promise<{ shipId: string; pseudoCharacterId: string }> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ id: string }>(
      `SELECT gen_random_uuid()::text AS id`,
    );
    const shipId = result.rows[0].id;

    // 1. Insert ship_instances row (corporation-owned)
    await pg.queryObject(
      `INSERT INTO ship_instances (
        ship_id, owner_id, owner_type, owner_character_id, owner_corporation_id,
        ship_type, ship_name, current_sector, in_hyperspace,
        credits, cargo_qf, cargo_ro, cargo_ns,
        current_warp_power, current_shields, current_fighters,
        metadata
      ) VALUES (
        $1, $2, 'corporation', NULL, $2,
        'kestrel_courier', $3, $4, false,
        1000, 0, 0, 0,
        500, 150, 300,
        '{}'::jsonb
      )`,
      [shipId, corpId, shipName, sectorId],
    );

    // 2. Insert pseudo-character row (character_id = ship_id)
    await pg.queryObject(
      `INSERT INTO characters (
        character_id, name, current_ship_id, credits_in_megabank,
        map_knowledge, player_metadata, is_npc, corporation_id
      ) VALUES (
        $1, $2, $1, 0,
        '{"sectors_visited": {}, "total_sectors_visited": 0}'::jsonb,
        '{"player_type": "corporation_ship"}'::jsonb,
        true, $3
      )`,
      [shipId, `corp-ship-${shipName}`, corpId],
    );

    // 3. Insert corporation_ships linkage row
    await pg.queryObject(
      `INSERT INTO corporation_ships (corp_id, ship_id)
       VALUES ($1, $2)`,
      [corpId, shipId],
    );

    return { shipId, pseudoCharacterId: shipId };
  });
}

/** Set cargo on a ship directly in the database. */
export async function setShipCargo(
  shipId: string,
  cargo: { qf?: number; ro?: number; ns?: number },
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET cargo_qf = $1, cargo_ro = $2, cargo_ns = $3 WHERE ship_id = $4`,
      [cargo.qf ?? 0, cargo.ro ?? 0, cargo.ns ?? 0, shipId],
    );
  });
}

/** Set a character's megabank balance directly in the database. */
export async function setMegabankBalance(
  characterId: string,
  balance: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE characters SET credits_in_megabank = $1 WHERE character_id = $2`,
      [balance, characterId],
    );
  });
}

/** Query combat state from sector_contents for a given sector. */
export async function queryCombatState(
  sectorId: number,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ combat: Record<string, unknown> | null }>(
      `SELECT combat FROM sector_contents WHERE sector_id = $1`,
      [sectorId],
    );
    return result.rows[0]?.combat ?? null;
  });
}

/** Query salvage entries from sector_contents for a given sector. */
export async function querySectorSalvage(
  sectorId: number,
): Promise<Record<string, unknown>[]> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{ salvage: Record<string, unknown>[] | null }>(
      `SELECT salvage FROM sector_contents WHERE sector_id = $1`,
      [sectorId],
    );
    return result.rows[0]?.salvage ?? [];
  });
}

/**
 * Expire the combat deadline in sector_contents so combat_tick resolves immediately.
 * Sets the deadline to 1 second in the past.
 */
export async function expireCombatDeadline(
  sectorId: number,
): Promise<void> {
  await withPg(async (pg) => {
    const pastDeadline = new Date(Date.now() - 1000).toISOString();
    await pg.queryObject(
      `UPDATE sector_contents
       SET combat = jsonb_set(combat, '{deadline}', to_jsonb($1::text))
       WHERE sector_id = $2 AND combat IS NOT NULL`,
      [pastDeadline, sectorId],
    );
  });
}

/** Insert a salvage entry directly into sector_contents for testing. */
export async function insertSalvageEntry(
  sectorId: number,
  salvage: Record<string, unknown>,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE sector_contents
       SET salvage = COALESCE(salvage, '[]'::jsonb) || $1::jsonb
       WHERE sector_id = $2`,
      [JSON.stringify([salvage]), sectorId],
    );
  });
}

/** Set a ship's escape pod status directly in the database. */
export async function setShipType(
  shipId: string,
  shipType: string,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE ship_instances SET ship_type = $1 WHERE ship_id = $2`,
      [shipType, shipId],
    );
  });
}

/** Query a garrison row directly from the database. */
export async function queryGarrison(
  sectorId: number,
): Promise<Record<string, unknown> | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<Record<string, unknown>>(
      `SELECT * FROM garrisons WHERE sector_id = $1`,
      [sectorId],
    );
    return result.rows[0] ?? null;
  });
}

/** Insert a garrison row directly into the database for testing. */
export async function insertGarrisonDirect(
  sectorId: number,
  ownerId: string,
  fighters: number,
  mode: string = "offensive",
  tollAmount: number = 0,
  tollBalance: number = 0,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `INSERT INTO garrisons (sector_id, owner_id, fighters, mode, toll_amount, toll_balance, deployed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (sector_id) DO UPDATE SET
         owner_id = $2, fighters = $3, mode = $4, toll_amount = $5, toll_balance = $6`,
      [sectorId, ownerId, fighters, mode, tollAmount, tollBalance],
    );
  });
}

/** Set a garrison's toll_balance directly in the database. */
export async function setGarrisonTollBalance(
  sectorId: number,
  balance: number,
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE garrisons SET toll_balance = $1 WHERE sector_id = $2`,
      [balance, sectorId],
    );
  });
}

/** Configure fedspace_sectors in universe_config meta for testing. */
export async function setFedspaceSectors(
  sectors: number[],
): Promise<void> {
  await withPg(async (pg) => {
    await pg.queryObject(
      `UPDATE universe_config SET meta = jsonb_set(
        COALESCE(meta, '{}'::jsonb),
        '{fedspace_sectors}',
        $1::jsonb
      ) WHERE id = 1`,
      [JSON.stringify(sectors)],
    );
  });
}

/**
 * Ensure a sector has a port entry in the database. Needed for sector 0
 * (mega-port) which has no port row in the test fixtures, causing
 * has_megaport to be false in movement.complete events.
 */
export async function ensureSectorHasPort(
  sectorId: number,
  portClass: number = 7,
  portCode: string = "MPT",
): Promise<void> {
  await withPg(async (pg) => {
    // Check if port already exists
    const existing = await pg.queryObject<{ port_id: number }>(
      `SELECT port_id FROM ports WHERE sector_id = $1`,
      [sectorId],
    );
    if (existing.rows.length > 0) return;

    // Insert a port row
    const inserted = await pg.queryObject<{ port_id: number }>(
      `INSERT INTO ports (sector_id, port_code, port_class, max_qf, max_ro, max_ns, stock_qf, stock_ro, stock_ns)
       VALUES ($1, $2, $3, 1000, 1000, 1000, 700, 700, 700)
       RETURNING port_id`,
      [sectorId, portCode, portClass],
    );
    const portId = inserted.rows[0].port_id;

    // Link port to sector_contents
    await pg.queryObject(
      `UPDATE sector_contents SET port_id = $1 WHERE sector_id = $2`,
      [portId, sectorId],
    );
  });
}

// ============================================================================
// Quest helpers — seed definitions, query progress, advance to step
// ============================================================================

/**
 * Seed both tutorial quest definitions, step definitions, and event
 * subscriptions. Idempotent (ON CONFLICT DO NOTHING). Quest definition
 * tables are NOT truncated by test_reset, so this only needs to run once.
 */
export async function seedQuestDefinitions(): Promise<void> {
  await withPg(async (pg) => {
    // -- Tutorial 1: "Taking Flight" (7 steps) --
    await pg.queryObject(`
      INSERT INTO quest_definitions (code, name, description, assign_on_creation, is_repeatable, enabled, meta)
      VALUES ('tutorial', 'Taking Flight', 'Learn the basics of trading, navigation, and survival in the galaxy.', true, false, true, '{"giver":"Federation Intake Program"}'::jsonb)
      ON CONFLICT (code) DO NOTHING
    `);

    const t1 = await pg.queryObject<{ id: string }>(
      `SELECT id FROM quest_definitions WHERE code = 'tutorial'`,
    );
    const tutorialId = t1.rows[0].id;

    // Steps for tutorial 1
    const tutorialSteps: Array<{
      idx: number; name: string; eval: string;
      events: string[]; target: number;
      filter?: string; aggField?: string; rewardCredits?: number;
    }> = [
      { idx: 1, name: "Travel to any adjacent sector", eval: "count", events: ["movement.complete"], target: 1, rewardCredits: 50 },
      { idx: 2, name: "Locate the Megaport", eval: "count_filtered", events: ["movement.complete"], target: 1, filter: '{"has_megaport":true}', rewardCredits: 100 },
      { idx: 3, name: "Refuel your ship", eval: "count", events: ["warp.purchase"], target: 1 },
      { idx: 4, name: "Purchase a commodity", eval: "count", events: ["trade.executed"], target: 1 },
      { idx: 5, name: "Earn 1000 credits trading", eval: "aggregate", events: ["trade.executed"], target: 1000, aggField: "profit" },
      { idx: 6, name: "Purchase a kestrel", eval: "count_filtered", events: ["ship.traded_in"], target: 1, filter: '{"new_ship_type":"kestrel_courier"}' },
      { idx: 7, name: "Accept a contract from the contracts board", eval: "count_filtered", events: ["quest.assigned"], target: 1, filter: '{"quest_code":"tutorial_corporations"}' },
    ];

    for (const s of tutorialSteps) {
      await pg.queryObject(
        `INSERT INTO quest_step_definitions (quest_id, step_index, name, eval_type, event_types, target_value, payload_filter, aggregate_field, reward_credits)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7::jsonb, $8, $9)
         ON CONFLICT (quest_id, step_index) DO NOTHING`,
        [tutorialId, s.idx, s.name, s.eval, s.events, s.target, s.filter ?? "{}", s.aggField ?? null, s.rewardCredits ?? null],
      );
    }

    // -- Tutorial 2: "Corporations & Fleet Command" (2 steps) --
    await pg.queryObject(`
      INSERT INTO quest_definitions (code, name, description, assign_on_creation, is_repeatable, enabled, meta)
      VALUES ('tutorial_corporations', 'Corporations & Fleet Command', 'Learn how to form a corporation and manage a fleet of ships.', false, false, true, '{}'::jsonb)
      ON CONFLICT (code) DO NOTHING
    `);

    const t2 = await pg.queryObject<{ id: string }>(
      `SELECT id FROM quest_definitions WHERE code = 'tutorial_corporations'`,
    );
    const tutCorpId = t2.rows[0].id;

    const corpSteps: Array<{
      idx: number; name: string; eval: string;
      events: string[]; target: number; filter?: string; rewardCredits?: number;
    }> = [
      { idx: 1, name: "Create or join a corporation", eval: "count", events: ["corporation.created", "corporation.member_joined"], target: 1, rewardCredits: 500 },
      { idx: 2, name: "Run a task on a corp ship", eval: "count_filtered", events: ["task.start"], target: 1, filter: '{"task_scope":"corp_ship"}', rewardCredits: 1000 },
    ];

    for (const s of corpSteps) {
      await pg.queryObject(
        `INSERT INTO quest_step_definitions (quest_id, step_index, name, eval_type, event_types, target_value, payload_filter, reward_credits)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7::jsonb, $8)
         ON CONFLICT (quest_id, step_index) DO NOTHING`,
        [tutCorpId, s.idx, s.name, s.eval, s.events, s.target, s.filter ?? "{}", s.rewardCredits ?? null],
      );
    }

    // -- Event subscriptions (maps event_type → step_id) --
    await pg.queryObject(`
      INSERT INTO quest_event_subscriptions (event_type, step_id)
      SELECT unnest(qsd.event_types), qsd.id
      FROM quest_step_definitions qsd
      WHERE qsd.quest_id IN (
        SELECT id FROM quest_definitions WHERE code IN ('tutorial', 'tutorial_corporations')
      )
      ON CONFLICT DO NOTHING
    `);
  });
}

/** Query a player's quest state by quest code. */
export async function queryPlayerQuest(
  playerId: string,
  questCode: string,
): Promise<{ status: string; current_step_index: number; completed_at: string | null } | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{
      status: string;
      current_step_index: number;
      completed_at: string | null;
    }>(
      `SELECT pq.status, pq.current_step_index, pq.completed_at::text
       FROM player_quests pq
       JOIN quest_definitions qd ON qd.id = pq.quest_id
       WHERE pq.player_id = $1 AND qd.code = $2`,
      [playerId, questCode],
    );
    return result.rows[0] ?? null;
  });
}

/** Query a player's quest step progress by quest code and step index. */
export async function queryPlayerQuestStep(
  playerId: string,
  questCode: string,
  stepIndex: number,
): Promise<{ current_value: number; completed_at: string | null } | null> {
  return await withPg(async (pg) => {
    const result = await pg.queryObject<{
      current_value: number;
      completed_at: string | null;
    }>(
      `SELECT pqs.current_value, pqs.completed_at::text
       FROM player_quest_steps pqs
       JOIN player_quests pq ON pq.id = pqs.player_quest_id
       JOIN quest_definitions qd ON qd.id = pq.quest_id
       JOIN quest_step_definitions qsd ON qsd.id = pqs.step_id
       WHERE pq.player_id = $1 AND qd.code = $2 AND qsd.step_index = $3`,
      [playerId, questCode, stepIndex],
    );
    return result.rows[0] ?? null;
  });
}

/**
 * Advance a quest directly to a target step via SQL. Creates the
 * player_quests row at the target step_index and a player_quest_steps
 * row for that step. Does NOT create rows for prior steps.
 *
 * WARNING: The catch-up trigger fires on the player_quest_steps INSERT.
 * If matching past events exist, they will be replayed. Call this BEFORE
 * performing game actions to keep individual step tests isolated.
 */
export async function advanceQuestToStep(
  playerId: string,
  questCode: string,
  targetStepIndex: number,
): Promise<void> {
  await withPg(async (pg) => {
    // Look up quest and step IDs
    const quest = await pg.queryObject<{ id: string }>(
      `SELECT id FROM quest_definitions WHERE code = $1`,
      [questCode],
    );
    if (!quest.rows[0]) throw new Error(`Quest not found: ${questCode}`);
    const questId = quest.rows[0].id;

    const step = await pg.queryObject<{ id: string }>(
      `SELECT id FROM quest_step_definitions WHERE quest_id = $1 AND step_index = $2`,
      [questId, targetStepIndex],
    );
    if (!step.rows[0]) throw new Error(`Step ${targetStepIndex} not found for quest ${questCode}`);
    const stepId = step.rows[0].id;

    // Create player_quests row
    const pqId = crypto.randomUUID();
    await pg.queryObject(
      `INSERT INTO player_quests (id, player_id, quest_id, status, current_step_index)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (player_id, quest_id) DO UPDATE SET current_step_index = $4, status = 'active', completed_at = NULL`,
      [pqId, playerId, questId, targetStepIndex],
    );

    // Get actual pq ID (in case of conflict update)
    const pq = await pg.queryObject<{ id: string }>(
      `SELECT id FROM player_quests WHERE player_id = $1 AND quest_id = $2`,
      [playerId, questId],
    );
    const actualPqId = pq.rows[0].id;

    // Create player_quest_steps row (triggers catch_up_new_quest_step)
    await pg.queryObject(
      `INSERT INTO player_quest_steps (id, player_quest_id, step_id)
       VALUES (gen_random_uuid(), $1, $2)`,
      [actualPqId, stepId],
    );
  });
}
