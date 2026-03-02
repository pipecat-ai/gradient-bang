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
