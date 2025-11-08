import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface EventInsert {
  direction: 'event_in' | 'event_out';
  event_type: string;
  character_id?: string | null;
  ship_id?: string | null;
  sector_id?: number | null;
  payload: Record<string, unknown>;
  sender_id?: string | null;
  receiver_id?: string | null;
}

export async function logEvent(supabase: SupabaseClient, event: EventInsert): Promise<void> {
  const { error } = await supabase.from('events').insert({
    direction: event.direction,
    event_type: event.event_type,
    character_id: event.character_id,
    ship_id: event.ship_id,
    sector: event.sector_id,
    payload: event.payload,
    sender_id: event.sender_id,
    receiver_id: event.receiver_id,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`failed to log event ${event.event_type}: ${error.message}`);
  }
}
