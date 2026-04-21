import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildEventSource,
  emitCharacterEvent,
  recordEventWithRecipients,
} from "./events.ts";
import { fetchActiveTaskIdsByShip } from "./tasks.ts";
import type { ShipDefinitionRow } from "./status.ts";

export interface CorporationRecord {
  corp_id: string;
  name: string;
  founder_id: string;
  founded: string;
  invite_code: string;
  invite_code_generated: string;
  invite_code_generated_by: string | null;
  disbanded_at: string | null;
}

export interface CorporationMemberSummary {
  character_id: string;
  name: string;
  joined_at: string | null;
}

export interface CorporationShipSummary {
  ship_id: string;
  ship_type: string;
  name: string;
  sector: number | null;
  owner_type: string;
  control_ready: boolean;
  credits: number;
  cargo: {
    quantum_foam: number;
    retro_organics: number;
    neuro_symbolics: number;
  };
  cargo_capacity: number;
  warp_power: number;
  warp_power_capacity: number;
  shields: number;
  max_shields: number;
  fighters: number;
  max_fighters: number;
  current_task_id: string | null;
}

export interface DestroyedCorporationShip {
  ship_id: string;
  ship_type: string;
  name: string;
  sector: number | null;
  destroyed_at: string;
}

// Space-themed words for voice-friendly two-word invite passphrases.
// Curated to avoid homophones, confusing spellings, and words where TTS/ASR
// round-trips tend to fail (e.g. "knight"/"night", "flour"/"flower",
// "sun"/"son"). Words kept short and unambiguous so humans can speak them.
const INVITE_WORDS: readonly string[] = [
  "alpha", "amber", "anchor", "arc", "arrow", "ash", "aster", "atlas", "atom",
  "aurora", "azure", "beacon", "beta", "binary", "blaze", "blue", "bolt",
  "boson", "brass", "bronze", "canopy", "canyon", "carbon", "cargo", "cedar",
  "cinder", "cipher", "citadel", "cliff", "cluster", "cobalt", "comet",
  "compass", "copper", "coral", "cortex", "cosmic", "crater", "crest",
  "crimson", "crown", "crystal", "cypher", "delta", "dock", "domain", "dune",
  "dusk", "eagle", "echo", "eclipse", "ember", "emerald", "engine", "ether",
  "falcon", "flare", "flint", "forge", "fox", "fractal", "frost", "galaxy",
  "gamma", "garnet", "glacier", "glint", "granite", "gravity", "grove",
  "harbor", "hawk", "haven", "helios", "helix", "herald", "horizon", "hydro",
  "ice", "indigo", "iris", "iron", "ivory", "jade", "jasper", "jolt", "keel",
  "kelp", "kestrel", "keystone", "kodiak", "krypton", "lantern", "ledger",
  "lithium", "lumen", "lunar", "lynx", "magma", "magnet", "mantle", "marble",
  "marsh", "meadow", "mercury", "meridian", "mesa", "meteor", "mist", "mongoose",
  "moon", "mosaic", "nebula", "neon", "nimbus", "nomad", "north", "nova",
  "nucleus", "oak", "obsidian", "omega", "onyx", "opal", "orbit", "orchid",
  "osprey", "oxygen", "panther", "patrol", "peak", "pebble", "phantom",
  "phoenix", "photon", "pilot", "pine", "pioneer", "pixel", "plasma",
  "platinum", "prism", "proton", "pulse", "python", "quartz", "quasar",
  "quest", "radar", "radon", "raven", "redwood", "rift", "ripple", "river",
  "rocket", "ruby", "rune", "saber", "saffron", "sage", "sapphire", "scout",
  "sentry", "shadow", "shield", "sierra", "signal", "silver", "solar",
  "solstice", "sonar", "sphere", "spire", "spruce", "stellar", "stone",
  "storm", "stratus", "summit", "surge", "talon", "tangent", "tempest",
  "terra", "thunder", "tiger", "titan", "tonic", "topaz", "torch", "totem",
  "tower", "tundra", "turbo", "ultra", "umbra", "valor", "vanguard", "vector",
  "velvet", "vertex", "vesper", "violet", "vortex", "voyager", "waft",
  "warden", "watch", "wave", "whisper", "wolf", "xenon", "yonder", "zenith",
  "zephyr", "zeta", "zinc",
];

function pickWord(): string {
  const idx = Math.floor(Math.random() * INVITE_WORDS.length);
  return INVITE_WORDS[idx];
}

function makePassphrase(): string {
  return `${pickWord()}-${pickWord()}`;
}

/**
 * Legacy single-shot generator. Retained for code paths that do not have a
 * Supabase client at hand; prefer {@link generateUniqueInviteCode} so we can
 * check for live collisions. Two-word passphrases collide more often than the
 * old 4-byte hex codes, though with the current word list it is still rare.
 */
export function generateInviteCode(): string {
  return makePassphrase();
}

/**
 * Normalize an invite passphrase for equality comparison. Generated codes
 * are canonical `word-word` (lowercase, single dash). Player input may arrive
 * spoken ("nebula cortex"), underscored, uppercased, or with extra whitespace.
 * Fold any run of whitespace/dash/underscore into a single dash and lowercase
 * everything so all variants compare equal.
 *
 * Safe because INVITE_WORDS contains only lowercase alphanumerics (no internal
 * dashes or spaces).
 */
export function normalizeInviteCode(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().replace(/[\s\-_]+/g, "-");
}

/**
 * Generates a two-word passphrase and verifies no other *active* corporation
 * is already using it. Retries a small number of times before giving up —
 * with ~200 words the chance of repeated collisions is negligible.
 */
export async function generateUniqueInviteCode(
  supabase: SupabaseClient,
  maxAttempts = 8,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = makePassphrase();
    const { data, error } = await supabase
      .from("corporations")
      .select("corp_id")
      .eq("invite_code", code)
      .is("disbanded_at", null)
      .maybeSingle();
    if (error) {
      console.error("corporations.invite_code.collision_check", error);
      throw new Error("Failed to generate invite code");
    }
    if (!data) {
      return code;
    }
  }
  throw new Error("Unable to generate a unique invite code");
}

export async function loadCorporationById(
  supabase: SupabaseClient,
  corpId: string,
): Promise<CorporationRecord> {
  const { data, error } = await supabase
    .from("corporations")
    .select(
      "corp_id, name, founder_id, founded, invite_code, invite_code_generated, invite_code_generated_by, disbanded_at",
    )
    .eq("corp_id", corpId)
    .maybeSingle();

  if (error) {
    console.error("corporations.load", error);
    throw new Error("Failed to load corporation data");
  }
  if (!data) {
    throw new Error("Corporation not found");
  }
  return data as CorporationRecord;
}

export async function isActiveCorporationMember(
  supabase: SupabaseClient,
  corpId: string,
  characterId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("corporation_members")
    .select("character_id")
    .eq("corp_id", corpId)
    .eq("character_id", characterId)
    .is("left_at", null)
    .maybeSingle();
  if (error) {
    console.error("corporations.membership.check", error);
    throw new Error("Failed to verify corporation membership");
  }
  return Boolean(data);
}

export async function upsertCorporationMembership(
  supabase: SupabaseClient,
  corpId: string,
  characterId: string,
  joinedAt: string,
): Promise<void> {
  const { error } = await supabase.from("corporation_members").upsert(
    {
      corp_id: corpId,
      character_id: characterId,
      joined_at: joinedAt,
      left_at: null,
    },
    { onConflict: "corp_id,character_id" },
  );
  if (error) {
    console.error("corporations.membership.upsert", error);
    throw new Error("Failed to update membership");
  }
}

export async function markCorporationMembershipLeft(
  supabase: SupabaseClient,
  corpId: string,
  characterId: string,
  leftAt: string,
): Promise<void> {
  const { error } = await supabase
    .from("corporation_members")
    .update({ left_at: leftAt })
    .eq("corp_id", corpId)
    .eq("character_id", characterId);
  if (error) {
    console.error("corporations.membership.leave", error);
    throw new Error("Failed to update membership state");
  }
}

export async function fetchCorporationMembers(
  supabase: SupabaseClient,
  corpId: string,
): Promise<CorporationMemberSummary[]> {
  const membershipRows = await fetchActiveMembershipRows(supabase, corpId);
  if (!membershipRows.length) {
    return [];
  }

  const memberIds = membershipRows.map((row) => row.character_id);
  const { data: characterRows, error } = await supabase
    .from("characters")
    .select("character_id, name")
    .in("character_id", memberIds);
  if (error) {
    console.error("corporations.members.characters", error);
    throw new Error("Failed to load member profiles");
  }
  const nameMap = new Map<string, string>();
  for (const row of characterRows ?? []) {
    if (row && typeof row.character_id === "string") {
      const candidate =
        typeof row.name === "string" && row.name.trim().length > 0
          ? row.name
          : row.character_id;
      nameMap.set(row.character_id, candidate);
    }
  }

  return membershipRows.map((row) => ({
    character_id: row.character_id,
    name: nameMap.get(row.character_id) ?? row.character_id,
    joined_at: row.joined_at ?? null,
  }));
}

export async function listCorporationMemberIds(
  supabase: SupabaseClient,
  corpId: string,
): Promise<string[]> {
  const membershipRows = await fetchActiveMembershipRows(supabase, corpId);
  return membershipRows.map((row) => row.character_id);
}

export async function fetchCorporationShipSummaries(
  supabase: SupabaseClient,
  corpId: string,
): Promise<CorporationShipSummary[]> {
  const { data: shipLinks, error: linkError } = await supabase
    .from("corporation_ships")
    .select("ship_id")
    .eq("corp_id", corpId);
  if (linkError) {
    console.error("corporations.ships.list", linkError);
    throw new Error("Failed to load corporation ships");
  }
  const shipIds = (shipLinks ?? [])
    .map((row) => row?.ship_id)
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  if (!shipIds.length) {
    return [];
  }

  const { data: shipRows, error: shipError } = await supabase
    .from("ship_instances")
    .select(
      "ship_id, ship_type, ship_name, current_sector, owner_type, credits, cargo_qf, cargo_ro, cargo_ns, current_warp_power, current_shields, current_fighters",
    )
    .in("ship_id", shipIds)
    .neq("owner_type", "unowned")
    .is("destroyed_at", null);
  if (shipError) {
    console.error("corporations.ships.instances", shipError);
    throw new Error("Failed to load ship instances");
  }

  const definitionMap = await loadShipDefinitions(supabase, shipRows ?? []);
  const controlReady = await loadControlReadySet(supabase, shipIds);
  const activeTasks = await fetchActiveTaskIdsByShip(supabase, shipIds);
  const summaries: CorporationShipSummary[] = [];

  for (const row of shipRows ?? []) {
    if (!row || typeof row.ship_id !== "string") {
      continue;
    }
    const shipId = row.ship_id;
    const definition = definitionMap.get(row.ship_type ?? "") ?? null;
    const cargo = {
      quantum_foam: Number(row.cargo_qf ?? 0),
      retro_organics: Number(row.cargo_ro ?? 0),
      neuro_symbolics: Number(row.cargo_ns ?? 0),
    };
    const cargoCapacity = definition?.cargo_holds ?? 0;
    summaries.push({
      ship_id: shipId,
      ship_type: row.ship_type ?? "unknown",
      name:
        typeof row.ship_name === "string" && row.ship_name.trim().length > 0
          ? row.ship_name
          : (definition?.display_name ?? row.ship_type ?? shipId),
      sector:
        typeof row.current_sector === "number" ? row.current_sector : null,
      owner_type: row.owner_type ?? "unowned",
      control_ready: controlReady.has(shipId),
      credits: Number(row.credits ?? 0),
      cargo,
      cargo_capacity: cargoCapacity,
      warp_power: Number(
        row.current_warp_power ?? definition?.warp_power_capacity ?? 0,
      ),
      warp_power_capacity: definition?.warp_power_capacity ?? 0,
      shields: Number(row.current_shields ?? definition?.shields ?? 0),
      max_shields: definition?.shields ?? 0,
      fighters: Number(row.current_fighters ?? definition?.fighters ?? 0),
      max_fighters: definition?.fighters ?? 0,
      current_task_id: activeTasks.get(shipId) ?? null,
    });
  }

  return summaries;
}

export async function fetchDestroyedCorporationShips(
  supabase: SupabaseClient,
  corpId: string,
): Promise<DestroyedCorporationShip[]> {
  const { data: shipRows, error } = await supabase
    .from("ship_instances")
    .select("ship_id, ship_type, ship_name, current_sector, destroyed_at")
    .eq("owner_corporation_id", corpId)
    .not("destroyed_at", "is", null)
    .order("destroyed_at", { ascending: false });
  if (error) {
    console.error("corporations.ships.destroyed", error);
    throw new Error("Failed to load destroyed corporation ships");
  }

  const definitionMap = await loadShipDefinitions(supabase, shipRows ?? []);

  return (shipRows ?? [])
    .filter((row) => row && typeof row.ship_id === "string")
    .map((row) => {
      const definition = definitionMap.get(row.ship_type ?? "") ?? null;
      return {
        ship_id: row.ship_id,
        ship_type: row.ship_type ?? "unknown",
        name:
          typeof row.ship_name === "string" && row.ship_name.trim().length > 0
            ? row.ship_name
            : (definition?.display_name ?? row.ship_type ?? row.ship_id),
        sector:
          typeof row.current_sector === "number" ? row.current_sector : null,
        destroyed_at: row.destroyed_at,
      };
    });
}

export function buildCorporationPublicPayload(
  corp: CorporationRecord,
  memberCount: number,
): Record<string, unknown> {
  return {
    corp_id: corp.corp_id,
    name: corp.name,
    founded: corp.founded,
    member_count: memberCount,
  };
}

export function buildCorporationMemberPayload(
  corp: CorporationRecord,
  members: CorporationMemberSummary[],
  ships: CorporationShipSummary[],
  destroyedShips: DestroyedCorporationShip[] = [],
  requesterCharacterId: string | null = null,
): Record<string, unknown> {
  const isFounder =
    requesterCharacterId !== null && corp.founder_id === requesterCharacterId;
  const payload: Record<string, unknown> = {
    ...buildCorporationPublicPayload(corp, members.length),
    founder_id: corp.founder_id,
    is_founder: isFounder,
    members,
    ships,
    destroyed_ships: destroyedShips,
  };
  // Invite code and regeneration metadata are founder-only. Non-founder
  // members see `is_founder: false` and omit the fields entirely so the
  // LLM/UI can tell the player only the founder can view or regenerate it.
  if (isFounder) {
    payload.invite_code = corp.invite_code;
    payload.invite_code_generated = corp.invite_code_generated;
    payload.invite_code_generated_by = corp.invite_code_generated_by;
  }
  return payload;
}

export async function emitCorporationEvent(
  supabase: SupabaseClient,
  corpId: string,
  options: {
    eventType: string;
    payload: Record<string, unknown>;
    requestId: string;
    actorCharacterId?: string | null;
    taskId?: string | null;
  },
): Promise<void> {
  await recordEventWithRecipients({
    supabase,
    eventType: options.eventType,
    scope: "corp",
    payload: options.payload,
    requestId: options.requestId,
    corpId,
    actorCharacterId: options.actorCharacterId ?? null,
    taskId: options.taskId ?? null,
  });
}

export type DisbandReason =
  | "last_member_left"
  | "last_member_joined_other"
  | "kick_emptied_corp"
  | "founder_disbanded";

export interface DisbandCorporationOptions {
  corpId: string;
  corporationName: string;
  characterId: string;
  reason: DisbandReason;
  requestId: string;
  taskId?: string | null;
  method?: string;
}

/**
 * Disband a corporation: release any remaining corp-owned ships, emit the
 * disband events, and soft-delete the corporation row.
 *
 * Callers in the user-facing flow are expected to refuse the action upfront
 * when the corp still owns ships (so the user can sell them first). This
 * helper retains the ship-release logic as a *safety net* — if some future
 * caller skips that check, the ships are still released with a
 * `corporation.ships_abandoned` event rather than being orphaned by a
 * soft-deleted corp. Defense in depth.
 */
export async function disbandCorporation(
  supabase: SupabaseClient,
  options: DisbandCorporationOptions,
): Promise<void> {
  const {
    corpId,
    corporationName,
    characterId,
    reason,
    requestId,
    taskId,
    method = "corporation_leave",
  } = options;

  const shipSummaries = await fetchCorporationShipSummaries(supabase, corpId);
  const shipIds = shipSummaries.map((ship) => ship.ship_id);
  const timestamp = new Date().toISOString();

  if (shipIds.length) {
    // Safety net: callers should have refused if any corp ships remain, so
    // this path only fires if something upstream missed the check.
    const { error: shipUpdateError } = await supabase
      .from("ship_instances")
      .update({
        owner_type: "unowned",
        owner_id: null,
        owner_character_id: null,
        owner_corporation_id: null,
        became_unowned: timestamp,
        former_owner_name: corporationName,
      })
      .in("ship_id", shipIds);
    if (shipUpdateError) {
      console.error("corporations.disband.ship_update", shipUpdateError);
      throw new Error("Failed to release corporation ships");
    }

    // Detach pseudo-characters from corporation (don't delete — avoids FK
    // constraint violations on events.character_id / events.sender_id).
    const { error: autopilotUpdateError } = await supabase
      .from("characters")
      .update({ corporation_id: null })
      .in("character_id", shipIds);
    if (autopilotUpdateError) {
      console.error(
        "corporations.disband.ship_character_update",
        autopilotUpdateError,
      );
      throw new Error("Failed to detach corporation ship pilots");
    }
  }

  const source = buildEventSource(method, requestId);
  const disbandPayload = {
    source,
    corp_id: corpId,
    corp_name: corporationName,
    reason,
    timestamp,
  };

  await emitCharacterEvent({
    supabase,
    characterId,
    eventType: "corporation.disbanded",
    payload: disbandPayload,
    requestId,
    corpId,
    taskId,
  });

  if (shipSummaries.length) {
    const shipsPayload = {
      source,
      corp_id: corpId,
      corp_name: corporationName,
      ships: shipSummaries.map((ship) => ({
        ship_id: ship.ship_id,
        ship_type: ship.ship_type,
        sector: ship.sector,
      })),
      timestamp,
    };

    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "corporation.ships_abandoned",
      payload: shipsPayload,
      requestId,
      corpId,
      taskId,
    });
  }

  // Soft-delete: mark disbanded instead of hard-deleting. This preserves FK
  // references from the events table (corp_id) without needing to NULL them.
  const { error: disbandError } = await supabase
    .from("corporations")
    .update({ disbanded_at: timestamp })
    .eq("corp_id", corpId);
  if (disbandError) {
    console.error("corporations.disband.corp_update", disbandError);
    throw new Error("Failed to disband corporation");
  }
}

async function fetchActiveMembershipRows(
  supabase: SupabaseClient,
  corpId: string,
): Promise<Array<{ character_id: string; joined_at: string | null }>> {
  const { data, error } = await supabase
    .from("corporation_members")
    .select("character_id, joined_at, left_at")
    .eq("corp_id", corpId)
    .is("left_at", null)
    .order("joined_at", { ascending: true });
  if (error) {
    console.error("corporations.members.active", error);
    throw new Error("Failed to load corporation members");
  }
  const rows: Array<{ character_id: string; joined_at: string | null }> = [];
  for (const entry of data ?? []) {
    if (entry && typeof entry.character_id === "string") {
      rows.push({
        character_id: entry.character_id,
        joined_at: typeof entry.joined_at === "string" ? entry.joined_at : null,
      });
    }
  }
  return rows;
}

async function loadShipDefinitions(
  supabase: SupabaseClient,
  shipRows: Array<Record<string, unknown>>,
): Promise<Map<string, ShipDefinitionRow>> {
  const shipTypes = Array.from(
    new Set(
      shipRows
        .map((row) =>
          typeof row.ship_type === "string" ? row.ship_type : null,
        )
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const definitionMap = new Map<string, ShipDefinitionRow>();
  if (!shipTypes.length) {
    return definitionMap;
  }
  const { data, error } = await supabase
    .from("ship_definitions")
    .select(
      "ship_type, display_name, cargo_holds, warp_power_capacity, shields, fighters",
    )
    .in("ship_type", shipTypes);
  if (error) {
    console.error("corporations.ships.definitions", error);
    throw new Error("Failed to load ship definitions");
  }
  for (const row of data ?? []) {
    if (row && typeof row.ship_type === "string") {
      definitionMap.set(row.ship_type, row as ShipDefinitionRow);
    }
  }
  return definitionMap;
}

async function loadControlReadySet(
  supabase: SupabaseClient,
  shipIds: string[],
): Promise<Set<string>> {
  if (!shipIds.length) {
    return new Set();
  }
  const { data, error } = await supabase
    .from("characters")
    .select("character_id")
    .in("character_id", shipIds);
  if (error) {
    console.error("corporations.ships.control_ready", error);
    throw new Error("Failed to inspect ship control state");
  }
  const ready = new Set<string>();
  for (const row of data ?? []) {
    if (row && typeof row.character_id === "string") {
      ready.add(row.character_id);
    }
  }
  return ready;
}

/**
 * Get the effective corporation ID for a character.
 * Checks corporation_members first (for player characters),
 * then falls back to ship ownership (for corp-owned ships like autonomous probes).
 */
export async function getEffectiveCorporationId(
  supabase: SupabaseClient,
  characterId: string,
  shipId?: string | null,
): Promise<string | null> {
  // First check corporation_members (for player characters)
  const { data: memberData } = await supabase
    .from("corporation_members")
    .select("corp_id")
    .eq("character_id", characterId)
    .is("left_at", null)
    .maybeSingle();

  if (memberData?.corp_id) {
    return memberData.corp_id;
  }

  // If not a member and shipId provided, check ship ownership
  if (shipId) {
    const { data: shipData } = await supabase
      .from("ship_instances")
      .select("owner_corporation_id")
      .eq("ship_id", shipId)
      .maybeSingle();

    if (shipData?.owner_corporation_id) {
      return shipData.owner_corporation_id;
    }
  }

  return null;
}
