import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { getObserverChannels } from './observer_registry.ts';

interface EventInsert {
  direction: 'event_in' | 'event_out';
  event_type: string;
  character_id?: string | null;
  ship_id?: string | null;
  sector_id?: number | null;
  payload: Record<string, unknown>;
  sender_id?: string | null;
  request_id?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface EventSource {
  type: string;
  method: string;
  request_id: string;
  timestamp: string;
}

const OBSERVER_DEBUG = (Deno.env.get('SUPABASE_OBSERVER_DEBUG') ?? '0').toLowerCase() === '1';

export function buildEventSource(method: string, requestId: string, sourceType = 'rpc'): EventSource {
  return {
    type: sourceType,
    method,
    request_id: requestId,
    timestamp: new Date().toISOString(),
  };
}

export async function logEvent(supabase: SupabaseClient, event: EventInsert): Promise<number | null> {
  const { data, error } = await supabase.from('events').insert({
    direction: event.direction,
    event_type: event.event_type,
    character_id: event.character_id ?? null,
    ship_id: event.ship_id ?? null,
    sector_id: event.sector_id ?? null,
    payload: event.payload,
    sender_id: event.sender_id ?? null,
    request_id: event.request_id ?? null,
    meta: event.meta ?? null,
    timestamp: new Date().toISOString(),
  }).select('id').single();

  if (error) {
    throw new Error(`failed to log event ${event.event_type}: ${error.message}`);
  }

  return data?.id ?? null;
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
}

export async function emitCharacterEvent(options: CharacterEventOptions): Promise<void> {
  const { supabase, characterId, eventType, payload, senderId, sectorId, shipId, requestId, meta } = options;
  const eventId = await logEvent(supabase, {
    direction: 'event_out',
    event_type: eventType,
    character_id: characterId,
    ship_id: shipId ?? null,
    sector_id: sectorId ?? null,
    payload,
    sender_id: senderId ?? null,
    request_id: requestId ?? null,
    meta: meta ?? null,
  });

  await publishRealtime(eventType, payload, [buildCharacterTopic(characterId)], eventId ?? undefined);

}

interface SectorEventOptions {
  supabase: SupabaseClient;
  sectorId: number;
  eventType: string;
  payload: Record<string, unknown>;
  senderId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function emitSectorEvent(options: SectorEventOptions): Promise<number | null> {
  const { supabase, sectorId, eventType, payload, senderId, requestId, meta } = options;
  const eventId = await logEvent(supabase, {
    direction: 'event_out',
    event_type: eventType,
    sector_id: sectorId,
    payload,
    sender_id: senderId ?? null,
    request_id: requestId ?? null,
    meta: meta ?? null,
  });

  await publishRealtime(eventType, payload, [buildSectorTopic(sectorId)], eventId ?? undefined);

  return eventId;
}

interface SectorEnvelopeOptions extends SectorEventOptions {}

export async function emitSectorEnvelope(options: SectorEnvelopeOptions): Promise<void> {
  const { supabase, sectorId, eventType, payload } = options;
  const eventId = await emitSectorEvent(options);
  const observerChannels = await getObserverChannels(supabase, sectorId);
  if (!observerChannels.length) {
    emitObserverDiagnostics({ eventType, sectorId, channels: [] });
    return;
  }

  const observerTopics = observerChannels.map((channel) => `observer:${channel}`);
  await publishRealtime(eventType, payload, observerTopics, eventId ?? undefined);
  emitObserverDiagnostics({ eventType, sectorId, channels: observerChannels });
}

export function emitObserverDiagnostics(params: {
  eventType: string;
  sectorId: number;
  channels: string[];
}): void {
  if (!OBSERVER_DEBUG) {
    return;
  }
  console.log('observer.broadcast', {
    event: params.eventType,
    sector: params.sectorId,
    channels: params.channels,
  });
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
  });
}

function buildCharacterTopic(characterId: string): string {
  return `public:character:${characterId}`;
}

function buildSectorTopic(sectorId: number): string {
  return `public:sector:${sectorId}`;
}

async function publishRealtime(
  eventType: string,
  payload: Record<string, unknown>,
  topics: string[],
  eventId?: number,
): Promise<void> {
  if (!topics.length) {
    return;
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const realtimeOverride = Deno.env.get('SUPABASE_REALTIME_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceKey) {
    return;
  }

  const baseUrl = realtimeOverride || supabaseUrl;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/realtime/v1/api/broadcast`;
  const errors: string[] = [];

  await Promise.all(
    topics.map(async (topic) => {
      const sanitizedTopic = sanitizeTopic(topic);
      if (!sanitizedTopic) {
        return;
      }
      const realtimeTopic = sanitizedTopic;
      const payloadCopy = typeof payload === 'object' && payload !== null ? { ...payload } : { value: payload };
      if (eventId !== undefined) {
        payloadCopy.__event_id = eventId;
      }

      try {
        debugRealtime('broadcast.attempt', { eventType, topic: sanitizedTopic });
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            messages: [
              {
                type: 'broadcast',
                topic: realtimeTopic,
                event: eventType,
                payload: payloadCopy,
                private: false,
              },
            ],
          }),
        });
        debugRealtime('broadcast.response', { eventType, topic: sanitizedTopic, status: response.status });

        if (!response.ok) {
          const detail = await response.text();
          const message = `failed to broadcast ${eventType} to ${sanitizedTopic}: ${response.status} ${detail}`;
          console.error('broadcast.error', message);
          errors.push(message);
        }
      } catch (error) {
        const message = `error broadcasting ${eventType} to ${sanitizedTopic}: ${error instanceof Error ? error.message : String(error)}`;
        console.error('broadcast.exception', message);
        errors.push(message);
      }
    }),
  );

  if (errors.length) {
    throw new Error(errors[0]);
  }
}

function sanitizeTopic(topic: string): string | null {
  const trimmed = topic.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('realtime:')) {
    return trimmed.slice('realtime:'.length);
  }
  return trimmed;
}

function debugRealtime(message: string, data?: Record<string, unknown>): void {
  if (Deno.env.get('SUPABASE_REALTIME_DEBUG') !== '1') {
    return;
  }
  if (data) {
    console.log(message, data);
  } else {
    console.log(message);
  }
}
