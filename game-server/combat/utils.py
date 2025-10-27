"""High-level helpers for combat orchestration."""

from __future__ import annotations

import uuid
import inspect
from numbers import Number
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional

from ships import ShipType, get_ship_stats
from api.utils import ship_self
from .models import CombatEncounter, CombatantState, GarrisonState


def new_combat_id() -> str:
    return uuid.uuid4().hex


def build_character_combatant(world, character_id: str) -> CombatantState:
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_config = knowledge.ship_config
    ship_type = ShipType(ship_config.ship_type)
    stats = get_ship_stats(ship_type)

    # Get the character's display name (defaults to character_id if not set)
    character = world.characters.get(character_id)
    display_name = character.name if character else character_id

    return CombatantState(
        combatant_id=character_id,
        combatant_type="character",
        name=display_name,
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
    world = None,
    name_prefix: str = "Garrison",
) -> CombatantState:
    combatant_id = f"garrison:{sector_id}:{garrison.owner_id}"

    # Get the owner's display name (defaults to owner_id if not available)
    owner_display_name = garrison.owner_id
    if world:
        owner_character = world.characters.get(garrison.owner_id)
        if owner_character:
            owner_display_name = owner_character.name

    return CombatantState(
        combatant_id=combatant_id,
        combatant_type="garrison",
        name=f"{name_prefix} ({owner_display_name})",
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
        "sector": {"id": encounter.sector_id},
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
        "sector": {"id": encounter.sector_id},
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


# New event serialization functions (privacy-aware)


def serialize_participant_for_event(
    world,
    state: CombatantState,
    *,
    shield_integrity: float,
    shield_damage: float = 0.0,
    fighter_loss: int = 0,
) -> dict:
    """Serialize participant for combat events (privacy-aware).

    Args:
        world: World instance for looking up ship names
        state: Combatant state
        shield_integrity: Current shield percentage (0-100)
        shield_damage: Shield damage this round (negative for damage taken)
        fighter_loss: Fighters lost this round (positive number)

    Returns:
        Dict with participant data suitable for event broadcast
    """
    if state.combatant_type == "character":
        # Get ship name from knowledge
        knowledge = world.knowledge_manager.load_knowledge(state.owner_character_id)
        ship_config = knowledge.ship_config
        ship_type_value = getattr(ship_config, "ship_type", state.ship_type)
        ship_stats = None
        default_name = ship_type_value or "unknown"
        try:
            ship_type_enum = ShipType(ship_type_value)
            ship_stats = get_ship_stats(ship_type_enum)
            default_name = ship_stats.name
            ship_type_value = ship_type_enum.value
        except (ValueError, TypeError):
            pass
        ship_name = getattr(ship_config, "ship_name", None) or default_name

        # Get character creation time
        character = world.characters.get(state.owner_character_id)
        created_at = character.first_visit.isoformat() if character else utcnow_iso()

        return {
            "created_at": created_at,
            "name": state.name,  # Display name (currently character_id, will be settable)
            "player_type": "human",  # TODO: Get from character
            "ship": {
                "ship_type": ship_type_value,
                "ship_name": ship_name,
                "shield_integrity": round(shield_integrity, 1),
                "shield_damage": round(shield_damage, 1) if shield_damage != 0 else None,
                "fighter_loss": fighter_loss if fighter_loss > 0 else None,
            }
        }
    else:
        # Garrison participant - should not be in participants array
        raise ValueError("Garrisons should not be serialized as participants")


def serialize_garrison_for_event(
    garrison_state: CombatantState,
    actual_garrison: Optional["GarrisonState"] = None,
    *,
    fighter_loss: int = 0,
) -> dict:
    """Serialize garrison for combat events.

    Args:
        garrison_state: Garrison combatant state (for current fighters/shields in combat)
        actual_garrison: Actual GarrisonState object (for mode, toll info, etc.)
        fighter_loss: Fighters lost this round (for combat.round_resolved)

    Returns:
        Dict with garrison data
    """
    # Use owner_character_id which contains the owner's display name (character_id)
    # This is consistent with how participant names work
    owner_name = garrison_state.owner_character_id

    result = {
        "owner_name": owner_name,
        "fighters": garrison_state.fighters,
        "fighter_loss": fighter_loss if fighter_loss > 0 else None,
    }

    # Add garrison-specific fields if we have the actual garrison
    if actual_garrison:
        result["mode"] = actual_garrison.mode
        result["toll_amount"] = actual_garrison.toll_amount
        result["deployed_at"] = actual_garrison.deployed_at
    else:
        result["mode"] = "unknown"
        result["deployed_at"] = utcnow_iso()

    return result


def _state_matches_viewer(state: CombatantState, viewer_id: Optional[str]) -> bool:
    if viewer_id is None:
        return False
    if state.owner_character_id and state.owner_character_id == viewer_id:
        return True
    return state.combatant_id == viewer_id


def _build_ship_payload(world, viewer_id: Optional[str], state: CombatantState) -> Optional[dict]:
    if viewer_id is None or not _state_matches_viewer(state, viewer_id):
        return None
    try:
        ship_payload = dict(ship_self(world, viewer_id))
    except Exception:
        ship_payload = {
            "ship_type": state.ship_type,
            "ship_name": state.name,
            "cargo": {},
            "cargo_capacity": 0,
            "warp_power": 0,
            "warp_power_capacity": 0,
            "shields": 0,
            "max_shields": 0,
            "fighters": 0,
            "max_fighters": 0,
        }
    ship_payload["fighters"] = state.fighters
    ship_payload["max_fighters"] = state.max_fighters
    ship_payload["shields"] = state.shields
    ship_payload["max_shields"] = state.max_shields
    return ship_payload


async def serialize_round_waiting_event(
    world,
    encounter: CombatEncounter,
    viewer_id: Optional[str] = None,
) -> dict:
    """Serialize combat.round_waiting event.

    Returns dict with:
    - combat_id, sector, round
    - current_time, deadline
    - participants (array of character participants only)
    - garrison (singular object if present, else None)
    """
    current_time = datetime.now(timezone.utc)

    participants: list[dict] = []
    ship_payload: Optional[dict] = None
    garrison = None
    actual_garrison = None

    # Fetch actual garrison if present in sector
    garrisons_in_sector = await _list_sector_garrisons(world, encounter.sector_id)
    if garrisons_in_sector:
        actual_garrison = garrisons_in_sector[0]

    for state in encounter.participants.values():
        # Calculate shield integrity percentage
        max_shields = _safe_number(getattr(state, "max_shields", 0))
        shields = _safe_number(getattr(state, "shields", 0))
        shield_integrity = (shields / max_shields * 100) if max_shields > 0 else 0.0

        if state.combatant_type == "character":
            participants.append(
                serialize_participant_for_event(
                    world,
                    state,
                    shield_integrity=shield_integrity,
                )
            )
            ship_candidate = _build_ship_payload(world, viewer_id, state)
            if ship_candidate is not None:
                ship_payload = ship_candidate
        elif state.combatant_type == "garrison":
            garrison = serialize_garrison_for_event(state, actual_garrison)

    payload = {
        "combat_id": encounter.combat_id,
        "sector": {"id": encounter.sector_id},
        "round": encounter.round_number,
        "current_time": current_time.isoformat(),
        "deadline": encounter.deadline.isoformat() if encounter.deadline else None,
        "participants": participants,
        "garrison": garrison,
    }
    if encounter.round_number == 1:
        initiator_id = None
        context = getattr(encounter, "context", None)
        if isinstance(context, dict):
            initiator_id = context.get("initiator")
        payload["initiator"] = initiator_id
    if ship_payload:
        payload["ship"] = ship_payload
    return payload


async def serialize_round_resolved_event(
    world,
    encounter: CombatEncounter,
    outcome,
    viewer_id: Optional[str] = None,
    previous_encounter: Optional[CombatEncounter] = None,
) -> dict:
    """Serialize combat.round_resolved event.

    Includes shield_damage and fighter_loss deltas for each participant.
    """
    base_payload = serialize_round(encounter, outcome, include_logs=True)
    base_payload["sector"] = {"id": encounter.sector_id}

    participants_list: list[dict] = []
    ship_payload: Optional[dict] = None
    garrison = None
    actual_garrison = None

    # Fetch actual garrison if present in sector
    garrisons_in_sector = await _list_sector_garrisons(world, encounter.sector_id)
    if garrisons_in_sector:
        actual_garrison = garrisons_in_sector[0]

    # Use deltas from outcome if available (preferred), otherwise compute from previous_encounter
    deltas = (
        outcome.participant_deltas
        if hasattr(outcome, "participant_deltas") and outcome.participant_deltas
        else compute_combatant_deltas(encounter, previous_encounter)
    )

    for pid, state in encounter.participants.items():
        max_shields = _safe_number(getattr(state, "max_shields", 0))
        shields = _safe_number(getattr(state, "shields", 0))
        shield_integrity = (shields / max_shields * 100) if max_shields > 0 else 0.0

        # Compute fighter loss from deltas (fallback if explicit losses unavailable)
        delta = deltas.get(pid, {"fighters": 0, "shields": 0})
        delta_fighters = delta.get("fighters", 0) or 0
        if not isinstance(delta_fighters, (int, float)):
            try:
                delta_fighters = float(delta_fighters)
            except (TypeError, ValueError):
                delta_fighters = 0
        fighter_loss = -delta_fighters if delta_fighters < 0 else delta_fighters

        if hasattr(outcome, "offensive_losses") and hasattr(outcome, "defensive_losses"):
            offensive_loss = outcome.offensive_losses.get(pid, 0) or 0
            defensive_loss = outcome.defensive_losses.get(pid, 0) or 0
            if not isinstance(offensive_loss, (int, float)):
                offensive_loss = 0
            if not isinstance(defensive_loss, (int, float)):
                defensive_loss = 0
            fighter_loss = max(fighter_loss, offensive_loss + defensive_loss)
        fighter_loss = int(fighter_loss)

        # Get shield damage from deltas
        shield_damage = 0.0
        delta_shields = delta.get("shields", 0) or 0
        if not isinstance(delta_shields, (int, float)):
            try:
                delta_shields = float(delta_shields)
            except (TypeError, ValueError):
                delta_shields = 0
        if max_shields > 0:
            shield_damage = (delta_shields / max_shields) * 100

        if state.combatant_type == "character":
            participants_list.append(
                serialize_participant_for_event(
                    world,
                    state,
                    shield_integrity=shield_integrity,
                    shield_damage=shield_damage,
                    fighter_loss=fighter_loss,
                )
            )
            ship_candidate = _build_ship_payload(world, viewer_id, state)
            if ship_candidate is not None:
                ship_payload = ship_candidate
        elif state.combatant_type == "garrison":
            garrison = serialize_garrison_for_event(
                state,
                actual_garrison,
                fighter_loss=fighter_loss,
            )

    base_payload["participants"] = participants_list
    base_payload.pop("participants_map", None)
    base_payload.pop("fighters_remaining", None)
    base_payload.pop("shields_remaining", None)
    base_payload["garrison"] = garrison
    if ship_payload:
        base_payload["ship"] = ship_payload
    return base_payload


async def serialize_combat_ended_event(
    world,
    encounter: CombatEncounter,
    salvage_containers: list,
    logs: list[str],
    outcome,
    viewer_id: Optional[str] = None,
) -> dict:
    """Serialize combat.ended event."""
    base_payload = serialize_round(encounter, outcome, include_logs=True)
    base_payload["sector"] = {"id": encounter.sector_id}
    base_payload["salvage"] = [container.to_dict() for container in salvage_containers]
    base_payload["logs"] = logs

    participants_list: list[dict] = []
    ship_payload: Optional[dict] = None
    garrison = None
    actual_garrison = None

    garrisons_in_sector = await _list_sector_garrisons(world, encounter.sector_id)
    if garrisons_in_sector:
        actual_garrison = garrisons_in_sector[0]

    for pid, state in encounter.participants.items():
        max_shields = _safe_number(getattr(state, "max_shields", 0))
        shields = _safe_number(getattr(state, "shields", 0))
        shield_integrity = (shields / max_shields * 100) if max_shields > 0 else 0.0

        if state.combatant_type == "character":
            participants_list.append(
                serialize_participant_for_event(
                    world,
                    state,
                    shield_integrity=shield_integrity,
                )
            )
            ship_candidate = _build_ship_payload(world, viewer_id, state)
            if ship_candidate is not None:
                ship_payload = ship_candidate
        elif state.combatant_type == "garrison":
            garrison = serialize_garrison_for_event(state, actual_garrison)

    base_payload["participants"] = participants_list
    base_payload.pop("participants_map", None)
    base_payload.pop("fighters_remaining", None)
    base_payload.pop("shields_remaining", None)
    base_payload["garrison"] = garrison
    if ship_payload:
        base_payload["ship"] = ship_payload
    return base_payload
async def _list_sector_garrisons(world, sector_id: int) -> list:
    garrison_store = getattr(world, "garrisons", None)
    if not garrison_store:
        return []
    list_sector = getattr(garrison_store, "list_sector", None)
    if list_sector is None:
        return []
    result = list_sector(sector_id)
    if inspect.isawaitable(result):
        result = await result
    return result or []


def _safe_number(value, default: float = 0.0) -> float:
    if isinstance(value, Number):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
