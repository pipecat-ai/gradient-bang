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
  metadata?: Record<string, unknown>;
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
}

export function nowIso(): string {
  return new Date().toISOString();
}
