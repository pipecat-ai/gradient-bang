/**
 * Garrison Auto-Combat Logic
 *
 * Handles automatic combat initiation when a character arrives in a sector with garrisons.
 * Only offensive and toll mode garrisons trigger auto-combat. Defensive garrisons do not.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadCharacter, loadShip } from './status.ts';
import { loadCharacterCombatants, loadCharacterNames, loadGarrisonCombatants } from './combat_participants.ts';
import { getEffectiveCorporationId } from './corporations.ts';
import { loadCombatForSector, persistCombatState } from './combat_state.ts';
import { nowIso, type CombatEncounterState, type CombatantState } from './combat_types.ts';
import { buildRoundWaitingPayload, getCorpIdsFromParticipants, collectParticipantIds } from './combat_events.ts';
import { computeNextCombatDeadline } from './combat_resolution.ts';
import { buildEventSource, recordEventWithRecipients } from './events.ts';
import { computeEventRecipients } from './visibility.ts';

const MIN_PARTICIPANTS = 2;

function deterministicSeed(combatId: string): number {
  const normalized = combatId.replace(/[^0-9a-f]/gi, '').slice(0, 12) || combatId;
  const parsed = Number.parseInt(normalized, 16);
  if (Number.isFinite(parsed)) {
    return parsed >>> 0;
  }
  return Math.floor(Math.random() * 1_000_000);
}

function generateCombatId(): string {
  return crypto.randomUUID().replace(/-/g, '');
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
}): Promise<boolean> {
  const { supabase, characterId, sectorId, requestId } = params;

  // Check if character is already in combat
  const character = await loadCharacter(supabase, characterId);
  const ship = await loadShip(supabase, character.current_ship_id);

  if (ship.in_hyperspace) {
    return false;
  }

  // Load existing combat state
  const existingEncounter = await loadCombatForSector(supabase, sectorId);
  if (existingEncounter && !existingEncounter.ended) {
    // Already in combat, don't auto-initiate again
    return false;
  }

  // Load garrisons and participants in the sector
  const participantStates = await loadCharacterCombatants(supabase, sectorId);

  // First, load garrisons to get their owner IDs
  const { data: garrisonData, error: garrisonError } = await supabase
    .from('garrisons')
    .select('sector_id, owner_id, fighters, mode, toll_amount, toll_balance, deployed_at')
    .eq('sector_id', sectorId);

  if (garrisonError) {
    console.error('garrison_combat.load_garrisons', garrisonError);
    return false;
  }

  const garrisonRows = (garrisonData ?? []).filter((row: any) => row.fighters > 0);

  // Collect all character IDs we need to look up names for
  const characterIds = [
    ...participantStates.map((state) => state.owner_character_id ?? state.combatant_id),
    ...garrisonRows.map((row: any) => row.owner_id),
  ];

  const ownerNames = await loadCharacterNames(supabase, characterIds);
  const garrisons = await loadGarrisonCombatants(supabase, sectorId, ownerNames);

  // Check if there are any auto-engaging garrisons
  const autoEngagingGarrisons = garrisons.filter((garrison) => {
    const mode = garrison.state.metadata?.mode as string | undefined;
    // Only offensive and toll garrisons auto-engage, defensive do not
    return mode === 'offensive' || mode === 'toll';
  });

  if (autoEngagingGarrisons.length === 0) {
    return false; // No auto-engaging garrisons
  }

  // Get character's effective corporation (membership OR ship ownership for corp-owned ships)
  const charCorpId = await getEffectiveCorporationId(supabase, characterId, ship.ship_id);

  // Check if any garrison is not owned by same corporation
  let hasEnemyGarrison = false;
  for (const garrison of autoEngagingGarrisons) {
    const ownerId = garrison.state.owner_character_id;
    if (!ownerId || ownerId === characterId) continue;
    if ((garrison.state.fighters ?? 0) <= 0) continue;

    // Get garrison owner's corporation
    const { data: ownerCorpData } = await supabase
      .from('corporation_members')
      .select('corp_id')
      .eq('character_id', ownerId)
      .is('left_at', null)
      .maybeSingle();
    const ownerCorpId = ownerCorpData?.corp_id ?? null;

    // Skip if same corporation
    if (charCorpId && ownerCorpId === charCorpId) continue;

    hasEnemyGarrison = true;
    break;
  }

  if (!hasEnemyGarrison) {
    return false; // All garrisons are friendly (same corp)
  }

  // Initiate combat automatically
  await initiateGarrisonCombat({
    supabase,
    characterId,
    sectorId,
    participantStates,
    garrisons,
    requestId,
  });

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
  const { supabase, characterId, sectorId, participantStates, garrisons, requestId } = params;

  // Build participants map
  const participants: Record<string, CombatantState> = {};
  for (const state of participantStates) {
    participants[state.combatant_id] = state;
  }
  for (const garrison of garrisons) {
    participants[garrison.state.combatant_id] = garrison.state;
  }

  if (Object.keys(participants).length < MIN_PARTICIPANTS) {
    console.warn('garrison_combat: Not enough participants for combat');
    return;
  }

  const combatId = generateCombatId();

  // Pre-populate toll registry for toll garrisons
  const tollRegistry: Record<string, unknown> = {};
  for (const garrison of garrisons) {
    const metadata = (garrison.state.metadata ?? {}) as Record<string, unknown>;
    const mode = String(metadata.mode ?? 'offensive').toLowerCase();

    if (mode === 'toll') {
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
  const source = buildEventSource('combat.round_waiting', requestId);
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

  // Single emission to all unique recipients
  await recordEventWithRecipients({
    supabase,
    eventType: 'combat.round_waiting',
    scope: 'sector',
    payload,
    requestId,
    sectorId: encounter.sector_id,
    actorCharacterId: null, // System-originated
    recipients: allRecipients,
  });
}
