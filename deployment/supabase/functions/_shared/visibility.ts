import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface EventRecipientSnapshot {
  characterId: string;
  reason: string;
}

export interface VisibilityCharacterRow {
  character_id: string;
  name: string;
  corporation_id: string | null;
}

interface GarrisonRow {
  owner_id: string | null;
  fighters: number;
  mode: string;
  toll_amount: number;
  deployed_at: string;
}

export interface GarrisonContext {
  garrisons: GarrisonRow[];
  ownerMap: Map<string, VisibilityCharacterRow>;
  membersByCorp: Map<string, string[]>;
}

export function dedupeRecipientSnapshots(recipients: EventRecipientSnapshot[]): EventRecipientSnapshot[] {
  if (!recipients.length) {
    return [];
  }
  const seen = new Set<string>();
  const deduped: EventRecipientSnapshot[] = [];
  for (const recipient of recipients) {
    const characterId = typeof recipient.characterId === 'string' ? recipient.characterId.trim() : '';
    const reason = typeof recipient.reason === 'string' ? recipient.reason.trim() : '';
    if (!characterId || !reason) {
      continue;
    }
    if (seen.has(characterId)) {
      continue;
    }
    seen.add(characterId);
    deduped.push({ characterId, reason });
  }
  return deduped;
}

export async function computeSectorVisibilityRecipients(
  supabase: SupabaseClient,
  sectorId: number,
  exclude: string[] = [],
): Promise<EventRecipientSnapshot[]> {
  const excludeSet = new Set<string>(exclude.filter((value) => typeof value === 'string' && value.length > 0));
  const snapshots: EventRecipientSnapshot[] = [];

  const shipObservers = await loadSectorShipObservers(supabase, sectorId);
  for (const observerId of shipObservers) {
    if (excludeSet.has(observerId)) {
      continue;
    }
    snapshots.push({ characterId: observerId, reason: 'sector_snapshot' });
  }

  const garrisonContext = await loadGarrisonContext(supabase, sectorId);
  for (const garrison of garrisonContext.garrisons) {
    const ownerId = typeof garrison.owner_id === 'string' ? garrison.owner_id : null;
    if (ownerId && !excludeSet.has(ownerId)) {
      snapshots.push({ characterId: ownerId, reason: 'garrison_owner' });
    }

    if (!ownerId) {
      continue;
    }
    const owner = garrisonContext.ownerMap.get(ownerId);
    if (!owner || !owner.corporation_id) {
      continue;
    }
    const corpMembers = garrisonContext.membersByCorp.get(owner.corporation_id) ?? [];
    for (const memberId of corpMembers) {
      if (!memberId || memberId === ownerId || excludeSet.has(memberId)) {
        continue;
      }
      snapshots.push({ characterId: memberId, reason: 'garrison_corp_member' });
    }
  }

  return dedupeRecipientSnapshots(snapshots);
}

export async function loadGarrisonContext(supabase: SupabaseClient, sectorId: number): Promise<GarrisonContext> {
  const { data: garrisons, error } = await supabase
    .from('garrisons')
    .select('owner_id, fighters, mode, toll_amount, deployed_at')
    .eq('sector_id', sectorId);
  if (error) {
    console.error('visibility.garrisons.load', { sectorId, error });
    return {
      garrisons: [],
      ownerMap: new Map(),
      membersByCorp: new Map(),
    };
  }

  const garrisonRows: GarrisonRow[] = Array.isArray(garrisons) ? (garrisons as GarrisonRow[]) : [];
  const ownerIds = Array.from(
    new Set(
      garrisonRows
        .map((row) => row.owner_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );

  const ownerMap = new Map<string, VisibilityCharacterRow>();
  const corpIds = new Set<string>();
  if (ownerIds.length) {
    const { data: ownerRows, error: ownerError } = await supabase
      .from('characters')
      .select('character_id, name, corporation_id')
      .in('character_id', ownerIds);
    if (ownerError) {
      console.error('visibility.garrisons.owners', ownerError);
    } else if (Array.isArray(ownerRows)) {
      for (const row of ownerRows as VisibilityCharacterRow[]) {
        ownerMap.set(row.character_id, row);
        if (row.corporation_id) {
          corpIds.add(row.corporation_id);
        }
      }
    }
  }

  const membersByCorp = new Map<string, string[]>();
  if (corpIds.size) {
    const corpIdList = Array.from(corpIds);
    const { data: corpMembers, error: memberError } = await supabase
      .from('characters')
      .select('character_id, corporation_id')
      .in('corporation_id', corpIdList);
    if (memberError) {
      console.error('visibility.garrisons.corpMembers', memberError);
    } else if (Array.isArray(corpMembers)) {
      for (const row of corpMembers as Array<{ character_id: string; corporation_id: string | null }>) {
        if (!row.corporation_id || typeof row.character_id !== 'string') {
          continue;
        }
        const list = membersByCorp.get(row.corporation_id) ?? [];
        list.push(row.character_id);
        membersByCorp.set(row.corporation_id, list);
      }
    }
  }

  return {
    garrisons: garrisonRows,
    ownerMap,
    membersByCorp,
  };
}

async function loadSectorShipObservers(supabase: SupabaseClient, sectorId: number): Promise<string[]> {
  const { data, error } = await supabase
    .from('ship_instances')
    .select('owner_character_id')
    .eq('current_sector', sectorId)
    .eq('in_hyperspace', false);
  if (error) {
    console.error('visibility.sector.ships', { sectorId, error });
    return [];
  }
  const rows = Array.isArray(data) ? data : [];
  const ids = rows
    .map((row) => row?.owner_character_id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return Array.from(new Set(ids));
}

/**
 * Compute recipients who are members of the given corporation(s).
 * Uses corporation_members table to get active members.
 */
export async function computeCorpMemberRecipients(
  supabase: SupabaseClient,
  corpIds: string[],
  excludeCharacterIds: string[] = [],
): Promise<EventRecipientSnapshot[]> {
  if (!corpIds.length) {
    return [];
  }
  const excludeSet = new Set(excludeCharacterIds);
  const recipients: EventRecipientSnapshot[] = [];
  const uniqueCorpIds = Array.from(new Set(corpIds));

  const { data, error } = await supabase
    .from('corporation_members')
    .select('character_id, corp_id')
    .in('corp_id', uniqueCorpIds)
    .is('left_at', null);

  if (error) {
    console.error('visibility.corp_members.load', { corpIds: uniqueCorpIds, error });
    return [];
  }

  for (const row of data ?? []) {
    const memberId = row?.character_id;
    if (!memberId || excludeSet.has(memberId)) {
      continue;
    }
    recipients.push({ characterId: memberId, reason: 'corp_member' });
  }

  return dedupeRecipientSnapshots(recipients);
}

/**
 * Unified helper for computing all event recipients with deduplication.
 * Combines sector observers, corp members, and direct recipients.
 */
export async function computeEventRecipients(options: {
  supabase: SupabaseClient;
  sectorId?: number;
  corpIds?: string[];
  directRecipients?: string[];
  excludeCharacterIds?: string[];
}): Promise<EventRecipientSnapshot[]> {
  const {
    supabase,
    sectorId,
    corpIds = [],
    directRecipients = [],
    excludeCharacterIds = [],
  } = options;

  const allRecipients: EventRecipientSnapshot[] = [];

  // Add direct recipients (e.g., combat participants)
  for (const id of directRecipients) {
    if (id) {
      allRecipients.push({ characterId: id, reason: 'direct' });
    }
  }

  // Add sector observers (if sectorId provided)
  if (sectorId !== undefined) {
    const sectorRecipients = await computeSectorVisibilityRecipients(supabase, sectorId, excludeCharacterIds);
    allRecipients.push(...sectorRecipients);
  }

  // Add corp members
  const corpRecipients = await computeCorpMemberRecipients(supabase, corpIds, excludeCharacterIds);
  allRecipients.push(...corpRecipients);

  return dedupeRecipientSnapshots(allRecipients);
}
