import {
  CombatEncounterState,
  CombatRoundOutcome,
  CombatantAction,
  CombatantState,
  RoundActionState,
} from './combat_types.ts';

const BASE_HIT = 0.5;
const MIN_HIT = 0.15;
const MAX_HIT = 0.85;
const MITIGATE_HIT_FACTOR = 0.6;
const ATTACK_BONUS_FACTOR = 0.1;
const SHIELD_ABLATION_FACTOR = 0.5;
const FLEE_MIN = 0.2;
const FLEE_MAX = 0.9;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shieldMitigation(state: CombatantState, action: CombatantAction): number {
  const base = clamp(0.0005 * Math.max(0, state.shields ?? 0), 0, 0.5);
  if (action === 'brace') {
    return clamp(base * 1.2, 0, 0.5);
  }
  return base;
}

function fleeSuccessChance(attacker: CombatantState, defender: CombatantState): number {
  const turnsAttacker = attacker.turns_per_warp ?? 0;
  const turnsDefender = defender.turns_per_warp ?? 0;
  const base = 0.5 + 0.1 * (turnsAttacker - turnsDefender);
  return clamp(base, FLEE_MIN, FLEE_MAX);
}

function hashSeed(parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const str = String(part);
    for (let idx = 0; idx < str.length; idx += 1) {
      hash ^= str.charCodeAt(idx);
      hash = Math.imul(hash, 0x01000193);
      hash >>>= 0;
    }
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resolveRound(
  encounter: CombatEncounterState,
  actions: Record<string, RoundActionState>,
): CombatRoundOutcome {
  const participantIds = Object.keys(encounter.participants).sort();
  const rngSeed = hashSeed([encounter.base_seed ?? 0, encounter.round]);
  const rng = mulberry32(rngSeed);

  const commits: Record<string, number> = {};
  const effectiveActions: Record<string, RoundActionState> = {};
  const mitigations: Record<string, number> = {};

  for (const pid of participantIds) {
    const state = encounter.participants[pid];
    const submitted = actions[pid];
    let action: CombatantAction = submitted?.action ?? 'brace';
    let commit = submitted?.commit ?? 0;
    let targetId = submitted?.target_id ?? null;
    const destination = action === 'flee' ? submitted?.destination_sector ?? null : null;

    if (action === 'attack') {
      commit = Math.max(0, Math.min(commit, state.fighters ?? 0));
      if (!commit || !targetId || targetId === pid || !(targetId in encounter.participants)) {
        action = 'brace';
        commit = 0;
        targetId = null;
      }
    } else {
      commit = 0;
      if (action !== 'flee') {
        targetId = null;
      }
    }

    const finalized: RoundActionState = {
      action,
      commit,
      target_id: targetId,
      destination_sector: destination,
      timed_out: submitted?.timed_out ?? false,
      submitted_at: submitted?.submitted_at ?? new Date().toISOString(),
    };

    effectiveActions[pid] = finalized;
    commits[pid] = finalized.commit;
    mitigations[pid] = shieldMitigation(state, action);
  }

  const fightersStart: Record<string, number> = {};
  const shieldsStart: Record<string, number> = {};
  for (const pid of participantIds) {
    const state = encounter.participants[pid];
    fightersStart[pid] = state.fighters ?? 0;
    shieldsStart[pid] = state.shields ?? 0;
  }

  const fleeResults: Record<string, boolean> = {};
  const activeIds = new Set(participantIds);
  const successfulFleers: string[] = [];

  function pickFleeOpponent(fleerId: string): CombatantState | null {
    const candidates = Array.from(activeIds)
      .filter((id) => id !== fleerId)
      .map((id) => encounter.participants[id])
      .filter((state) => state.fighters > 0);
    if (!candidates.length) {
      return null;
    }
    candidates.sort((a, b) => {
      if (a.fighters !== b.fighters) {
        return b.fighters - a.fighters;
      }
      if (a.combatant_id < b.combatant_id) {
        return -1;
      }
      if (a.combatant_id > b.combatant_id) {
        return 1;
      }
      return 0;
    });
    return candidates[0] ?? null;
  }

  for (const pid of participantIds) {
    if (!activeIds.has(pid)) {
      continue;
    }
    if (effectiveActions[pid].action !== 'flee') {
      fleeResults[pid] = false;
      continue;
    }
    const opponent = pickFleeOpponent(pid);
    if (!opponent) {
      fleeResults[pid] = true;
      activeIds.delete(pid);
      successfulFleers.push(pid);
      continue;
    }
    const chance = fleeSuccessChance(encounter.participants[pid], opponent);
    const roll = rng();
    const success = roll < chance;
    fleeResults[pid] = success;
    if (success) {
      activeIds.delete(pid);
      successfulFleers.push(pid);
    }
  }

  const remainingAttackers = Array.from(activeIds).filter((pid) => {
    const action = effectiveActions[pid];
    return action.action === 'attack' && action.commit > 0;
  });

  const hits: Record<string, number> = {};
  const offensiveLosses: Record<string, number> = {};
  const defensiveLosses: Record<string, number> = {};
  participantIds.forEach((pid) => {
    hits[pid] = 0;
    offensiveLosses[pid] = 0;
    defensiveLosses[pid] = 0;
  });

  if (successfulFleers.length && !remainingAttackers.length) {
    const zero = Object.fromEntries(participantIds.map((pid) => [pid, 0]));
    const fleerId = successfulFleers[0];
    const fleerName = encounter.participants[fleerId]?.name ?? fleerId;
    return {
      round_number: encounter.round,
      hits: { ...zero },
      offensive_losses: { ...zero },
      defensive_losses: { ...zero },
      shield_loss: { ...zero },
      fighters_remaining: { ...fightersStart },
      shields_remaining: { ...shieldsStart },
      flee_results: fleeResults,
      end_state: `${fleerName}_fled`,
      effective_actions: effectiveActions,
    };
  }

  if (!remainingAttackers.length) {
    const allBracing = Array.from(activeIds).every(
      (pid) => effectiveActions[pid].action !== 'attack',
    );
    if (allBracing) {
      const zero = Object.fromEntries(participantIds.map((pid) => [pid, 0]));
      return {
        round_number: encounter.round,
        hits: { ...zero },
        offensive_losses: { ...zero },
        defensive_losses: { ...zero },
        shield_loss: { ...zero },
        fighters_remaining: { ...fightersStart },
        shields_remaining: { ...shieldsStart },
        flee_results: fleeResults,
        end_state: 'stalemate',
        effective_actions: effectiveActions,
      };
    }
  }

  const currentFighters = { ...fightersStart };
  const attackOrder = remainingAttackers.sort((a, b) => {
    const fightersDelta = (encounter.participants[a].fighters ?? 0) - (encounter.participants[b].fighters ?? 0);
    if (fightersDelta !== 0) {
      return fightersDelta;
    }
    const warpDelta = (encounter.participants[a].turns_per_warp ?? 0) - (encounter.participants[b].turns_per_warp ?? 0);
    if (warpDelta !== 0) {
      return warpDelta;
    }
    return a.localeCompare(b);
  });
  const remainingCommits: Record<string, number> = Object.fromEntries(
    attackOrder.map((pid) => [pid, commits[pid]]),
  );

  while (Object.values(remainingCommits).some((value) => value > 0)) {
    let progressed = false;
    for (const pid of attackOrder) {
      if (remainingCommits[pid] <= 0) {
        continue;
      }
      if (!activeIds.has(pid) || currentFighters[pid] <= 0) {
        remainingCommits[pid] = 0;
        continue;
      }
      const targetId = effectiveActions[pid].target_id;
      if (!targetId || !activeIds.has(targetId) || currentFighters[targetId] <= 0) {
        remainingCommits[pid] = 0;
        continue;
      }

      remainingCommits[pid] -= 1;
      progressed = true;

      const attackState = encounter.participants[pid];
      const defendState = encounter.participants[targetId];
      const probability = clamp(
        BASE_HIT
          - (mitigations[targetId] ?? 0) * MITIGATE_HIT_FACTOR
          + (mitigations[pid] ?? 0) * ATTACK_BONUS_FACTOR,
        MIN_HIT,
        MAX_HIT,
      );
      if (rng() < probability) {
        hits[pid] += 1;
        defensiveLosses[targetId] += 1;
        currentFighters[targetId] = Math.max(0, currentFighters[targetId] - 1);
      } else {
        offensiveLosses[pid] += 1;
        currentFighters[pid] = Math.max(0, currentFighters[pid] - 1);
      }
    }
    if (!progressed) {
      break;
    }
  }

  const shieldLoss: Record<string, number> = {};
  const fightersRemaining: Record<string, number> = {};
  const shieldsRemaining: Record<string, number> = {};

  for (const pid of participantIds) {
    const state = encounter.participants[pid];
    const totalLosses = offensiveLosses[pid] + defensiveLosses[pid];
    fightersRemaining[pid] = Math.max(0, (state.fighters ?? 0) - totalLosses);
    let loss = Math.ceil(defensiveLosses[pid] * SHIELD_ABLATION_FACTOR);
    if (effectiveActions[pid].action === 'brace') {
      loss = Math.ceil(loss * 0.8);
    }
    shieldLoss[pid] = loss;
    shieldsRemaining[pid] = Math.max(0, (state.shields ?? 0) - loss);
  }

  let endState: string | null = null;
  const livingNotFled = participantIds.filter(
    (pid) => fightersRemaining[pid] > 0 && !fleeResults[pid],
  );

  if (!livingNotFled.length) {
    if (
      Object.values(fleeResults).some((v) => v) &&
      participantIds.some((pid) => fightersRemaining[pid] > 0)
    ) {
      endState = 'stalemate';
    } else {
      endState = 'mutual_defeat';
    }
  } else if (livingNotFled.length === 1) {
    const losers = participantIds.filter(
      (pid) =>
        pid !== livingNotFled[0] &&
        !fleeResults[pid] &&
        fightersRemaining[pid] <= 0,
    );
    if (losers.length) {
      if (losers.length === 1) {
        const loserId = losers[0];
        const loserName = encounter.participants[loserId]?.name ?? loserId;
        endState = `${loserName}_defeated`;
      } else {
        endState = 'victory';
      }
    } else if (
      participantIds
        .filter((pid) => pid !== livingNotFled[0])
        .every((pid) => fleeResults[pid])
    ) {
      endState = 'stalemate';
    }
  }

  return {
    round_number: encounter.round,
    hits,
    offensive_losses: offensiveLosses,
    defensive_losses: defensiveLosses,
    shield_loss: shieldLoss,
    fighters_remaining: fightersRemaining,
    shields_remaining: shieldsRemaining,
    flee_results: fleeResults,
    end_state: endState,
    effective_actions: effectiveActions,
  };
}
