"""Combat round resolution logic."""

from __future__ import annotations

import math
import random
from dataclasses import replace
from typing import Dict, Tuple, List, Optional, Set

from .models import (
    CombatEncounter,
    CombatRoundOutcome,
    CombatantAction,
    CombatantState,
    RoundAction,
)

BASE_HIT = 0.5
MIN_HIT = 0.15
MAX_HIT = 0.85
MITIGATE_HIT_FACTOR = 0.6
ATTACK_BONUS_FACTOR = 0.1
SHIELD_ABLATION_FACTOR = 0.5
FLEE_MIN = 0.2
FLEE_MAX = 0.9


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def shield_mitigation(state: CombatantState, action: CombatantAction) -> float:
    mitigation = state.mitigation()
    if action == CombatantAction.BRACE:
        mitigation = clamp(mitigation * 1.2, 0.0, 0.5)
    return mitigation


def flee_success_chance(attacker: CombatantState, defender: CombatantState) -> float:
    base = 0.5 + 0.1 * (defender.turns_per_warp - attacker.turns_per_warp)
    return clamp(base, FLEE_MIN, FLEE_MAX)


def resolve_round(
    encounter: CombatEncounter,
    actions: Dict[str, RoundAction],
) -> CombatRoundOutcome:
    """Resolve a combat round for the supplied encounter."""

    participant_ids: List[str] = sorted(encounter.participants.keys())
    seed_basis = (encounter.base_seed or 0, encounter.round_number)
    rng = random.Random(hash(seed_basis))

    # Prepare derived state containers
    commits: Dict[str, int] = {}
    effective_actions: Dict[str, RoundAction] = {}
    mitigations: Dict[str, float] = {}
    for pid in participant_ids:
        state = encounter.participants[pid]
        submitted = actions.get(pid)
        if not submitted:
            submitted = RoundAction(
                action=CombatantAction.BRACE,
                commit=0,
                timed_out=True,
                target_id=None,
                destination_sector=None,
            )
        action = submitted.action
        target_id = submitted.target_id if submitted.target_id else None
        commit = submitted.commit if action == CombatantAction.ATTACK else 0
        if action == CombatantAction.ATTACK:
            commit = max(0, min(commit, state.fighters))
            if commit <= 0 or not target_id or target_id == pid or target_id not in encounter.participants:
                action = CombatantAction.BRACE
                commit = 0
                target_id = None
        effective_actions[pid] = replace(
            submitted,
            action=action,
            commit=commit if action == CombatantAction.ATTACK else 0,
            target_id=target_id,
            destination_sector=(submitted.destination_sector if action == CombatantAction.FLEE else None),
        )
        commits[pid] = effective_actions[pid].commit
        mitigations[pid] = shield_mitigation(state, action)

    fighters_start = {pid: encounter.participants[pid].fighters for pid in participant_ids}
    shields_start = {pid: encounter.participants[pid].shields for pid in participant_ids}
    flee_results: Dict[str, bool] = {pid: False for pid in participant_ids}

    active_ids: Set[str] = set(participant_ids)

    def _pick_flee_opponent(fleer_id: str) -> Optional[CombatantState]:
        candidates = [
            encounter.participants[oid]
            for oid in sorted(active_ids)
            if oid != fleer_id
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda s: (-s.fighters, s.combatant_id))
        return candidates[0]

    successful_fleers: List[str] = []

    for pid in sorted(participant_ids):
        if pid not in active_ids:
            continue
        action = effective_actions[pid].action
        if action != CombatantAction.FLEE:
            continue
        opponent_state = _pick_flee_opponent(pid)
        if opponent_state is None:
            flee_results[pid] = True
            active_ids.discard(pid)
            continue
        chance = flee_success_chance(encounter.participants[pid], opponent_state)
        roll = rng.random()
        success = roll < chance
        flee_results[pid] = success
        if success:
            active_ids.discard(pid)
            successful_fleers.append(pid)

    remaining_attackers = [
        pid
        for pid in active_ids
        if effective_actions[pid].action == CombatantAction.ATTACK and commits[pid] > 0
    ]

    if successful_fleers and not remaining_attackers:
        zero_losses = {pid: 0 for pid in participant_ids}
        fighters_remaining = {
            pid: encounter.participants[pid].fighters for pid in participant_ids
        }
        shields_remaining = {
            pid: encounter.participants[pid].shields for pid in participant_ids
        }
        return CombatRoundOutcome(
            round_number=encounter.round_number,
            hits=zero_losses.copy(),
            offensive_losses=zero_losses.copy(),
            defensive_losses=zero_losses.copy(),
            shield_loss=zero_losses.copy(),
            fighters_remaining=fighters_remaining,
            shields_remaining=shields_remaining,
            flee_results=flee_results,
            end_state=f"{successful_fleers[0]}_fled",
            effective_actions=effective_actions,
        )

    hits = {pid: 0 for pid in participant_ids}
    offensive_losses = {pid: 0 for pid in participant_ids}
    defensive_losses = {pid: 0 for pid in participant_ids}

    if not remaining_attackers:
        all_bracing = all(
            effective_actions[pid].action != CombatantAction.ATTACK
            for pid in active_ids
        )
        if all_bracing:
            zero_dict = {pid: 0 for pid in participant_ids}
            return CombatRoundOutcome(
                round_number=encounter.round_number,
                hits=zero_dict.copy(),
                offensive_losses=zero_dict.copy(),
                defensive_losses=zero_dict.copy(),
                shield_loss={pid: 0 for pid in participant_ids},
                fighters_remaining=fighters_start.copy(),
                shields_remaining=shields_start.copy(),
                flee_results=flee_results,
                end_state="stalemate",
                effective_actions=effective_actions,
            )

    current_fighters = fighters_start.copy()

    attack_order = sorted(
        remaining_attackers,
        key=lambda pid: (
            encounter.participants[pid].fighters,
            encounter.participants[pid].turns_per_warp,
            pid,
        ),
    )
    remaining_commits = {pid: commits[pid] for pid in attack_order}

    while any(value > 0 for value in remaining_commits.values()):
        progressed = False
        for pid in attack_order:
            if remaining_commits[pid] <= 0:
                continue
            if pid not in active_ids or current_fighters.get(pid, 0) <= 0:
                remaining_commits[pid] = 0
                continue
            target_id = effective_actions[pid].target_id
            if not target_id or target_id not in active_ids:
                remaining_commits[pid] = 0
                continue
            if current_fighters.get(target_id, 0) <= 0:
                remaining_commits[pid] = 0
                continue

            remaining_commits[pid] -= 1
            progressed = True

            attack_state = encounter.participants[pid]
            defend_state = encounter.participants[target_id]
            p_hit = clamp(
                BASE_HIT
                - mitigations[target_id] * MITIGATE_HIT_FACTOR
                + mitigations[pid] * ATTACK_BONUS_FACTOR,
                MIN_HIT,
                MAX_HIT,
            )
            if rng.random() < p_hit:
                hits[pid] += 1
                defensive_losses[target_id] += 1
                current_fighters[target_id] = max(0, current_fighters[target_id] - 1)
            else:
                offensive_losses[pid] += 1
                current_fighters[pid] = max(0, current_fighters[pid] - 1)
        if not progressed:
            break

    shield_loss: Dict[str, int] = {}
    fighters_remaining: Dict[str, int] = {}
    shields_remaining: Dict[str, int] = {}

    for pid in participant_ids:
        action = effective_actions[pid].action
        state = encounter.participants[pid]
        total_losses = offensive_losses[pid] + defensive_losses[pid]
        fighters_remaining[pid] = max(0, state.fighters - total_losses)
        loss = math.ceil(defensive_losses[pid] * SHIELD_ABLATION_FACTOR)
        if action == CombatantAction.BRACE:
            loss = math.ceil(loss * 0.8)
        shield_loss[pid] = loss
        shields_remaining[pid] = max(0, state.shields - loss)

    end_state = None
    living_not_fled = [
        pid for pid in participant_ids if fighters_remaining[pid] > 0 and not flee_results.get(pid, False)
    ]

    if not living_not_fled:
        if any(flee_results.values()) and any(fighters_remaining[pid] > 0 for pid in participant_ids):
            end_state = "stalemate"
        else:
            end_state = "mutual_defeat"
    elif len(living_not_fled) == 1:
        losers = [
            pid
            for pid in participant_ids
            if pid != living_not_fled[0] and not flee_results.get(pid, False) and fighters_remaining[pid] <= 0
        ]
        if losers:
            if len(losers) == 1:
                end_state = f"{losers[0]}_defeated"
            else:
                end_state = "victory"
        elif all(flee_results.get(pid, False) for pid in participant_ids if pid != living_not_fled[0]):
            end_state = "stalemate"

    return CombatRoundOutcome(
        round_number=encounter.round_number,
        hits=hits,
        offensive_losses=offensive_losses,
        defensive_losses=defensive_losses,
        shield_loss=shield_loss,
        fighters_remaining=fighters_remaining,
        shields_remaining=shields_remaining,
        flee_results=flee_results,
        end_state=end_state,
        effective_actions=effective_actions,
    )
