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
  buildCharacterCombatant,
  loadCharacterCombatants,
  loadCharacterNames,
  loadGarrisonCombatants,
} from "./combat_participants.ts";
import { areFriendlyFromMeta, buildCorporationMap } from "./friendly.ts";
import { getEffectiveCorporationId } from "./corporations.ts";
import {
  CombatStateConflictError,
  isResolvingLockHeld,
  loadCombatForSector,
  persistCombatState,
} from "./combat_state.ts";
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

  // Initiate combat automatically. Pass the loaded encounter's
  // last_updated (or null if no row) as the OCC fence — the persist below
  // uses CAS to detect a concurrent writer that beat us to creating
  // combat in this sector. On conflict initiateGarrisonCombat just logs
  // and bails; the next move arrival will see the now-active combat and
  // join via joinExistingCombat instead.
  const sInitiate = ws.span("initiate_garrison_combat");
  await initiateGarrisonCombat({
    supabase,
    characterId,
    sectorId,
    participantStates,
    garrisons,
    requestId,
    expectedLastUpdated: existingEncounter
      ? existingEncounter.last_updated
      : null,
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
  /** OCC fence captured at load — null when no prior combat row, last_updated of the prior (ended) encounter otherwise. */
  expectedLastUpdated?: string | null;
}): Promise<void> {
  const {
    supabase,
    characterId,
    sectorId,
    participantStates,
    garrisons,
    requestId,
    expectedLastUpdated,
  } = params;

  // Build participants map. Initial combatants do NOT get `joined_round`
  // — that field is reserved for mid-encounter joiners (set by
  // joinExistingCombat) and is what the action-submit / round-ready gates
  // use to lock joiners out of their join round. Initial round_waiting
  // marks everyone via the explicit `justJoinedIds` set instead.
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

  // CAS-protect against a concurrent writer (peer arrival, combat_initiate)
  // creating combat in this sector between our load and our write. On
  // conflict, log + bail — caller (`checkGarrisonAutoEngage`) returns true
  // upstream, but no combat events fire from this path. The losing
  // arrival is in the sector but not in the new winning combat; their
  // next action / arrival will route through `joinExistingCombat`.
  try {
    await persistCombatState(supabase, encounter, { expectedLastUpdated });
  } catch (err) {
    if (err instanceof CombatStateConflictError) {
      console.warn("garrison_combat.initiate.cas_conflict", {
        sector_id: sectorId,
      });
      return;
    }
    throw err;
  }
  // Initial round_waiting #1 marks every starting participant as just_joined
  // (they all "joined" at this round) so the LLM-facing XML annotates each
  // with `(joined encounter)` exactly once. Subsequent rounds drop the flag.
  const justJoinedIds = new Set<string>(Object.keys(encounter.participants));
  await emitRoundWaitingEvents(
    supabase,
    encounter,
    requestId,
    null,
    justJoinedIds,
  );
}

async function emitRoundWaitingEvents(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  requestId: string,
  extensionReason?:
    | {
        type: "joined";
        joiners: Array<{ combatant_id: string; name: string }>;
      }
    | null,
  justJoinedIds?: Set<string>,
): Promise<void> {
  const payload = buildRoundWaitingPayload(encounter, { justJoinedIds });
  const source = buildEventSource("combat.round_waiting", requestId);
  payload.source = source;
  if (extensionReason && extensionReason.joiners.length > 0) {
    payload.extension_reason = extensionReason;
  }

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

/**
 * Mid-encounter join: a hostile ship just arrived in a sector with an
 * active (`!ended`) combat encounter. Build a CombatantState for them,
 * inject into encounter.participants with joined_round = encounter.round,
 * persist via OCC, and emit a reinforcement round_waiting tagged with
 * `extension_reason: { type: "joined", ... }`.
 *
 * Returns true if the ship joined, false otherwise (already a participant,
 * friendly to all active combatants, escape pod, encounter ended in a
 * concurrent write, etc.).
 *
 * Concurrency: the persist is compare-and-swap on `encounter.last_updated`.
 * If a concurrent writer (combat_tick / combat_action / another join)
 * mutated the blob between our load and our write, the CAS fails and we
 * re-load + re-evaluate up to MAX_RETRIES times. Event emission is
 * deferred until after the successful persist so retries never double-emit.
 */
export async function joinExistingCombat(params: {
  supabase: SupabaseClient;
  encounter: CombatEncounterState;
  characterId: string;
  ship: ShipRow;
  character: CharacterRow;
  requestId: string;
}): Promise<boolean> {
  const { supabase, characterId, ship, character, requestId } = params;
  let encounter: CombatEncounterState | null = params.encounter;

  // Escape pods can't combat. ship_type is the source of truth for this on
  // ShipRow; the bool flag on ShipRecord is just a convenience mirror.
  // Cheap up-front check — bail before any DB round-trips.
  if (ship.ship_type === "escape_pod") return false;

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!encounter) return false;
    if (encounter.ended) return false;
    if (encounter.participants[characterId]) return false;
    // Active resolution lock — bail rather than slip a participant into
    // the encounter while resolveEncounterRound is mid-flight (would land
    // canonical writes / events from the pre-join participant set, then
    // our persist would change the membership the next-tick run starts
    // from). Stale marker (older than TTL) is ignored.
    if (isResolvingLockHeld(encounter)) {
      console.warn("garrison_combat.join.bailed_on_resolving_lock", {
        sector_id: encounter.sector_id,
        character_id: characterId,
      });
      return false;
    }

    // Build the new participant. The build helper handles current_ship_id
    // mismatches and missing definitions and returns null when the ship
    // can't legitimately be a participant.
    const newParticipant = await buildCharacterCombatant(
      supabase,
      {
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        ship_name: ship.ship_name ?? null,
        current_sector: ship.current_sector ?? encounter.sector_id,
        current_fighters: ship.current_fighters ?? 0,
        current_shields: ship.current_shields ?? 0,
        in_hyperspace: false,
        owner_character_id: ship.owner_character_id ?? null,
        owner_type: ship.owner_type ?? "character",
        owner_corporation_id: ship.owner_corporation_id ?? null,
        is_escape_pod: ship.ship_type === "escape_pod",
      },
      {
        character_id: character.character_id,
        name: character.name,
        corporation_id: character.corporation_id ?? null,
        current_ship_id: character.current_ship_id ?? null,
        first_visit: character.first_visit ?? null,
      },
    );
    if (!newParticipant) return false;
    newParticipant.joined_round = encounter.round;

    // Hostility check — at least one ACTIVE participant must be hostile to
    // the new arrival. Active = garrison with fighters>0, OR character with
    // fighters>0 AND not destruction_handled AND not has_fled.
    const corps = buildCorporationMap(encounter);
    const newKey =
      newParticipant.owner_character_id ?? newParticipant.combatant_id;
    const newCorpId =
      typeof newParticipant.metadata?.corporation_id === "string"
        ? (newParticipant.metadata.corporation_id as string)
        : null;
    corps.set(newKey, newCorpId);

    let hasHostile = false;
    for (const existing of Object.values(encounter.participants)) {
      if ((existing.fighters ?? 0) <= 0) continue;
      if (existing.destruction_handled) continue;
      if (existing.has_fled) continue;
      if (!areFriendlyFromMeta(corps, newParticipant, existing)) {
        hasHostile = true;
        break;
      }
    }
    if (!hasHostile) return false;

    // Capture the OCC fence value BEFORE any in-memory mutation. The CAS
    // below succeeds only if the row's last_updated still matches this.
    const expectedLastUpdated = encounter.last_updated;

    // Inject and persist. No pending_actions entry — engine defaults
    // missing entries to brace for the current round; the joiner can
    // submit combat_action for round N+1.
    encounter.participants[newParticipant.combatant_id] = newParticipant;

    try {
      await persistCombatState(supabase, encounter, { expectedLastUpdated });
    } catch (err) {
      if (err instanceof CombatStateConflictError) {
        console.warn("garrison_combat.join.cas_conflict", {
          sector_id: encounter.sector_id,
          attempt,
        });
        // Re-load and retry. A concurrent writer (tick / action / another
        // join) wrote between our load and our write. The fresh load may
        // show the encounter has ended, in which case the loop bails on
        // the next iteration.
        encounter = await loadCombatForSector(supabase, params.encounter.sector_id);
        continue;
      }
      throw err;
    }

    // Persist committed — now safe to emit events. Deferring until here
    // means a retry on conflict never produces a duplicate emission.
    await emitRoundWaitingEvents(
      supabase,
      encounter,
      requestId,
      {
        type: "joined",
        joiners: [
          {
            combatant_id: newParticipant.combatant_id,
            name: newParticipant.name,
          },
        ],
      },
      new Set([newParticipant.combatant_id]),
    );

    return true;
  }

  console.warn("garrison_combat.join.max_retries", {
    sector_id: params.encounter.sector_id,
    character_id: characterId,
  });
  return false;
}
