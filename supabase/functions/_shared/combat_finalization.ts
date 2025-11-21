import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import {
  CombatEncounterState,
  CombatRoundOutcome,
  CombatantState,
} from './combat_types.ts';
import { appendSalvageEntry, buildSalvageEntry, SalvageEntry } from './salvage.ts';
import { emitSectorEnvelope, buildEventSource } from './events.ts';

interface ShipRow {
  ship_id: string;
  ship_type: string;
  ship_name: string | null;
  current_sector: number | null;
  credits: number;
  cargo_qf: number;
  cargo_ro: number;
  cargo_ns: number;
}

interface ShipDefinitionRow {
  ship_type: string;
  display_name: string;
  purchase_price: number | null;
}

async function loadShip(
  supabase: SupabaseClient,
  shipId: string,
): Promise<ShipRow | null> {
  const { data, error } = await supabase
    .from<ShipRow>('ship_instances')
    .select(
      'ship_id, ship_type, ship_name, current_sector, credits, cargo_qf, cargo_ro, cargo_ns',
    )
    .eq('ship_id', shipId)
    .maybeSingle();
  if (error) {
    console.error('combat_finalization.load_ship', error);
    throw new Error('Failed to load ship state');
  }
  return data ?? null;
}

async function loadShipDefinitionMap(
  supabase: SupabaseClient,
  shipTypes: string[],
): Promise<Map<string, ShipDefinitionRow>> {
  if (!shipTypes.length) {
    return new Map();
  }
  const unique = Array.from(new Set(shipTypes));
  const { data, error } = await supabase
    .from<ShipDefinitionRow>('ship_definitions')
    .select('ship_type, display_name, purchase_price')
    .in('ship_type', unique);
  if (error) {
    console.error('combat_finalization.load_defs', error);
    throw new Error('Failed to load ship definitions');
  }
  return new Map((data ?? []).map((row) => [row.ship_type, row]));
}

async function convertShipToEscapePod(
  supabase: SupabaseClient,
  shipId: string,
): Promise<void> {
  const { error } = await supabase
    .from('ship_instances')
    .update({
      ship_type: 'escape_pod',
      ship_name: 'Escape Pod',
      current_fighters: 0,
      current_shields: 0,
      current_warp_power: 0,
      cargo_qf: 0,
      cargo_ro: 0,
      cargo_ns: 0,
      credits: 0,
      is_escape_pod: true,
      metadata: {
        former_ship: shipId,
      },
    })
    .eq('ship_id', shipId);
  if (error) {
    console.error('combat_finalization.escape_pod', error);
    throw new Error('Failed to convert ship to escape pod');
  }
}

function buildCargoFromShip(ship: ShipRow): Record<string, number> {
  const cargo: Record<string, number> = {};
  if (ship.cargo_qf > 0) {
    cargo.quantum_foam = ship.cargo_qf;
  }
  if (ship.cargo_ro > 0) {
    cargo.retro_organics = ship.cargo_ro;
  }
  if (ship.cargo_ns > 0) {
    cargo.neuro_symbolics = ship.cargo_ns;
  }
  return cargo;
}

async function handleDefeatedCharacter(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  participant: CombatantState,
  definition: ShipDefinitionRow | undefined,
): Promise<SalvageEntry | null> {
  const metadata = (participant.metadata ?? {}) as Record<string, unknown>;
  const shipId = typeof metadata.ship_id === 'string' ? metadata.ship_id : null;
  if (!shipId) {
    return null;
  }
  const ship = await loadShip(supabase, shipId);
  if (!ship) {
    return null;
  }
  const cargo = buildCargoFromShip(ship);
  const credits = ship.credits ?? 0;
  const scrapBase = definition?.purchase_price ?? 0;
  const scrap = Math.max(5, Math.floor(scrapBase / 1000));
  if (!Object.keys(cargo).length && scrap <= 0 && credits <= 0) {
    await convertShipToEscapePod(supabase, shipId);
    return null;
  }
  const salvage = buildSalvageEntry(
    { ship_name: ship.ship_name, ship_type: ship.ship_type },
    definition?.display_name ?? ship.ship_type,
    cargo,
    scrap,
    credits,
    {
      combat_id: encounter.combat_id,
      ship_type: ship.ship_type,
    },
  );
  await appendSalvageEntry(supabase, encounter.sector_id, salvage);
  await convertShipToEscapePod(supabase, shipId);
  return salvage;
}

async function updateGarrisonState(
  supabase: SupabaseClient,
  participant: CombatantState,
  remainingFighters: number,
): Promise<void> {
  const ownerId = participant.owner_character_id;
  if (!ownerId) {
    return;
  }
  if (remainingFighters > 0) {
    const { error } = await supabase
      .from('garrisons')
      .update({
        fighters: remainingFighters,
        updated_at: new Date().toISOString(),
      })
      .eq('sector_id', participant.metadata?.sector_id ?? null)
      .eq('owner_id', ownerId);
    if (error) {
      console.error('combat_finalization.update_garrison', error);
    }
    return;
  }
  const { error } = await supabase
    .from('garrisons')
    .delete()
    .eq('sector_id', participant.metadata?.sector_id ?? null)
    .eq('owner_id', ownerId);
  if (error) {
    console.error('combat_finalization.remove_garrison', error);
  }
}

export async function finalizeCombat(
  supabase: SupabaseClient,
  encounter: CombatEncounterState,
  outcome: CombatRoundOutcome,
  requestId?: string,
): Promise<SalvageEntry[]> {
  const salvageEntries: SalvageEntry[] = [];
  const defeated = Object.entries(outcome.fighters_remaining ?? {}).filter(
    ([pid, remaining]) => remaining <= 0,
  );
  const shipTypes = defeated
    .map(([pid]) => encounter.participants[pid])
    .filter((participant): participant is CombatantState => Boolean(participant))
    .map((participant) => participant.ship_type ?? '')
    .filter(Boolean);
  const definitionMap = await loadShipDefinitionMap(supabase, shipTypes);

  for (const [pid] of defeated) {
    const participant = encounter.participants[pid];
    if (!participant || participant.combatant_type !== 'character') {
      if (participant?.combatant_type === 'garrison') {
        await updateGarrisonState(
          supabase,
          participant,
          outcome.fighters_remaining?.[pid] ?? 0,
        );
      }
      continue;
    }
    const def = participant.ship_type ? definitionMap.get(participant.ship_type) : undefined;
    const entry = await handleDefeatedCharacter(supabase, encounter, participant, def);
    if (entry) {
      salvageEntries.push(entry);

      // Emit salvage.created event to all sector occupants
      const timestamp = new Date().toISOString();
      await emitSectorEnvelope({
        supabase,
        sectorId: encounter.sector_id,
        eventType: 'salvage.created',
        payload: {
          source: buildEventSource('combat.ended', requestId ?? `combat:${encounter.combat_id}`),
          timestamp,
          salvage_id: entry.salvage_id,
          sector: { id: encounter.sector_id },
          cargo: entry.cargo,
          scrap: entry.scrap,
          credits: entry.credits,
          from_ship_type: entry.source.ship_type,
          from_ship_name: entry.source.ship_name,
        },
        requestId: requestId ?? `combat:${encounter.combat_id}`,
      });
    }
    // Update participant state to reflect escape pod conversion for event payload
    participant.ship_type = 'escape_pod';
    participant.fighters = 0;
  }

  for (const [pid, participant] of Object.entries(encounter.participants)) {
    if (participant.combatant_type !== 'garrison') {
      continue;
    }
    const remaining = outcome.fighters_remaining?.[pid] ?? participant.fighters;
    await updateGarrisonState(supabase, participant, remaining);
  }

  return salvageEntries;
}
