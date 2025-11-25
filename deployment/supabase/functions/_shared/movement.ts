import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import type { EventSource } from './events.ts';
import {
  buildCharacterMovedPayload,
  emitCharacterMovedEvents,
  emitGarrisonCharacterMovedEvents,
  listSectorObservers,
  type ObserverMetadata,
} from './observers.ts';

export interface MovementObserverOptions {
  supabase: SupabaseClient;
  sectorId: number;
  metadata: ObserverMetadata;
  movement: 'depart' | 'arrive';
  source?: EventSource;
  requestId?: string;
  excludeCharacterIds?: string[];
  moveType?: string;
  extraPayload?: Record<string, unknown>;
  includeGarrisons?: boolean;
}

export interface MovementObserverResult {
  characterObservers: number;
  garrisonRecipients: number;
}

export async function emitMovementObservers(options: MovementObserverOptions): Promise<MovementObserverResult> {
  const {
    supabase,
    sectorId,
    metadata,
    movement,
    source,
    requestId,
    excludeCharacterIds,
    moveType,
    extraPayload,
    includeGarrisons = true,
  } = options;

  const exclude = new Set<string>([metadata.characterId]);
  if (excludeCharacterIds) {
    for (const id of excludeCharacterIds) {
      if (id) {
        exclude.add(id);
      }
    }
  }

  const observers = await listSectorObservers(supabase, sectorId, Array.from(exclude));
  const payload = buildCharacterMovedPayload(metadata, movement, source, {
    moveType,
    extraFields: extraPayload,
  });

  if (observers.length) {
    await emitCharacterMovedEvents({
      supabase,
      observers,
      payload,
      sectorId,
      requestId,
      actorCharacterId: metadata.characterId,
    });
  }

  const garrisonRecipients = includeGarrisons
    ? await emitGarrisonCharacterMovedEvents({
        supabase,
        sectorId,
        payload,
        requestId,
      })
    : 0;

  if (observers.length || garrisonRecipients > 0) {
    console.log('movement.observers.emitted', {
      sector_id: sectorId,
      movement,
      character_id: metadata.characterId,
      character_observers: observers.length,
      garrison_recipients: garrisonRecipients,
      request_id: requestId,
    });
  }

  return {
    characterObservers: observers.length,
    garrisonRecipients,
  };
}
