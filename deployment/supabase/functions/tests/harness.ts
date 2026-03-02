/**
 * Test harness for Gradient Bang integration tests.
 *
 * Provides comprehensive database reset (TRUNCATE CASCADE + test_reset re-seed)
 * and environment helpers.
 */

import { Client } from "postgres";

// ---------------------------------------------------------------------------
// All dynamic tables in the database (27 total, minus ship_definitions and
// config which are static reference data). TRUNCATE ... CASCADE handles FK
// ordering automatically.
// ---------------------------------------------------------------------------
const TRUNCATE_TABLES = [
  "quest_progress_events",
  "player_quest_steps",
  "player_quests",
  "quest_event_subscriptions",
  "quest_step_definitions",
  "quest_definitions",
  "user_characters",
  "public_rate_limits",
  "rate_limits",
  "events",
  "admin_actions",
  "port_transactions",
  "leaderboard_cache",
  "corporation_map_knowledge",
  "corporation_ships",
  "corporation_members",
  "garrisons",
  "ship_instances",
  "corporations",
  "characters",
  "sector_contents",
  "ports",
  "universe_structure",
  "universe_config",
  "app_runtime_config",
];

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

export function getBaseUrl(): string {
  return Deno.env.get("TEST_BASE_URL") ?? "http://localhost:54390";
}

export function getPgUrl(): string {
  const url =
    Deno.env.get("POSTGRES_POOLER_URL") ?? Deno.env.get("POSTGRES_URL");
  if (!url) {
    throw new Error("POSTGRES_POOLER_URL or POSTGRES_URL must be set");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Database reset
// ---------------------------------------------------------------------------

/**
 * Comprehensive database reset:
 *
 * 1. TRUNCATE all dynamic tables via direct PG (fast, CASCADE handles FKs)
 * 2. Re-insert singleton rows expected by some functions
 * 3. Call the test_reset endpoint to re-seed universe structure, ports,
 *    sector contents, and optionally characters + ships from fixtures
 *
 * @param characterIds - Character names to create (resolved to UUIDs by test_reset)
 */
export async function resetDatabase(
  characterIds: string[] = [],
): Promise<void> {
  const pg = new Client(getPgUrl());
  try {
    await pg.connect();

    // TRUNCATE all tables at once — CASCADE handles FK ordering
    const tableList = TRUNCATE_TABLES.join(", ");
    await pg.queryObject(
      `TRUNCATE ${tableList} RESTART IDENTITY CASCADE`,
    );

    // Re-insert leaderboard_cache singleton (expected by leaderboard functions)
    await pg.queryObject(`
      INSERT INTO leaderboard_cache (id, wealth, territory, trading, exploration)
      VALUES (1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
  } finally {
    await pg.end();
  }

  // Call test_reset to re-seed universe fixtures + create characters
  const baseUrl = getBaseUrl();
  const resp = await fetch(`${baseUrl}/test_reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ character_ids: characterIds }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`test_reset failed (${resp.status}): ${text}`);
  }

  const result = await resp.json();
  if (!result.success) {
    throw new Error(`test_reset returned failure: ${JSON.stringify(result)}`);
  }
}

/**
 * Clear only the events table. Useful between sub-tests when you want to
 * keep characters and ships but get a clean event slate.
 */
export async function clearEvents(): Promise<void> {
  const pg = new Client(getPgUrl());
  try {
    await pg.connect();
    await pg.queryObject("TRUNCATE events RESTART IDENTITY CASCADE");
  } finally {
    await pg.end();
  }
}
