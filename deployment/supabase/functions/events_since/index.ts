import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  parseJsonRequest,
  optionalNumber,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
  requireString,
} from "../_shared/request.ts";
import { canonicalizeCharacterId } from "../_shared/ids.ts";

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 100;

interface JsonRecord {
  [key: string]: unknown;
}

interface EventRow {
  id: number;
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown> | null;
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
  event_character_recipients?: Array<{ character_id: string; reason: string }>; // joined rows
  event_broadcast_recipients?: Array<{ event_id: number }>; // joined rows for broadcast events
}

Deno.serve(async (req: Request): Promise<Response> => {
  const tStart = performance.now();
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  let payload: JsonRecord;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("events_since.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: "ok",
      token_present: Boolean(Deno.env.get("EDGE_API_TOKEN")),
    });
  }

  const requestId = resolveRequestId(payload);
  const supabase = createServiceRoleClient();

  try {
    const result = await handleEventsSinceRequest(supabase, payload);
    const tEnd = performance.now();
    console.log("events_since.timing", {
      request_id: requestId,
      character_id: payload?.character_id,
      since_event_id: payload?.since_event_id,
      limit: payload?.limit,
      duration_ms: Math.round(tEnd - tStart),
      events: Array.isArray(result?.events) ? result.events.length : null,
      has_more: result?.has_more ?? null,
    });
    return successResponse({ request_id: requestId, ...result });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    // Log the full error plus a hint of inputs for diagnostics
    try {
      console.error("events_since.unhandled", {
        error: err?.message ?? String(err),
        stack: err?.stack,
        character_id: payload?.character_id,
        since_event_id: payload?.since_event_id,
        limit: payload?.limit,
      });
    } catch (_logErr) {
      console.error("events_since.unhandled", err);
    }
    return errorResponse("internal server error", 500);
  }
});

async function handleEventsSinceRequest(
  supabase: SupabaseClient,
  payload: JsonRecord,
): Promise<{
  events: JsonRecord[];
  last_event_id: number | null;
  has_more: boolean;
}> {
  const characterInput = requireString(payload, "character_id");
  const canonicalCharacterId = await canonicalizeCharacterId(characterInput);

  const limitRaw = optionalNumber(payload, "limit");
  const limit = clampLimit(limitRaw === null ? DEFAULT_LIMIT : limitRaw);
  const fetchLimit = Math.min(limit + 1, MAX_LIMIT + 1);

  const sinceEventIdRaw = optionalNumber(payload, "since_event_id");
  const sinceEventId = normalizeSinceEventId(sinceEventIdRaw);

  const initialOnly = optionalBoolean(payload, "initial_only") ?? false;
  if (initialOnly || sinceEventId === null) {
    const lastId = await fetchLatestEventId(supabase);
    return { events: [], last_event_id: lastId, has_more: false };
  }

  const rows = await fetchEventsForCharacter({
    supabase,
    characterId: canonicalCharacterId,
    sinceEventId,
    limit: fetchLimit,
  });

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const events = trimmed.map((row) => normalizeEventRow(row));
  const lastEventId = events.length
    ? (events[events.length - 1].id as number)
    : sinceEventId;

  return { events, last_event_id: lastEventId, has_more: hasMore };
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function normalizeSinceEventId(value: number | null): number | null {
  if (value === null || Number.isNaN(value)) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.floor(value));
  return normalized;
}

async function fetchLatestEventId(
  supabase: SupabaseClient,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("events")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("events_since.fetch_latest_id", error);
    throw new Error("failed to determine latest event id");
  }

  if (data && typeof data.id === "number") {
    return data.id;
  }
  return null;
}

async function fetchEventsForCharacter(options: {
  supabase: SupabaseClient;
  characterId: string;
  sinceEventId: number;
  limit: number;
}): Promise<EventRow[]> {
  const { supabase, characterId, sinceEventId, limit } = options;

  // Fetch character-specific events (via event_character_recipients)
  // Apply a safety cap on limit to avoid heavy responses under high load
  const cappedLimit = Math.min(limit, 50);

  const { data: charEvents, error: charError } = await supabase
    .from("events")
    .select(
      `
        id,
        event_type,
        timestamp,
        payload,
        scope,
        actor_character_id,
        sector_id,
        corp_id,
        inserted_at,
        task_id,
        request_id,
        meta,
        direction,
        character_id,
        sender_id,
        ship_id,
        event_character_recipients!inner(character_id, reason)
      `,
    )
    .eq("event_character_recipients.character_id", characterId)
    .gt("id", sinceEventId)
    .order("id", { ascending: true })
    .limit(cappedLimit)
    .returns<EventRow[]>();

  if (charError) {
    console.error("events_since.fetch_character_events", {
      message: charError.message,
      details: charError.details,
      hint: charError.hint,
      code: charError.code,
    });
    throw new Error(
      `failed to load character events: ${charError.message || "unknown error"}`,
    );
  }

  // Fetch broadcast events (via event_broadcast_recipients)
  const { data: broadcastEvents, error: broadcastError } = await supabase
    .from("events")
    .select(
      `
        id,
        event_type,
        timestamp,
        payload,
        scope,
        actor_character_id,
        sector_id,
        corp_id,
        inserted_at,
        task_id,
        request_id,
        meta,
        direction,
        character_id,
        sender_id,
        ship_id,
        event_broadcast_recipients!inner(event_id)
      `,
    )
    .gt("id", sinceEventId)
    .order("id", { ascending: true })
    .limit(cappedLimit)
    .returns<EventRow[]>();

  if (broadcastError) {
    console.error("events_since.fetch_broadcast_events", {
      message: broadcastError.message,
      details: broadcastError.details,
      hint: broadcastError.hint,
      code: broadcastError.code,
    });
    throw new Error(
      `failed to load broadcast events: ${broadcastError.message || "unknown error"}`,
    );
  }

  // Merge and deduplicate by event id, keeping the version with character_recipients if present
  const eventMap = new Map<number, EventRow>();

  for (const event of charEvents ?? []) {
    eventMap.set(event.id, event as EventRow);
  }

  for (const event of broadcastEvents ?? []) {
    if (!eventMap.has(event.id)) {
      // Add event_character_recipients as empty array for consistency
      eventMap.set(event.id, {
        ...event,
        event_character_recipients: [],
      } as EventRow);
    }
  }

  // Sort by id and apply limit
  const merged = Array.from(eventMap.values())
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);

  return merged;
}

function normalizeEventRow(row: EventRow): JsonRecord {
  const recipients = Array.isArray(row.event_character_recipients)
    ? row.event_character_recipients
    : row.event_character_recipients
      ? [
          row.event_character_recipients as unknown as {
            character_id: string;
            reason: string;
          },
        ]
      : [];
  const recipientReason = recipients.length
    ? (recipients[0]?.reason ?? null)
    : null;
  const basePayload = row.payload ?? {};
  const payload =
    typeof row.task_id === "string" && row.task_id.length > 0
      ? { ...basePayload, __task_id: row.task_id }
      : basePayload;

  return {
    id: row.id,
    event_type: row.event_type,
    timestamp: row.timestamp,
    payload,
    scope: row.scope,
    actor_character_id: row.actor_character_id,
    sector_id: row.sector_id,
    corp_id: row.corp_id,
    task_id: row.task_id,
    inserted_at: row.inserted_at,
    request_id: row.request_id,
    meta: row.meta,
    direction: row.direction,
    character_id: row.character_id,
    sender_id: row.sender_id,
    ship_id: row.ship_id,
    recipient_reason: recipientReason,
    event_context: {
      event_id: row.id,
      character_id: recipients.length
        ? (recipients[0]?.character_id ?? null)
        : null,
      reason: recipientReason,
    },
  };
}
