"""High-level helpers for combat orchestration."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional

from ships import ShipType, get_ship_stats
from .models import CombatEncounter, CombatantState, GarrisonState


def new_combat_id() -> str:
    return uuid.uuid4().hex


def build_character_combatant(world, character_id: str) -> CombatantState:
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_config = knowledge.ship_config
    ship_type = ShipType(ship_config.ship_type)
    stats = get_ship_stats(ship_type)
    return CombatantState(
        combatant_id=character_id,
        combatant_type="character",
        name=character_id,
        fighters=ship_config.current_fighters,
        shields=ship_config.current_shields,
        turns_per_warp=stats.turns_per_warp,
        max_fighters=stats.fighters,
        max_shields=stats.shields,
        is_escape_pod=(ship_type == ShipType.ESCAPE_POD),
        owner_character_id=character_id,
        ship_type=ship_type.value,
    )


def build_garrison_combatant(
    sector_id: int,
    garrison: GarrisonState,
    *,
    name_prefix: str = "Garrison",
) -> CombatantState:
    combatant_id = f"garrison:{sector_id}:{garrison.owner_id}"
    return CombatantState(
        combatant_id=combatant_id,
        combatant_type="garrison",
        name=f"{name_prefix} ({garrison.owner_id})",
        fighters=garrison.fighters,
        shields=0,
        turns_per_warp=0,
        max_fighters=garrison.fighters,
        max_shields=0,
        is_escape_pod=False,
        owner_character_id=garrison.owner_id,
    )


def compute_combatant_deltas(
    current_encounter: CombatEncounter,
    previous_encounter: Optional[CombatEncounter]
) -> Dict[str, Dict[str, int]]:
    """
    Compute fighter and shield deltas for each combatant.

    Returns: {"combatant_id": {"fighters": -2, "shields": -5}, ...}

    For the first round or new participants, deltas are 0.
    """
    if not previous_encounter:
        # First round, no deltas
        return {pid: {"fighters": 0, "shields": 0} for pid in current_encounter.participants}

    deltas = {}
    for pid, current in current_encounter.participants.items():
        prev = previous_encounter.participants.get(pid)
        if prev:
            deltas[pid] = {
                "fighters": current.fighters - prev.fighters,
                "shields": current.shields - prev.shields
            }
        else:
            # New participant this round
            deltas[pid] = {"fighters": 0, "shields": 0}
    return deltas


def serialize_combatant(state: CombatantState) -> dict:
    """Serialize a combatant with all relevant fields for UI display."""
    return {
        "combatant_id": state.combatant_id,
        "combatant_type": state.combatant_type,
        "name": state.name,
        "fighters": state.fighters,
        "shields": state.shields,
        "max_fighters": state.max_fighters,
        "max_shields": state.max_shields,
        "turns_per_warp": state.turns_per_warp,
        "is_escape_pod": state.is_escape_pod,
        "owner_character_id": state.owner_character_id,
        "ship_type": state.ship_type,  # None for garrisons, ship type string for characters
    }


def serialize_encounter(encounter: CombatEncounter) -> dict:
    return {
        "combat_id": encounter.combat_id,
        "sector": encounter.sector_id,
        "round": encounter.round_number,
        "deadline": encounter.deadline.isoformat() if encounter.deadline else None,
        "participants": {
            pid: {
                "combatant_id": state.combatant_id,
                "type": state.combatant_type,
                "name": state.name,
                "fighters": state.fighters,
                "shields": state.shields,
                "max_fighters": state.max_fighters,
                "max_shields": state.max_shields,
                "turns_per_warp": state.turns_per_warp,
                "owner": state.owner_character_id,
            }
            for pid, state in encounter.participants.items()
        },
    }


def serialize_log(log) -> dict:
    return {
        "round": log.round_number,
        "actions": {
            pid: {
                "action": action.action.value,
                "commit": action.commit,
                "timed_out": action.timed_out,
                "submitted_at": action.submitted_at.isoformat(),
                "target": action.target_id,
                "destination_sector": action.destination_sector,
            }
            for pid, action in log.actions.items()
        },
        "hits": log.hits,
        "offensive_losses": log.offensive_losses,
        "defensive_losses": log.defensive_losses,
        "shield_loss": log.shield_loss,
        "result": log.result,
        "timestamp": log.timestamp.isoformat(),
    }

def serialize_round(encounter: CombatEncounter, outcome, *, include_logs: bool = False) -> dict:
    result_flag = getattr(outcome, "round_result", outcome.end_state)
    payload = {
        "combat_id": encounter.combat_id,
        "round": outcome.round_number,
        "hits": outcome.hits,
        "offensive_losses": outcome.offensive_losses,
        "defensive_losses": outcome.defensive_losses,
        "shield_loss": outcome.shield_loss,
        "fighters_remaining": outcome.fighters_remaining,
        "shields_remaining": outcome.shields_remaining,
        "flee_results": outcome.flee_results,
        "end": outcome.end_state,
        "result": result_flag,
        "deadline": encounter.deadline.isoformat() if encounter.deadline else None,
    }

    # Include participants with deltas
    participants_with_deltas = {}
    for pid, state in encounter.participants.items():
        participant_dict = serialize_combatant(state)
        # Add deltas if available
        if outcome.participant_deltas and pid in outcome.participant_deltas:
            participant_dict["fighters_delta"] = outcome.participant_deltas[pid]["fighters"]
            participant_dict["shields_delta"] = outcome.participant_deltas[pid]["shields"]
        else:
            participant_dict["fighters_delta"] = 0
            participant_dict["shields_delta"] = 0
        participants_with_deltas[pid] = participant_dict
    payload["participants"] = participants_with_deltas

    if include_logs:
        payload["actions"] = {
            pid: {
                "action": action.action.value,
                "commit": action.commit,
                "timed_out": action.timed_out,
                "submitted_at": action.submitted_at.isoformat(),
                "target": action.target_id,
                "destination_sector": action.destination_sector,
            }
            for pid, action in outcome.effective_actions.items()
        }
    return payload


def summarize_garrisons(garrisons: Iterable[GarrisonState]) -> list[dict]:
    return [garrison.to_dict() for garrison in garrisons]


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
