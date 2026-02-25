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
  recipient_character_id: string | null;
  recipient_reason: string | null;
  is_broadcast: boolean;
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

  if (!characterIds.length && !corpId) {
    throw new RequestValidationError(
      "character_id, character_ids, or corp_id must be provided",
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

  const rows = await fetchEvents({
    supabase,
    characterIds,
    corpId,
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

async function fetchEvents(options: {
  supabase: SupabaseClient;
  characterIds: string[];
  corpId: string | null;
  sinceEventId: number;
  limit: number;
}): Promise<EventRow[]> {
  const { supabase, characterIds, corpId, sinceEventId, limit } = options;

  const orClauses: string[] = [];
  if (characterIds.length === 1) {
    orClauses.push(`recipient_character_id.eq.${characterIds[0]}`);
  } else if (characterIds.length > 1) {
    orClauses.push(
      `recipient_character_id.in.(${characterIds.join(",")})`,
    );
  }
  if (corpId) {
    orClauses.push(`corp_id.eq.${corpId}`);
  }
  orClauses.push("is_broadcast.eq.true");

  const { data, error } = await supabase
    .from("events")
    .select(
      "id, event_type, timestamp, payload, scope, actor_character_id, sector_id, corp_id, inserted_at, task_id, request_id, meta, direction, character_id, sender_id, ship_id, recipient_character_id, recipient_reason, is_broadcast",
    )
    .gt("id", sinceEventId)
    .or(orClauses.join(","))
    .order("id", { ascending: true })
    .limit(limit)
    .returns<EventRow[]>();

  if (error) {
    console.error("events_since.fetch_events", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    throw new Error(
      `failed to load events: ${error.message || "unknown error"}`,
    );
  }

  return (data ?? []) as EventRow[];
}

function normalizeEventRow(row: EventRow): JsonRecord {
  const recipientId = row.recipient_character_id ?? null;
  const recipientReason = row.recipient_reason ?? null;
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
    recipient_ids: recipientId ? [recipientId] : [],
    recipient_reasons: recipientReason ? [recipientReason] : [],
    event_context: {
      event_id: row.id,
      character_id: recipientId,
      reason: recipientReason,
      scope: row.scope,
      recipient_ids: recipientId ? [recipientId] : [],
      recipient_reasons: recipientReason ? [recipientReason] : [],
    },
  };
}
