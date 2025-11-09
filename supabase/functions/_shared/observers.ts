import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { emitCharacterEvent, emitSectorEvent, EventSource } from './events.ts';

interface CharacterRow {
  character_id: string;
  name: string;
  corporation_id: string | null;
}

interface SectorObserverRow {
  owner_character_id: string | null;
  owner_id: string | null;
  owner_type: string | null;
}

export interface ObserverMetadata {
  characterId: string;
  characterName: string;
  shipId: string;
  shipName: string;
  shipType: string;
}

export interface BuildCharacterMovedPayloadOptions {
  moveType?: string;
  extraFields?: Record<string, unknown>;
}

export async function listSectorObservers(
  supabase: SupabaseClient,
  sectorId: number,
  exclude: string[] = [],
): Promise<string[]> {
  const excludeSet = new Set(exclude);
  const { data, error } = await supabase
    .from('ship_instances')
    .select('owner_character_id, owner_id, owner_type')
    .eq('current_sector', sectorId)
    .eq('in_hyperspace', false)
    .or('owner_character_id.not.is.null,owner_type.eq.character');
  if (error) {
    console.error('observers.list.error', { sectorId, error });
    return [];
  }
  if (!data || data.length === 0) {
    return [];
  }
  const observers: string[] = [];
  for (const row of data as SectorObserverRow[]) {
    const charId = row.owner_character_id ?? (row.owner_type === 'character' ? row.owner_id : null);
    if (!charId || excludeSet.has(charId)) {
      continue;
    }
    if (!observers.includes(charId)) {
      observers.push(charId);
    }
  }
  return observers;
}

export function buildCharacterMovedPayload(
  metadata: ObserverMetadata,
  movement: 'depart' | 'arrive',
  source?: EventSource,
  options?: BuildCharacterMovedPayloadOptions,
): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const moveType = options?.moveType ?? 'normal';
  const extraFields = options?.extraFields;
  const payload: Record<string, unknown> = {
    player: {
      id: metadata.characterId,
      name: metadata.characterName,
    },
    ship: {
      ship_name: metadata.shipName,
      ship_type: metadata.shipType,
    },
    timestamp,
    move_type: moveType,
    movement,
    name: metadata.characterName,
    ship_type: metadata.shipType,
  };
  if (source) {
    payload.source = source;
  }
  if (extraFields && Object.keys(extraFields).length) {
    Object.assign(payload, extraFields);
  }
  return payload;
}

export async function emitCharacterMovedEvents({
  supabase,
  observers,
  payload,
  sectorId,
  requestId,
}: {
  supabase: SupabaseClient;
  observers: string[];
  payload: Record<string, unknown>;
  sectorId: number;
  requestId?: string;
}): Promise<void> {
  if (!observers.length) {
    return;
  }

  await Promise.all(
    observers.map((observerId) =>
      emitCharacterEvent({
        supabase,
        characterId: observerId,
        eventType: 'character.moved',
        payload,
        sectorId,
        requestId,
      }),
    ),
  );

  await emitSectorEvent({
    supabase,
    sectorId,
    eventType: 'character.moved',
    payload,
    requestId,
  });
}

export async function emitGarrisonCharacterMovedEvents({
  supabase,
  sectorId,
  payload,
  requestId,
}: {
  supabase: SupabaseClient;
  sectorId: number;
  payload: Record<string, unknown>;
  requestId?: string;
}): Promise<number> {
  const { data: garrisons, error } = await supabase
    .from('garrisons')
    .select('owner_id, fighters, mode, toll_amount, deployed_at')
    .eq('sector_id', sectorId);
  if (error) {
    console.error('garrison.observer.list', { sectorId, error });
    return 0;
  }
  if (!garrisons || garrisons.length === 0) {
    return 0;
  }

  const ownerIds = Array.from(
    new Set(
      garrisons
        .map((row) => row.owner_id as string | null)
        .filter((value): value is string => typeof value === 'string'),
    ),
  );
  if (!ownerIds.length) {
    return 0;
  }

  const { data: ownerRows, error: ownerError } = await supabase
    .from('characters')
    .select('character_id, name, corporation_id')
    .in('character_id', ownerIds);
  if (ownerError) {
    console.error('garrison.observer.loadOwners', ownerError);
    return 0;
  }
  if (!ownerRows || ownerRows.length === 0) {
    return 0;
  }

  const ownerMap = new Map<string, CharacterRow>();
  const corpIds = new Set<string>();
  for (const row of ownerRows as CharacterRow[]) {
    ownerMap.set(row.character_id, row);
    if (row.corporation_id) {
      corpIds.add(row.corporation_id);
    }
  }

  const corpIdList = Array.from(corpIds);
  const membersByCorp = new Map<string, string[]>();
  if (corpIdList.length) {
    const { data: corpMembers, error: memberError } = await supabase
      .from('characters')
      .select('character_id, corporation_id')
      .in('corporation_id', corpIdList);
    if (memberError) {
      console.error('garrison.observer.loadMembers', memberError);
    } else if (corpMembers) {
      for (const row of corpMembers as CharacterRow[]) {
        if (!row.corporation_id) {
          continue;
        }
        const existing = membersByCorp.get(row.corporation_id) ?? [];
        existing.push(row.character_id);
        membersByCorp.set(row.corporation_id, existing);
      }
    }
  }

  let delivered = 0;
  for (const garrison of garrisons) {
    const ownerId = garrison.owner_id as string | null;
    if (!ownerId) {
      continue;
    }
    const owner = ownerMap.get(ownerId);
    if (!owner || !owner.corporation_id) {
      continue;
    }
    const corpMembers = membersByCorp.get(owner.corporation_id) ?? [];
    const recipients = Array.from(new Set([ownerId, ...corpMembers]));
    if (!recipients.length) {
      continue;
    }

    const garrisonPayload = {
      owner_id: owner.character_id,
      owner_name: owner.name,
      corporation_id: owner.corporation_id,
      fighters: garrison.fighters,
      mode: garrison.mode,
      toll_amount: garrison.toll_amount,
      deployed_at: garrison.deployed_at,
    };

    const eventPayload = { ...payload, garrison: garrisonPayload };

    await Promise.all(
      recipients.map((characterId) =>
        emitCharacterEvent({
          supabase,
          characterId,
          eventType: 'garrison.character_moved',
          payload: eventPayload,
          sectorId,
          requestId,
        }),
      ),
    );
    delivered += recipients.length;
  }

  return delivered;
}
