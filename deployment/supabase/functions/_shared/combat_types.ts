export type CombatantType = 'character' | 'garrison';

export type CombatantAction =
  | 'attack'
  | 'brace'
  | 'flee'
  | 'pay';

export interface CombatantState {
  combatant_id: string;
  combatant_type: CombatantType;
  name: string;
  fighters: number;
  shields: number;
  turns_per_warp: number;
  max_fighters: number;
  max_shields: number;
  is_escape_pod: boolean;
  owner_character_id?: string | null;
  ship_type?: string | null;
  has_fled?: boolean;
  fled_to_sector?: number | null;
  metadata?: Record<string, unknown>;
  // Set true once the participant's mid-round destruction has been persisted
  // to canonical tables (ship_instances destroyed_at for corp ships, garrison
  // row deletion for garrisons, current_fighters=0 for player ships). Prevents
  // finalizeCombat from re-running the same writes on the terminal round.
  destruction_handled?: boolean;
  // Set true once captureSalvageForDefeatedShip has pushed an entry onto
  // encounter.pending_salvage_entries for this participant. Persisted along
  // with the entry so a crash between salvage capture and escape-pod
  // conversion (which zeros cargo) cannot lead to a duplicate capture on
  // retry. destruction_handled is too coarse for this — it flips only after
  // conversion + corp cleanup succeed, leaving a window where salvage could
  // be re-captured.
  salvage_captured?: boolean;
}

export interface PendingCorpShipDeletion {
  ship_id: string;
  character_id: string;
}

export interface RoundActionState {
  action: CombatantAction;
  commit: number;
  timed_out: boolean;
  submitted_at: string;
  target_id?: string | null;
  destination_sector?: number | null;
}

export interface CombatRoundOutcome {
  round_number: number;
  hits: Record<string, number>;
  offensive_losses: Record<string, number>;
  defensive_losses: Record<string, number>;
  shield_loss: Record<string, number>;
  damage_mitigated: Record<string, number>;
  fighters_remaining: Record<string, number>;
  shields_remaining: Record<string, number>;
  flee_results: Record<string, boolean>;
  end_state: string | null;
  effective_actions: Record<string, RoundActionState>;
  participant_deltas?: Record<string, { fighters: number; shields: number }>;
}

export interface CombatRoundLog {
  round_number: number;
  actions: Record<string, RoundActionState>;
  hits: Record<string, number>;
  offensive_losses: Record<string, number>;
  defensive_losses: Record<string, number>;
  shield_loss: Record<string, number>;
  damage_mitigated?: Record<string, number>;
  result: string | null;
  timestamp: string;
}

export interface CombatEncounterState {
  combat_id: string;
  sector_id: number;
  round: number;
  deadline: string | null;
  participants: Record<string, CombatantState>;
  pending_actions: Record<string, RoundActionState>;
  logs: CombatRoundLog[];
  context: Record<string, unknown>;
  awaiting_resolution: boolean;
  ended: boolean;
  end_state: string | null;
  base_seed: number;
  last_updated: string;
  // Corp ships destroyed mid-combat that still need their pseudo-character /
  // corporation_ships rows cleaned up after combat.ended fires. Persisted on
  // the encounter blob so the cleanup survives across edge-function
  // invocations (each round runs in a fresh worker).
  pending_corp_ship_deletions?: PendingCorpShipDeletion[];
  // Salvage captured from ships destroyed mid-combat. Held in memory on the
  // encounter (and persisted alongside it) until finalizeCombat drains them
  // into sector_contents.salvage — so the salvage isn't collectable by
  // anyone (combatant or passer-by) until the encounter actually ends.
  pending_salvage_entries?: Array<Record<string, unknown>>;
}

export function nowIso(): string {
  return new Date().toISOString();
}
