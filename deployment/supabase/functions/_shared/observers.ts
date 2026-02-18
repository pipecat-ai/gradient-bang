import type { SupabaseClient } from "@supabase/supabase-js";

import {
  emitCharacterEvent,
  EventSource,
  recordEventWithRecipients,
} from "./events.ts";
import type { VisibilityCharacterRow } from "./visibility.ts";
import { dedupeRecipientSnapshots, loadGarrisonContext } from "./visibility.ts";

type CharacterRow = VisibilityCharacterRow;

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
  corpId?: string | null;
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
    .from("ship_instances")
    .select("owner_character_id, owner_id, owner_type")
    .eq("current_sector", sectorId)
    .eq("in_hyperspace", false)
    .or("owner_character_id.not.is.null,owner_type.eq.character");
  if (error) {
    console.error("observers.list.error", { sectorId, error });
    return [];
  }
  if (!data || data.length === 0) {
    return [];
  }
  const observers: string[] = [];
  for (const row of data as SectorObserverRow[]) {
    const charId =
      row.owner_character_id ??
      (row.owner_type === "character" ? row.owner_id : null);
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
  movement: "depart" | "arrive",
  source?: EventSource,
  options?: BuildCharacterMovedPayloadOptions,
): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const moveType = options?.moveType ?? "normal";
  const extraFields = options?.extraFields;
  const payload: Record<string, unknown> = {
    player: {
      id: metadata.characterId,
      name: metadata.characterName,
    },
    ship: {
      ship_id: metadata.shipId,
      ship_name: metadata.shipName,
      ship_type: metadata.shipType,
    },
    timestamp,
    move_type: moveType,
    movement,
    name: metadata.characterName,
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
  actorCharacterId,
  corpId,
}: {
  supabase: SupabaseClient;
  observers: string[];
  payload: Record<string, unknown>;
  sectorId: number;
  requestId?: string;
  actorCharacterId: string;
  corpId?: string | null;
}): Promise<void> {
  const recipients = dedupeRecipientSnapshots(
    observers.map((observerId) => ({
      characterId: observerId,
      reason: "sector_snapshot",
    })),
  );
  if (!recipients.length) {
    return;
  }

  await recordEventWithRecipients({
    supabase,
    eventType: "character.moved",
    scope: "sector",
    payload,
    requestId,
    sectorId,
    actorCharacterId,
    corpId: corpId ?? null,
    recipients,
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
  const { garrisons, ownerMap, membersByCorp } = await loadGarrisonContext(
    supabase,
    sectorId,
  );
  if (!garrisons.length) {
    return 0;
  }

  let delivered = 0;
  for (const garrison of garrisons) {
    const ownerId = garrison.owner_id as string | null;
    if (!ownerId) {
      continue;
    }
    const owner = ownerMap.get(ownerId);
    if (!owner) {
      continue;
    }
    const corpMembers = owner.corporation_id
      ? (membersByCorp.get(owner.corporation_id) ?? [])
      : [];
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

    const recipientSnapshots = dedupeRecipientSnapshots(
      recipients.map((characterId) => ({
        characterId,
        reason:
          characterId === owner.character_id
            ? "garrison_owner"
            : "garrison_corp_member",
      })),
    );
    if (!recipientSnapshots.length) {
      continue;
    }

    await recordEventWithRecipients({
      supabase,
      eventType: "garrison.character_moved",
      scope: "sector",
      payload: eventPayload,
      requestId,
      sectorId,
      actorCharacterId: owner.character_id,
      corpId: owner.corporation_id ?? null,
      recipients: recipientSnapshots,
    });
    delivered += recipients.length;
  }

  return delivered;
}
