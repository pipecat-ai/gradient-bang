"""High-level helpers for combat orchestration."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Dict, Iterable

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
