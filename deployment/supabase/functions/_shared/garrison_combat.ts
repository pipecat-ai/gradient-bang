/**
 * Garrison Auto-Combat Logic
 *
 * Handles automatic combat initiation when a character arrives in a sector with garrisons.
 * Only offensive and toll mode garrisons trigger auto-combat. Defensive garrisons do not.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CharacterRow, ShipRow } from "./status.ts";
import { loadCharacter, loadShip } from "./status.ts";
import {
  loadCharacterCombatants,
  loadCharacterNames,
  loadGarrisonCombatants,
} from "./combat_participants.ts";
import { getEffectiveCorporationId } from "./corporations.ts";
import { loadCombatForSector, persistCombatState } from "./combat_state.ts";
import type { WeaveSpan } from "./weave.ts";
import {
  nowIso,
  type CombatEncounterState,
  type CombatantState,
} from "./combat_types.ts";
import {
  buildRoundWaitingPayload,
  getCorpIdsFromParticipants,
  collectParticipantIds,
} from "./combat_events.ts";
import { computeNextCombatDeadline } from "./combat_resolution.ts";
import { buildEventSource, recordBroadcastByCorp } from "./events.ts";
import { computeEventRecipients } from "./visibility.ts";
import { loadUniverseMeta, isFedspaceSector } from "./fedspace.ts";

const MIN_PARTICIPANTS = 2;

function deterministicSeed(combatId: string): number {
  const normalized =
    combatId.replace(/[^0-9a-f]/gi, "").slice(0, 12) || combatId;
  const parsed = Number.parseInt(normalized, 16);
  if (Number.isFinite(parsed)) {
    return parsed >>> 0;
  }
  return Math.floor(Math.random() * 1_000_000);
}

function generateCombatId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Check if there are auto-engaging garrisons in a sector and initiate combat if needed.
 *
 * Returns true if combat was initiated, false otherwise.
 */
export async function checkGarrisonAutoEngage(params: {
  supabase: SupabaseClient;
  characterId: string;
  sectorId: number;
  requestId: string;
  character?: CharacterRow;
  ship?: ShipRow;
  parentSpan?: WeaveSpan;
}): Promise<boolean> {
  const noopSpan: WeaveSpan = { span() { return noopSpan; }, end() {} };
  const ws = params.parentSpan ?? noopSpan;
  const { supabase, characterId, sectorId, requestId } = params;

  const sFedspace = ws.span("check_fedspace");
  const universeMeta = await loadUniverseMeta(supabase);
  if (await isFedspaceSector(supabase, sectorId, universeMeta)) {
    sFedspace.end({ fedspace: true });
    return false;
  }
  sFedspace.end({ fedspace: false });

  // Use pre-loaded character/ship or fetch via REST
  const sLoadCharShip = ws.span("load_character_ship");
  const character = params.character ?? await loadCharacter(supabase, characterId);
  const ship = params.ship ?? await loadShip(supabase, character.current_ship_id);
  sLoadCharShip.end({ preloaded: !!(params.character && params.ship) });

  if (ship.in_hyperspace) {
    return false;
  }

  // Load existing combat state
  const sCombat = ws.span("load_combat_state");
  const existingEncounter = await loadCombatForSector(supabase, sectorId);
  sCombat.end({ active: !!(existingEncounter && !existingEncounter.ended) });
  if (existingEncounter && !existingEncounter.ended) {
    return false;
  }

  // Load garrisons and participants in the sector
  const sLoadParticipants = ws.span("load_participants_and_garrisons");

  // Load combatants and garrison rows in parallel (independent queries)
  const sLoadCombatants = sLoadParticipants.span("load_character_combatants");
  const sLoadGarrisonRows = sLoadParticipants.span("load_garrison_rows");
  const [participantStates, garrisonResult] = await Promise.all([
    loadCharacterCombatants(supabase, sectorId).then((r) => {
      sLoadCombatants.end({ count: r.length });
      return r;
    }),
    supabase
      .from("garrisons")
      .select(
        "sector_id, owner_id, fighters, mode, toll_amount, toll_balance, deployed_at",
      )
      .eq("sector_id", sectorId)
      .then((r) => {
        sLoadGarrisonRows.end({ count: r.data?.length ?? 0 });
        return r;
      }),
  ]);

  if (garrisonResult.error) {
    console.error("garrison_combat.load_garrisons", garrisonResult.error);
    sLoadParticipants.end({ error: garrisonResult.error.message });
    return false;
  }

  const garrisonRows = (garrisonResult.data ?? []).filter(
    (row: any) => row.fighters > 0,
  );

  const characterIds = [
    ...participantStates.map(
      (state) => state.owner_character_id ?? state.combatant_id,
    ),
    ...garrisonRows.map((row: any) => row.owner_id),
  ];

  const sLoadNames = sLoadParticipants.span("load_character_names");
  const ownerNames = await loadCharacterNames(supabase, characterIds);
  sLoadNames.end({ count: Object.keys(ownerNames).length });

  const sLoadGarrisonCombatants = sLoadParticipants.span("load_garrison_combatants");
  const garrisons = await loadGarrisonCombatants(
    supabase,
    sectorId,
    ownerNames,
  );
  sLoadGarrisonCombatants.end({ count: garrisons.length });

  sLoadParticipants.end({
    participants: participantStates.length,
    garrisons: garrisons.length,
  });

  // Check if there are any auto-engaging garrisons
  const autoEngagingGarrisons = garrisons.filter((garrison) => {
    const mode = garrison.state.metadata?.mode as string | undefined;
    return mode === "offensive" || mode === "toll";
  });

  if (autoEngagingGarrisons.length === 0) {
    return false;
  }

  // Check corp affiliations — batch lookup instead of N+1
  const sCorpCheck = ws.span("check_corp_affiliations", {
    garrisonCount: autoEngagingGarrisons.length,
  });

  // Get character's effective corporation
  const charCorpId = await getEffectiveCorporationId(
    supabase,
    characterId,
    ship.ship_id,
  );

  // Collect unique garrison owner IDs that need corp lookups
  const ownerIdsToCheck: string[] = [];
  for (const garrison of autoEngagingGarrisons) {
    const ownerId = garrison.state.owner_character_id;
    if (!ownerId || ownerId === characterId) continue;
    if ((garrison.state.fighters ?? 0) <= 0) continue;
    ownerIdsToCheck.push(ownerId);
  }

  // Batch fetch corp IDs for all garrison owners at once
  let hasEnemyGarrison = false;
  if (ownerIdsToCheck.length > 0) {
    const ownerCorpMap = new Map<string, string | null>();
    for (const ownerId of ownerIdsToCheck) {
      if (!ownerCorpMap.has(ownerId)) {
        const corpId = await getEffectiveCorporationId(supabase, ownerId, ownerId);
        ownerCorpMap.set(ownerId, corpId);
      }
    }

    for (const ownerId of ownerIdsToCheck) {
      const ownerCorpId = ownerCorpMap.get(ownerId) ?? null;
      if (charCorpId && ownerCorpId === charCorpId) continue;
      hasEnemyGarrison = true;
      break;
    }
  }
  sCorpCheck.end({ charCorpId, hasEnemy: hasEnemyGarrison });

  if (!hasEnemyGarrison) {
    return false;
  }

  // Initiate combat automatically
  const sInitiate = ws.span("initiate_garrison_combat");
  await initiateGarrisonCombat({
    supabase,
    characterId,
    sectorId,
    participantStates,
    garrisons,
    requestId,
  });
  sInitiate.end();

  return true;
}

async function initiateGarrisonCombat(params: {
  supabase: SupabaseClient;
  characterId: string;
  sectorId: number;
  participantStates: CombatantState[];
  garrisons: Array<{ state: CombatantState; source: unknown }>;
  requestId: string;
}): Promise<void> {
  const {
    supabase,
    characterId,
    sectorId,
    participantStates,
    garrisons,
    requestId,
  } = params;

  // Build participants map
  const participants: Record<string, CombatantState> = {};
  for (const state of participantStates) {
    participants[state.combatant_id] = state;
  }
  for (const garrison of garrisons) {
    participants[garrison.state.combatant_id] = garrison.state;
  }

  if (Object.keys(participants).length < MIN_PARTICIPANTS) {
    console.warn("garrison_combat: Not enough participants for combat");
    return;
  }

  const combatId = generateCombatId();

  // Pre-populate toll registry for toll garrisons
  const tollRegistry: Record<string, unknown> = {};
  for (const garrison of garrisons) {
    const metadata = (garrison.state.metadata ?? {}) as Record<string, unknown>;
    const mode = String(metadata.mode ?? "offensive").toLowerCase();

    if (mode === "toll") {
      const garrisonId = garrison.state.combatant_id;
      tollRegistry[garrisonId] = {
        owner_id: garrison.state.owner_character_id,
        toll_amount: metadata.toll_amount ?? 0,
        toll_balance: metadata.toll_balance ?? 0,
        target_id: null, // Will be set by buildGarrisonActions
        paid: false,
        paid_round: null,
        demand_round: 1, // First round
      };
    }
  }

  const encounter: CombatEncounterState = {
    combat_id: combatId,
    sector_id: sectorId,
    round: 1,
    deadline: computeNextCombatDeadline(),
    participants,
    pending_actions: {},
    logs: [],
    context: {
      initiator: characterId,
      created_at: nowIso(),
      garrison_sources: garrisons.map((g) => g.source),
      auto_initiated: true, // Mark as auto-initiated for tracking
      toll_registry: tollRegistry, // Pre-populated for toll garrisons
    },
    awaiting_resolution: false,
    ended: false,
    end_state: null,
    base_seed: deterministicSeed(combatId),
    last_updated: nowIso(),
  };

  await persistCombatState(supabase, encounter);
  await emitRoundWaitingEvents(supabase, encounter, requestId);
}

async function emitRoundWaitingEvents(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  requestId: string,
): Promise<void> {
  const payload = buildRoundWaitingPayload(encounter);
  const source = buildEventSource("combat.round_waiting", requestId);
  payload.source = source;

  // Get direct participant IDs and corp IDs for visibility
  const directRecipients = collectParticipantIds(encounter);
  const corpIds = getCorpIdsFromParticipants(encounter.participants);

  // Compute ALL recipients: participants + sector observers + corp members (deduped)
  const allRecipients = await computeEventRecipients({
    supabase,
    sectorId: encounter.sector_id,
    corpIds,
    directRecipients,
  });

  if (allRecipients.length === 0) {
    return;
  }

  await recordBroadcastByCorp({
    supabase,
    eventType: "combat.round_waiting",
    scope: "sector",
    payload,
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null,
    recipients: allRecipients,
    stakeholderCorpIds: corpIds,
  });
}
