import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { computeSectorVisibilityRecipients, dedupeRecipientSnapshots, type EventRecipientSnapshot } from './visibility.ts';

type EventScope =
  | 'direct'
  | 'sector'
  | 'corp'
  | 'broadcast'
  | 'gm_broadcast'
  | 'self'
  | 'system'
  | 'admin';

export interface EventSource {
  type: string;
  method: string;
  request_id: string;
  timestamp: string;
}

export interface RecordEventWithRecipientsOptions {
  supabase: SupabaseClient;
  eventType: string;
  scope: EventScope;
  direction?: 'rpc_in' | 'event_out';
  payload: Record<string, unknown>;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  sectorId?: number | null;
  shipId?: string | null;
  characterId?: string | null;
  senderId?: string | null;
  actorCharacterId?: string | null;
  corpId?: string | null;
  recipients?: EventRecipientSnapshot[];
  broadcast?: boolean;
}

export async function recordEventWithRecipients(options: RecordEventWithRecipientsOptions): Promise<number | null> {
  const {
    supabase,
    eventType,
    scope,
    direction = 'event_out',
    payload,
    requestId,
    meta,
    sectorId,
    shipId,
    characterId,
    senderId,
    actorCharacterId,
    corpId,
    recipients = [],
    broadcast = false,
  } = options;

  const normalizedRecipients = dedupeRecipientSnapshots(recipients);
  if (!normalizedRecipients.length && !broadcast) {
    return null;
  }

  const recipientIds = normalizedRecipients.map((recipient) => recipient.characterId);
  const recipientReasons = normalizedRecipients.map((recipient) => recipient.reason);

  const { data, error } = await supabase.rpc('record_event_with_recipients', {
    p_event_type: eventType,
    p_direction: direction,
    p_scope: scope,
    p_actor_character_id: actorCharacterId ?? null,
    p_corp_id: corpId ?? null,
    p_sector_id: sectorId ?? null,
    p_ship_id: shipId ?? null,
    p_character_id: characterId ?? null,
    p_sender_id: senderId ?? null,
    p_payload: payload ?? {},
    p_meta: meta ?? null,
    p_request_id: requestId ?? null,
    p_recipients: recipientIds,
    p_reasons: recipientReasons,
    p_is_broadcast: broadcast,
  });

  if (error) {
    console.error('events.recordEventWithRecipients.rpc', { eventType, scope, error });
    throw new Error(`failed to record event ${eventType}: ${error.message}`);
  }

  // Parse the event_id from the RPC result
  let eventId: number | null = null;
  if (typeof data === 'number') {
    eventId = data;
  } else if (typeof data === 'string') {
    // PostgreSQL bigint may come back as string
    const parsed = parseInt(data, 10);
    if (!Number.isNaN(parsed)) {
      eventId = parsed;
    }
  } else if (data && typeof data === 'object' && 'record_event_with_recipients' in data) {
    // Direct SQL call returns { record_event_with_recipients: <value> }
    const val = (data as Record<string, unknown>).record_event_with_recipients;
    if (typeof val === 'number') {
      eventId = val;
    } else if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      if (!Number.isNaN(parsed)) {
        eventId = parsed;
      }
    }
  }

  if (eventId === null) {
    console.error('events.recordEventWithRecipients.unexpected_response', {
      eventType,
      scope,
      dataType: typeof data,
      data: data,
      recipientCount: recipientIds.length,
    });
  }

  return eventId;
}

export function buildEventSource(method: string, requestId: string, sourceType = 'rpc'): EventSource {
  return {
    type: sourceType,
    method,
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };
}

interface CharacterEventOptions {
  supabase: SupabaseClient;
  characterId: string;
  eventType: string;
  payload: Record<string, unknown>;
  senderId?: string | null;
  sectorId?: number | null;
  shipId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  corpId?: string | null;
  recipientReason?: string;
  additionalRecipients?: EventRecipientSnapshot[];
  actorCharacterId?: string | null;
  scope?: EventScope;
}

export async function emitCharacterEvent(options: CharacterEventOptions): Promise<void> {
  const {
    supabase,
    characterId,
    eventType,
    payload,
    senderId,
    sectorId,
    shipId,
    requestId,
    meta,
    corpId,
    recipientReason,
    additionalRecipients = [],
    actorCharacterId,
    scope,
  } = options;

  const recipients = dedupeRecipientSnapshots([
    { characterId, reason: recipientReason ?? 'direct' },
    ...additionalRecipients,
  ]);
  if (!recipients.length) {
    console.warn('emitCharacterEvent.no_recipients', { eventType, characterId });
    return;
  }

  const eventId = await recordEventWithRecipients({
    supabase,
    eventType,
    scope: scope ?? 'direct',
    payload,
    requestId,
    meta,
    corpId,
    sectorId,
    shipId,
    characterId,
    senderId,
    actorCharacterId: actorCharacterId ?? senderId ?? characterId,
    recipients,
  });

  if (eventId === null) {
    console.error('emitCharacterEvent.event_not_recorded', {
      eventType,
      characterId,
      recipientCount: recipients.length,
    });
  }
}

interface SectorEventOptions {
  supabase: SupabaseClient;
  sectorId: number;
  eventType: string;
  payload: Record<string, unknown>;
  senderId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
  recipients?: EventRecipientSnapshot[];
  actorCharacterId?: string | null;
  scope?: EventScope;
}

export async function emitSectorEvent(options: SectorEventOptions): Promise<number | null> {
  const {
    supabase,
    sectorId,
    eventType,
    payload,
    senderId,
    requestId,
    meta,
    recipients = [],
    actorCharacterId,
    scope = 'sector',
  } = options;

  const normalizedRecipients = dedupeRecipientSnapshots(recipients);
  if (!normalizedRecipients.length) {
    return null;
  }

  return await recordEventWithRecipients({
    supabase,
    eventType,
    scope,
    payload,
    requestId,
    meta,
    sectorId,
    senderId,
    actorCharacterId: actorCharacterId ?? null,
    recipients: normalizedRecipients,
  });
}

interface SectorEnvelopeOptions extends SectorEventOptions {
  excludeCharacterIds?: string[];
}

export async function emitSectorEnvelope(options: SectorEnvelopeOptions): Promise<void> {
  const { supabase, sectorId, excludeCharacterIds = [] } = options;
  const recipients = await computeSectorVisibilityRecipients(supabase, sectorId, excludeCharacterIds);
  await emitSectorEvent({ ...options, recipients });
}

export async function emitErrorEvent(
  supabase: SupabaseClient,
  params: { characterId: string; method: string; requestId: string; detail: string; status?: number },
): Promise<void> {
  const payload = {
    source: buildEventSource(params.method, params.requestId),
    endpoint: params.method,
    error: params.detail,
    status: params.status ?? 400,
  } as Record<string, unknown>;
  await emitCharacterEvent({
    supabase,
    characterId: params.characterId,
    eventType: 'error',
    payload,
    requestId: params.requestId,
    recipientReason: 'error',
  });
}
