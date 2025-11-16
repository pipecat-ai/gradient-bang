import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { timingSafeEqual } from 'https://deno.land/std@0.224.0/crypto/timing_safe_equal.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import {
  parseJsonRequest,
  optionalString,
  optionalNumber,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

const MAX_QUERY_RESULTS = 1024;
const DEFAULT_LIMIT = 1000;

const ADMIN_PASSWORD = Deno.env.get('EDGE_ADMIN_PASSWORD')
  ?? Deno.env.get('ADMIN_PASSWORD')
  ?? '';
const ADMIN_PASSWORD_HASH = Deno.env.get('EDGE_ADMIN_PASSWORD_HASH')
  ?? Deno.env.get('ADMIN_PASSWORD_HASH')
  ?? '';

type JsonRecord = Record<string, unknown>;

interface EventRow {
  timestamp: string;
  direction: string;
  event_type: string;
  character_id: string | null;
  sender_id: string | null;
  sector_id: number | null;
  ship_id: string | null;
  request_id: string | null;
  payload: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  event_character_recipients?: Array<{ character_id: string; reason: string }> | { character_id: string; reason: string };
}

interface EventQueryResult {
  events: JsonRecord[];
  truncated: boolean;
  scope: 'personal' | 'corporation';
}

class EventQueryError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'EventQueryError';
    this.status = status;
  }
}

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: JsonRecord;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('event_query.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);

  try {
    const result = await executeEventQuery(supabase, payload);
    return successResponse({ request_id: requestId, ...result });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    if (err instanceof EventQueryError) {
      return errorResponse(err.message, err.status);
    }
    console.error('event_query.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function executeEventQuery(
  supabase: SupabaseClient,
  payload: JsonRecord,
): Promise<EventQueryResult & { count: number }> {
  const start = parseTimestamp(payload['start'], 'start');
  const end = parseTimestamp(payload['end'], 'end');
  if (start.getTime() > end.getTime()) {
    throw new EventQueryError('start must be before end');
  }

  const adminPasswordProvided = Object.prototype.hasOwnProperty.call(payload, 'admin_password');
  const adminPasswordCandidate = adminPasswordProvided ? payload['admin_password'] : null;
  const isAdmin = adminPasswordProvided && await validateAdminPassword(adminPasswordCandidate);

  const characterId = optionalString(payload, 'character_id');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  if (!isAdmin && !characterId && !actorCharacterId) {
    throw new EventQueryError('character_id or actor_character_id required for non-admin queries', 403);
  }

  const sectorValue = optionalNumber(payload, 'sector');
  const sectorFilter = sectorValue === null ? null : enforceInteger(sectorValue, 'sector');

  const stringMatch = optionalString(payload, 'string_match');
  if (stringMatch !== null && !stringMatch.length) {
    throw new EventQueryError('string_match cannot be empty');
  }

  const maxRowsRaw = optionalNumber(payload, 'max_rows');
  const maxRows = clampQueryLimit(maxRowsRaw === null ? DEFAULT_LIMIT : enforceInteger(maxRowsRaw, 'max_rows'));

  const sortDirectionRaw = optionalString(payload, 'sort_direction');
  const sortDirection = normalizeSortDirection(sortDirectionRaw);

  const eventScopeRaw = optionalString(payload, 'event_scope');
  let normalizedScope = normalizeScope(eventScopeRaw);

  const actorCandidate = actorCharacterId ?? characterId ?? null;
  let actorCorpId: string | null = null;

  let corporationId = optionalString(payload, 'corporation_id');
  if (normalizedScope === 'corporation' && !corporationId && actorCandidate) {
    actorCorpId = await fetchCharacterCorporationId(supabase, actorCandidate);
    if (actorCorpId) {
      corporationId = actorCorpId;
    } else {
      normalizedScope = 'personal';
    }
  }

  if (corporationId && !isAdmin) {
    if (!actorCorpId && actorCandidate) {
      actorCorpId = await fetchCharacterCorporationId(supabase, actorCandidate);
    }
    if (!actorCorpId || actorCorpId !== corporationId) {
      throw new EventQueryError("Actor is not authorized to view this corporation's events", 403);
    }
  }

  const effectiveScope: 'personal' | 'corporation' = corporationId ? 'corporation' : 'personal';

  // Admin mode character filtering logic:
  // - If admin provides BOTH character_id + actor_character_id: use character_id (explicit filter)
  // - If admin provides ONLY character_id (no actor_character_id): assume auto-injected, ignore it
  // - If admin provides neither: no character filter (see all events)
  // Non-admin mode: Use character_id or fall back to actor_character_id
  let resolvedCharacterId: string | null;
  if (isAdmin) {
    // Admin mode: Only use character_id if actor_character_id is also present (explicit filter)
    // If only character_id is present (no actor_character_id), it was likely auto-injected
    resolvedCharacterId = (characterId && actorCharacterId) ? characterId : null;
  } else {
    // Non-admin mode: Use character_id or fall back to actor_character_id
    resolvedCharacterId = characterId ?? actorCharacterId ?? null;
  }
  const queryCharacterId = corporationId ? null : resolvedCharacterId;

  let corporationMemberIds: string[] | null = null;
  if (corporationId) {
    corporationMemberIds = await loadCorporationMemberIds(supabase, corporationId);
    if (!corporationMemberIds.length) {
      return { events: [], count: 0, truncated: false, scope: effectiveScope };
    }
  }

  const { events, truncated } = await fetchEvents({
    supabase,
    start,
    end,
    sector: sectorFilter,
    stringMatch,
    limit: maxRows,
    sortDirection,
    queryCharacterId,
    corporationMemberIds,
  });

  return {
    events,
    count: events.length,
    truncated,
    scope: effectiveScope,
  };
}

async function fetchEvents(options: {
  supabase: SupabaseClient;
  start: Date;
  end: Date;
  sector: number | null;
  stringMatch: string | null;
  limit: number;
  sortDirection: 'forward' | 'reverse';
  queryCharacterId: string | null;
  corporationMemberIds: string[] | null;
}): Promise<{ events: JsonRecord[]; truncated: boolean }> {
  const {
    supabase,
    start,
    end,
    sector,
    stringMatch,
    limit,
    sortDirection,
    queryCharacterId,
    corporationMemberIds,
  } = options;

  const ascending = sortDirection === 'forward';
  const dbLimit = stringMatch ? MAX_QUERY_RESULTS + 1 : Math.min(limit + 1, MAX_QUERY_RESULTS + 1);

  let query;
  const isAdminMode = !queryCharacterId && !corporationMemberIds;

  if (isAdminMode) {
    // Admin mode: Query events directly without recipient filtering
    query = supabase
      .from('events')
      .select('timestamp,direction,event_type,character_id,sender_id,sector_id,ship_id,request_id,payload,meta')
      .gte('timestamp', start.toISOString())
      .lte('timestamp', end.toISOString())
      .order('timestamp', { ascending })
      .limit(dbLimit);
  } else {
    // Character/Corporation mode: JOIN to event_character_recipients for visibility
    query = supabase
      .from('events')
      .select(`
        timestamp,
        direction,
        event_type,
        character_id,
        sender_id,
        sector_id,
        ship_id,
        request_id,
        payload,
        meta,
        event_character_recipients!inner(character_id, reason)
      `)
      .gte('timestamp', start.toISOString())
      .lte('timestamp', end.toISOString())
      .order('timestamp', { ascending })
      .limit(dbLimit);

    // Filter by recipient character_id or corporation member IDs
    if (corporationMemberIds && corporationMemberIds.length) {
      query = query.in('event_character_recipients.character_id', corporationMemberIds);
    } else if (queryCharacterId) {
      query = query.eq('event_character_recipients.character_id', queryCharacterId);
    }
  }

  if (sector !== null) {
    query = query.eq('sector_id', sector);
  }

  const { data, error } = await query;
  if (error) {
    console.error('event_query.query', error);
    throw new EventQueryError('failed to query events', 500);
  }

  const rows: EventRow[] = Array.isArray(data) ? (data as EventRow[]) : [];

  // Collect all character IDs for name lookup: senders, receivers, and joined recipients
  const allCharacterIds = rows.flatMap((row) => {
    const ids = [row.sender_id, row.character_id];
    if (row.event_character_recipients) {
      const recipients = Array.isArray(row.event_character_recipients)
        ? row.event_character_recipients
        : [row.event_character_recipients];
      ids.push(...recipients.map(r => r.character_id));
    }
    return ids;
  });

  const senderLookup = await loadCharacterNames(supabase, allCharacterIds);
  const filteredRows = stringMatch ? filterRowsByString(rows, stringMatch) : rows;
  const truncated = filteredRows.length > limit;
  const sliced = truncated ? filteredRows.slice(0, limit) : filteredRows;
  const events = sliced.map((row) => buildEventRecord(row, senderLookup));
  return { events, truncated };
}

function buildEventRecord(row: EventRow, nameLookup: Map<string, string>): JsonRecord {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : null;
  const corporationId = meta && typeof meta['corporation_id'] === 'string' ? (meta['corporation_id'] as string) : null;
  const senderId = typeof row.sender_id === 'string' ? row.sender_id : null;

  // Extract receiver ID from joined event_character_recipients if available
  let receiverId: string | null = null;
  if (row.event_character_recipients) {
    const recipients = Array.isArray(row.event_character_recipients)
      ? row.event_character_recipients
      : [row.event_character_recipients];
    receiverId = recipients.length > 0 ? recipients[0].character_id : null;
  } else {
    // Fallback to events.character_id for admin mode queries
    receiverId = typeof row.character_id === 'string' ? row.character_id : null;
  }

  return {
    timestamp: row.timestamp,
    direction: row.direction,
    event: row.event_type,
    payload,
    sender: senderId ? nameLookup.get(senderId) ?? senderId : null,
    receiver: receiverId ? nameLookup.get(receiverId) ?? receiverId : null,
    sector: row.sector_id,
    corporation_id: corporationId,
    meta,
  };
}

async function loadCharacterNames(
  supabase: SupabaseClient,
  candidates: Array<string | null>,
): Promise<Map<string, string>> {
  const unique = Array.from(
    new Set(
      candidates
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );
  if (!unique.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('characters')
    .select('character_id,name')
    .in('character_id', unique);
  if (error) {
    console.error('event_query.loadCharacterNames', error);
    return new Map();
  }

  const map = new Map<string, string>();
  for (const entry of data ?? []) {
    const characterId = typeof entry.character_id === 'string' ? entry.character_id : null;
    const name = typeof entry.name === 'string' ? entry.name : null;
    if (characterId && name) {
      map.set(characterId, name);
    }
  }
  return map;
}

function parseTimestamp(value: unknown, label: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EventQueryError(`Missing ${label}`);
  }
  const raw = value.trim();
  const normalized = ensureTimezone(raw);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new EventQueryError(`Invalid ${label} format`);
  }
  return parsed;
}

function ensureTimezone(value: string): string {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    return value;
  }
  return `${value}Z`;
}

function enforceInteger(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new EventQueryError(`${label} must be a number`);
  }
  if (!Number.isInteger(value)) {
    throw new EventQueryError(`${label} must be an integer`);
  }
  return value;
}

function clampQueryLimit(value: number): number {
  if (value <= 0) {
    throw new EventQueryError('max_rows must be positive');
  }
  if (value > MAX_QUERY_RESULTS) {
    throw new EventQueryError(`max_rows cannot exceed ${MAX_QUERY_RESULTS}`);
  }
  return value;
}

function normalizeSortDirection(value: string | null): 'forward' | 'reverse' {
  if (!value) {
    return 'forward';
  }
  const normalized = value.toLowerCase();
  if (normalized === 'forward' || normalized === 'reverse') {
    return normalized;
  }
  throw new EventQueryError("sort_direction must be 'forward' or 'reverse'");
}

function normalizeScope(value: string | null): 'personal' | 'corporation' {
  if (!value) {
    return 'personal';
  }
  const normalized = value.toLowerCase();
  if (normalized === 'personal' || normalized === 'corporation') {
    return normalized;
  }
  throw new EventQueryError("event_scope must be 'personal' or 'corporation'");
}

async function validateAdminPassword(candidate: unknown): Promise<boolean> {
  if (!ADMIN_PASSWORD && !ADMIN_PASSWORD_HASH) {
    return true;
  }
  if (typeof candidate !== 'string') {
    return false;
  }
  if (ADMIN_PASSWORD) {
    return safeEqual(candidate, ADMIN_PASSWORD);
  }
  if (ADMIN_PASSWORD_HASH) {
    const hash = await sha256Hex(candidate);
    return safeEqual(hash, ADMIN_PASSWORD_HASH);
  }
  return false;
}

function safeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch (_err) {
    return false;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function fetchCharacterCorporationId(
  supabase: SupabaseClient,
  characterId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('characters')
    .select('corporation_id')
    .eq('character_id', characterId)
    .maybeSingle();

  if (error) {
    console.error('event_query.actor_corp', error);
    throw new EventQueryError('failed to load actor context', 500);
  }

  return data?.corporation_id ?? null;
}

async function loadCorporationMemberIds(
  supabase: SupabaseClient,
  corporationId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('characters')
    .select('character_id')
    .eq('corporation_id', corporationId);

  if (error) {
    console.error('event_query.corp_members', error);
    throw new EventQueryError('failed to load corporation members', 500);
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return (data as Array<{ character_id: string }>).map((row) => row.character_id);
}

function filterRowsByString(rows: EventRow[], needle: string): EventRow[] {
  if (!needle) {
    return rows;
  }
  const upperBound = MAX_QUERY_RESULTS;
  const filtered: EventRow[] = [];
  for (const row of rows) {
    if (rowMatchesNeedle(row, needle)) {
      filtered.push(row);
    }
    if (filtered.length >= upperBound) {
      break;
    }
  }
  return filtered;
}

function rowMatchesNeedle(row: EventRow, needle: string): boolean {
  try {
    const payload = row.payload ?? {};
    const serialized = JSON.stringify(payload);
    return serialized.includes(needle);
  } catch (_err) {
    return false;
  }
}
