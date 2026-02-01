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
  optionalString,
  resolveRequestId,
  respondWithError,
  RequestValidationError,
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

interface EventRecipientRow {
  event_id: number;
  character_id: string | null;
  reason: string | null;
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
      character_ids: payload?.character_ids,
      corp_id: payload?.corp_id,
      ship_ids: payload?.ship_ids,
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
        character_ids: payload?.character_ids,
        corp_id: payload?.corp_id,
        ship_ids: payload?.ship_ids,
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
  const characterIds = await resolveCharacterIds(payload);
  const corpId = optionalString(payload, "corp_id");
  const shipIds = parseStringArray(payload, "ship_ids");

  if (!characterIds.length && !corpId && !shipIds.length) {
    throw new RequestValidationError(
      "character_id, character_ids, corp_id, or ship_ids must be provided",
      400,
    );
  }

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

  const rows = await fetchEventsForScopes({
    supabase,
    characterIds,
    corpId,
    shipIds,
    sinceEventId,
    limit: fetchLimit,
  });

  const recipientMap = await loadEventRecipients(
    supabase,
    rows.map((row) => row.id),
  );

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const events = trimmed.map((row) => normalizeEventRow(row, recipientMap));
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

async function resolveCharacterIds(payload: JsonRecord): Promise<string[]> {
  const ids: string[] = [];
  const singleId = optionalString(payload, "character_id");
  if (singleId) {
    ids.push(singleId);
  }
  const list = parseStringArray(payload, "character_ids");
  if (list.length) {
    ids.push(...list);
  }
  if (!ids.length) {
    return [];
  }
  const canonicalIds = await Promise.all(
    ids.map((id) => canonicalizeCharacterId(id)),
  );
  return Array.from(new Set(canonicalIds));
}

function parseStringArray(payload: JsonRecord, key: string): string[] {
  const raw = payload[key];
  if (raw === null || raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new RequestValidationError(`${key} must be an array of strings`, 400);
  }
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new RequestValidationError(`${key} must contain only strings`, 400);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new RequestValidationError(`${key} cannot include empty strings`, 400);
    }
    values.push(trimmed);
  }
  return values;
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

async function fetchEventsForScopes(options: {
  supabase: SupabaseClient;
  characterIds: string[];
  corpId: string | null;
  shipIds: string[];
  sinceEventId: number;
  limit: number;
}): Promise<EventRow[]> {
  const { supabase, characterIds, corpId, shipIds, sinceEventId, limit } =
    options;

  const cappedLimit = Math.min(limit, 50);
  const eventMap = new Map<number, EventRow>();

  if (characterIds.length) {
    // Fetch character-specific events (via event_character_recipients)
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
      .in("event_character_recipients.character_id", characterIds)
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

    for (const event of charEvents ?? []) {
      eventMap.set(event.id, event as EventRow);
    }
  }

  if (corpId) {
    const { data: corpEvents, error: corpError } = await supabase
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
          ship_id
        `,
      )
      .eq("corp_id", corpId)
      .gt("id", sinceEventId)
      .order("id", { ascending: true })
      .limit(cappedLimit)
      .returns<EventRow[]>();

    if (corpError) {
      console.error("events_since.fetch_corp_events", {
        message: corpError.message,
        details: corpError.details,
        hint: corpError.hint,
        code: corpError.code,
      });
      throw new Error(
        `failed to load corp events: ${corpError.message || "unknown error"}`,
      );
    }

    for (const event of corpEvents ?? []) {
      if (!eventMap.has(event.id)) {
        eventMap.set(event.id, event as EventRow);
      }
    }
  }

  if (shipIds.length) {
    const { data: shipEvents, error: shipError } = await supabase
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
          ship_id
        `,
      )
      .in("ship_id", shipIds)
      .gt("id", sinceEventId)
      .order("id", { ascending: true })
      .limit(cappedLimit)
      .returns<EventRow[]>();

    if (shipError) {
      console.error("events_since.fetch_ship_events", {
        message: shipError.message,
        details: shipError.details,
        hint: shipError.hint,
        code: shipError.code,
      });
      throw new Error(
        `failed to load ship events: ${shipError.message || "unknown error"}`,
      );
    }

    for (const event of shipEvents ?? []) {
      if (!eventMap.has(event.id)) {
        eventMap.set(event.id, event as EventRow);
      }
    }
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

async function loadEventRecipients(
  supabase: SupabaseClient,
  eventIds: number[],
): Promise<Map<number, Array<{ character_id: string; reason: string }>>> {
  const recipientMap = new Map<number, Array<{ character_id: string; reason: string }>>();
  const uniqueIds = Array.from(new Set(eventIds.filter((id) => Number.isFinite(id))));
  if (!uniqueIds.length) {
    return recipientMap;
  }
  const { data, error } = await supabase
    .from("event_character_recipients")
    .select("event_id, character_id, reason")
    .in("event_id", uniqueIds)
    .returns<EventRecipientRow[]>();

  if (error) {
    console.error("events_since.fetch_recipients", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    throw new Error(
      `failed to load event recipients: ${error.message || "unknown error"}`,
    );
  }

  for (const row of data ?? []) {
    if (typeof row.event_id !== "number") {
      continue;
    }
    const characterId = typeof row.character_id === "string" ? row.character_id : "";
    const reason = typeof row.reason === "string" ? row.reason : "";
    if (!characterId || !reason) {
      continue;
    }
    const list = recipientMap.get(row.event_id);
    if (list) {
      list.push({ character_id: characterId, reason });
    } else {
      recipientMap.set(row.event_id, [{ character_id: characterId, reason }]);
    }
  }

  return recipientMap;
}

function normalizeEventRow(
  row: EventRow,
  recipientMap: Map<number, Array<{ character_id: string; reason: string }>>,
): JsonRecord {
  const recipients = recipientMap.get(row.id) ?? [];
  const recipientReason = recipients.length ? (recipients[0]?.reason ?? null) : null;
  const recipientIds = recipients.map((recipient) => recipient.character_id);
  const recipientReasons = recipients.map((recipient) => recipient.reason);
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
    recipient_ids: recipientIds,
    recipient_reasons: recipientReasons,
    event_context: {
      event_id: row.id,
      character_id: recipients.length
        ? (recipients[0]?.character_id ?? null)
        : null,
      reason: recipientReason,
      scope: row.scope,
      recipient_ids: recipientIds,
      recipient_reasons: recipientReasons,
    },
  };
}
