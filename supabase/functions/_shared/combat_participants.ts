import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { CombatantState } from './combat_types.ts';

interface ShipRecord {
  ship_id: string;
  ship_type: string;
  ship_name: string | null;
  current_sector: number;
  current_fighters: number;
  current_shields: number;
  in_hyperspace: boolean;
  owner_character_id: string | null;
  owner_type: string | null;
  is_escape_pod: boolean | null;
}

interface CharacterRecord {
  character_id: string;
  name: string;
  corporation_id: string | null;
  current_ship_id: string | null;
  first_visit: string | null;
}

interface ShipDefinitionRecord {
  ship_type: string;
  display_name: string;
  turns_per_warp: number;
  fighters: number;
  shields: number;
}

interface GarrisonRow {
  sector_id: number;
  owner_id: string;
  fighters: number;
  mode: 'offensive' | 'defensive' | 'toll';
  toll_amount: number;
  toll_balance: number;
  deployed_at: string;
}

export interface CharacterCombatant extends CombatantState {
  metadata: {
    ship_id: string;
    corporation_id: string | null;
  };
}

export interface GarrisonCombatantResult {
  state: CombatantState;
  source: GarrisonRow;
}

export async function loadCharacterNames(
  supabase: SupabaseClient,
  characterIds: string[],
): Promise<Map<string, string>> {
  if (!characterIds.length) {
    return new Map();
  }
  const unique = Array.from(new Set(characterIds));
  const { data, error } = await supabase
    .from<CharacterRecord>('characters')
    .select('character_id, name')
    .in('character_id', unique);
  if (error) {
    console.error('combat_participants.load_names', error);
    throw new Error('Failed to load character names');
  }
  const result = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.character_id) {
      result.set(row.character_id, row.name ?? row.character_id);
    }
  }
  return result;
}

export async function loadGarrisonCombatants(
  supabase: SupabaseClient,
  sectorId: number,
  ownerNames: Map<string, string>,
): Promise<GarrisonCombatantResult[]> {
  const { data, error } = await supabase
    .from<GarrisonRow>('garrisons')
    .select('sector_id, owner_id, fighters, mode, toll_amount, toll_balance, deployed_at')
    .eq('sector_id', sectorId);
  if (error) {
    console.error('combat_participants.load_garrisons', error);
    throw new Error('Failed to load garrisons');
  }
  const rows = (data ?? []).filter((row) => row.fighters > 0);
  return rows.map((row) => {
    const combatantId = `garrison:${row.sector_id}:${row.owner_id}`;
    const state: CombatantState = {
      combatant_id: combatantId,
      combatant_type: 'garrison',
      name: `${ownerNames.get(row.owner_id) ?? row.owner_id} Garrison`,
      fighters: row.fighters,
      shields: 0,
      turns_per_warp: 0,
      max_fighters: row.fighters,
      max_shields: 0,
      is_escape_pod: false,
      owner_character_id: row.owner_id,
      ship_type: null,
      metadata: {
        mode: row.mode,
        toll_amount: row.toll_amount,
        toll_balance: row.toll_balance,
        deployed_at: row.deployed_at,
        sector_id: row.sector_id,
      },
    };
    return { state, source: row };
  });
}

export async function loadCharacterCombatants(
  supabase: SupabaseClient,
  sectorId: number,
): Promise<CharacterCombatant[]> {
  const { data: ships, error: shipError } = await supabase
    .from<ShipRecord>('ship_instances')
    .select(
      'ship_id, ship_type, ship_name, current_sector, current_fighters, current_shields, in_hyperspace, owner_character_id, owner_type, is_escape_pod',
    )
    .eq('current_sector', sectorId)
    .eq('in_hyperspace', false);
  if (shipError) {
    console.error('combat_participants.load_ships', shipError);
    throw new Error('Failed to load sector ships');
  }
  const filteredShips = (ships ?? []).filter(
    (row) => row.owner_character_id && row.owner_type === 'character',
  );
  if (!filteredShips.length) {
    return [];
  }

  const ownerIds = Array.from(
    new Set(filteredShips.map((row) => row.owner_character_id!).filter(Boolean)),
  );
  const { data: characters, error: characterError } = await supabase
    .from<CharacterRecord>('characters')
    .select('character_id, name, corporation_id, current_ship_id, first_visit')
    .in('character_id', ownerIds);
  if (characterError) {
    console.error('combat_participants.load_characters', characterError);
    throw new Error('Failed to load character metadata');
  }
  const characterMap = new Map(
    (characters ?? []).map((row) => [row.character_id, row]),
  );

  const shipTypes = Array.from(new Set(filteredShips.map((row) => row.ship_type)));
  const { data: definitions, error: defError } = await supabase
    .from<ShipDefinitionRecord>('ship_definitions')
    .select('ship_type, display_name, turns_per_warp, fighters, shields')
    .in('ship_type', shipTypes);
  if (defError) {
    console.error('combat_participants.load_definitions', defError);
    throw new Error('Failed to load ship definitions');
  }
  const definitionMap = new Map(
    (definitions ?? []).map((row) => [row.ship_type, row]),
  );

  const combatants: CharacterCombatant[] = [];
  for (const ship of filteredShips) {
    const character = characterMap.get(ship.owner_character_id!);
    if (!character || character.current_ship_id !== ship.ship_id) {
      continue;
    }
    const definition = definitionMap.get(ship.ship_type);
    if (!definition) {
      continue;
    }
    const fighters = Math.max(
      0,
      Number.isFinite(ship.current_fighters) ? ship.current_fighters : definition.fighters,
    );
    const shields = Math.max(
      0,
      Number.isFinite(ship.current_shields) ? ship.current_shields : definition.shields,
    );
    const combatant: CharacterCombatant = {
      combatant_id: character.character_id,
      combatant_type: 'character',
      name: character.name ?? character.character_id,
      fighters,
      shields,
      turns_per_warp: definition.turns_per_warp ?? 1,
      max_fighters: definition.fighters ?? fighters,
      max_shields: definition.shields ?? shields,
      is_escape_pod: Boolean(ship.is_escape_pod) || ship.ship_type === 'escape_pod',
      owner_character_id: character.character_id,
      ship_type: ship.ship_type,
      metadata: {
        ship_id: ship.ship_id,
        ship_name: ship.ship_name ?? definition.display_name,
        ship_display_name: definition.display_name,
        corporation_id: character.corporation_id,
        first_visit: character.first_visit,
      },
    };
    combatants.push(combatant);
  }
  return combatants;
}
