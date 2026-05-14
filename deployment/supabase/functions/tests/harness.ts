/**
 * Test harness for Gradient Bang integration tests.
 *
 * Provides comprehensive database reset (TRUNCATE CASCADE + test_reset re-seed),
 * environment helpers, and in-process server startup for code coverage.
 */

import { Client } from "postgres";
import {
  v5,
  validate as validateUuid,
} from "https://deno.land/std@0.197.0/uuid/mod.ts";

const LEGACY_NAMESPACE = "5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b";

// ---------------------------------------------------------------------------
// All dynamic tables in the database (27 total, minus ship_definitions and
// config which are static reference data). TRUNCATE ... CASCADE handles FK
// ordering automatically.
// ---------------------------------------------------------------------------
// app_runtime_config is intentionally NOT in this list — see the
// DELETE-with-WHERE block below. Wiping the whole table drops the migration's
// auto-provisioned `pubsub_internal_secret`, which then breaks verify_token +
// subscribe_my_events (and worse, would invalidate verify_token's
// module-scope cache mid-suite).
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

    // Re-insert leaderboard_cache singleton with an old timestamp so it's
    // treated as stale by leaderboard_resources (5-min TTL).
    await pg.queryObject(`
      INSERT INTO leaderboard_cache (id, wealth, territory, trading, exploration, updated_at)
      VALUES (1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '2000-01-01T00:00:00Z')
      ON CONFLICT (id) DO NOTHING
    `);

    // Clear app_runtime_config but preserve the two auto-provisioned secrets:
    //   - `pubsub_internal_secret` — HS256 signing key from the pgmq migration.
    //     Wiping it breaks verify_token + subscribe_my_events; rotating it
    //     mid-suite would invalidate verify_token's module-scope cache.
    //   - `byoa_operator_secret` — symmetric key for byoa_wake_secret_enc on
    //     ship_instances. Wiping it makes any encrypted bearer undecipherable
    //     and breaks wake_agent's get_ship_byoa_wake_config rpc.
    // Other runtime-config rows (e.g. cron knobs) are still wiped to keep
    // parity with reset-world.sh.
    await pg.queryObject(
      `DELETE FROM public.app_runtime_config
        WHERE key NOT IN ('pubsub_internal_secret', 'byoa_operator_secret')`,
    );
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

  await ensureCharacterQueues(characterIds);
}

async function ensureCharacterQueues(characterIds: string[]): Promise<void> {
  if (characterIds.length === 0) return;

  const pg = new Client(getPgUrl());
  try {
    await pg.connect();
    for (const character of characterIds) {
      const characterId = await canonicalCharacterId(character);
      await pg.queryObject("SELECT public.ensure_character_queue($1)", [
        characterId,
      ]);
      await pg.queryObject("SELECT pgmq.purge_queue($1)", [
        `chr_${characterId}`,
      ]);
    }
  } finally {
    await pg.end();
  }
}

async function canonicalCharacterId(value: string): Promise<string> {
  const trimmed = value.trim();
  if (validateUuid(trimmed)) return trimmed;
  const data = new TextEncoder().encode(trimmed);
  return await v5.generate(LEGACY_NAMESPACE, data);
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

// ---------------------------------------------------------------------------
// In-process server startup (for code coverage)
// ---------------------------------------------------------------------------

let _serverStarted = false;

/**
 * Start the unified server in-process by importing server.ts.
 *
 * This runs server.ts inside the test's V8 isolate so that `deno test --coverage`
 * can measure coverage of all edge function code. The server monkey-patches
 * Deno.serve() to capture handlers, then calls the real Deno.serve() on the
 * configured port.
 *
 * Call this once before tests run. It's idempotent — subsequent calls are no-ops.
 */
export async function startServerInProcess(): Promise<void> {
  if (_serverStarted) return;
  _serverStarted = true;

  const functionsDir = new URL("..", import.meta.url).pathname;
  const serverPath = `${functionsDir}server.ts`;

  await import(serverPath);

  // Wait for the server to be healthy
  const baseUrl = getBaseUrl();
  for (let i = 0; i < 60; i++) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("In-process server failed to start within 6 seconds");
}
