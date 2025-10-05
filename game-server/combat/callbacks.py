"""Combat system callbacks that integrate with server infrastructure.

This module provides callback functions that are registered with the combat manager
to handle combat events (round waiting, round resolved, combat ended, toll payment).
"""

import logging
from typing import Any, Dict, List

from fastapi import HTTPException

from api import move as api_move
from api.utils import build_status_payload
from combat.utils import serialize_encounter, serialize_round
from combat.garrison_ai import auto_submit_garrison_actions
from combat.finalization import finalize_combat
from core.locks import CreditLockManager

logger = logging.getLogger("gradient-bang.combat.callbacks")


def extract_character_filter(encounter) -> list[str]:
    """Extract list of character IDs for event filtering.

    Args:
        encounter: Combat encounter state

    Returns:
        List of character IDs participating in combat
    """
    ids: set[str] = set()
    for state in encounter.participants.values():
        if state.owner_character_id:
            ids.add(state.owner_character_id)
        elif state.combatant_type == "character":
            ids.add(state.combatant_id)
    return list(ids)


async def emit_status_update(character_id: str, world, event_dispatcher) -> None:
    """Emit status.update event for character.

    Args:
        character_id: Character ID to emit status for
        world: Game world instance
        event_dispatcher: Event dispatcher instance
    """
    if character_id not in world.characters:
        logger.debug("emit_status_update skipped; character %s not connected", character_id)
        return

    logger.debug("emit_status_update building status for %s", character_id)
    payload = await build_status_payload(world, character_id)
    await event_dispatcher.emit(
        "status.update",
        payload,
        character_filter=[character_id],
    )
    logger.debug("emit_status_update sent for %s", character_id)


async def on_round_waiting(encounter, world, event_dispatcher) -> None:
    """Called when combat round is waiting for actions.

    - Emits combat.round_waiting event
    - Triggers garrison AI to auto-submit actions

    Args:
        encounter: Combat encounter state
        world: Game world instance
        event_dispatcher: Event dispatcher instance
    """
    payload = serialize_encounter(encounter)
    payload["sector"] = encounter.sector_id
    character_filter = extract_character_filter(encounter)

    logger.info(
        "Emitting combat.round_waiting: combat_id=%s round=%s participants=%s filter=%s",
        encounter.combat_id,
        encounter.round_number,
        list(encounter.participants.keys()),
        character_filter,
    )

    await event_dispatcher.emit(
        "combat.round_waiting",
        payload,
        character_filter=character_filter,
    )

    # Auto-submit garrison actions
    await auto_submit_garrison_actions(encounter, world.combat_manager)


async def on_round_resolved(encounter, outcome, world, event_dispatcher) -> None:
    """Called when combat round is resolved.

    - Updates knowledge manager (fighters/shields)
    - Executes flee movements via move handler
    - Emits combat.round_resolved event

    Args:
        encounter: Combat encounter state
        outcome: Combat round outcome
        world: Game world instance
        event_dispatcher: Event dispatcher instance
    """
    logger.debug(
        "on_round_resolved start: combat_id=%s round=%s end_state=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )

    # Process flee results
    flee_followups: List[Dict[str, Any]] = []
    recent_flee_ids: List[str] = []

    if outcome.flee_results:
        logger.info(
            "Processing flee_results: %s",
            {pid: fled for pid, fled in outcome.flee_results.items()},
        )
        for pid, fled in outcome.flee_results.items():
            if not fled:
                continue

            action = outcome.effective_actions.get(pid)
            logger.info(
                "Flee successful for %s: action=%s destination_sector=%s",
                pid,
                action,
                getattr(action, "destination_sector", None) if action else None,
            )

            destination = getattr(action, "destination_sector", None) if action else None
            if destination is None:
                logger.warning(
                    "Flee successful for %s but no destination recorded; skipping move.",
                    pid,
                )
                continue

            flee_followups.append(
                {
                    "character_id": pid,
                    "destination": destination,
                    "fighters": outcome.fighters_remaining.get(pid),
                    "shields": outcome.shields_remaining.get(pid),
                }
            )
            recent_flee_ids.append(str(pid))

        logger.info("flee_followups populated: %s entries", len(flee_followups))

    # Accumulate fled character IDs for combat.ended notification
    if recent_flee_ids:
        existing_fled = encounter.context.get("recent_flee_character_ids")
        if isinstance(existing_fled, list):
            # Extend with new fled IDs, avoiding duplicates
            all_fled = list(existing_fled)
            for fid in recent_flee_ids:
                if fid not in all_fled:
                    all_fled.append(fid)
            encounter.context["recent_flee_character_ids"] = all_fled
        else:
            encounter.context["recent_flee_character_ids"] = recent_flee_ids.copy()

    # Emit combat.round_resolved event
    payload = serialize_round(encounter, outcome, include_logs=True)
    payload["combat_id"] = encounter.combat_id
    payload["sector"] = encounter.sector_id

    logger.info(
        "round_resolved payload combat_id=%s round=%s result=%s end=%s",
        encounter.combat_id,
        payload.get("round"),
        payload.get("result"),
        payload.get("end"),
    )
    logger.debug(
        "Emitting combat.round_resolved: combat_id=%s round=%s end_state=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )

    base_filter = extract_character_filter(encounter)
    notify_ids = set(base_filter)
    notify_ids.update(recent_flee_ids)

    await event_dispatcher.emit(
        "combat.round_resolved",
        payload,
        character_filter=sorted(notify_ids),
    )

    logger.debug("combat.round_resolved emitted, syncing participants")

    # Sync knowledge and character state for all participants
    for state in encounter.participants.values():
        owner_id = state.owner_character_id or state.combatant_id
        if state.combatant_type != "character" or not owner_id:
            continue

        logger.debug(
            "Updating knowledge for owner_id=%s fighters=%s shields=%s",
            owner_id,
            state.fighters,
            state.shields,
        )

        world.knowledge_manager.set_fighters(
            owner_id, state.fighters, max_fighters=state.max_fighters
        )
        world.knowledge_manager.set_shields(
            owner_id, state.shields, max_shields=state.max_shields
        )

        character = world.characters.get(owner_id)
        if character:
            character.update_ship_state(
                fighters=state.fighters,
                shields=state.shields,
                max_fighters=state.max_fighters,
                max_shields=state.max_shields,
            )

        logger.debug("Emitting status update for owner_id=%s", owner_id)
        await emit_status_update(owner_id, world, event_dispatcher)

    # Update knowledge for fleeing characters
    for entry in flee_followups:
        character_id = entry["character_id"]
        fighters = entry.get("fighters")
        shields = entry.get("shields")

        if fighters is not None:
            world.knowledge_manager.set_fighters(character_id, fighters)
        if shields is not None:
            world.knowledge_manager.set_shields(character_id, shields)

        character = world.characters.get(character_id)
        if character:
            character.update_ship_state(fighters=fighters, shields=shields)

    # Execute flee movements
    logger.info("Starting flee movements: %s entries to process", len(flee_followups))
    for entry in flee_followups:
        character_id = entry["character_id"]
        destination = entry["destination"]

        logger.info(
            "Executing flee movement: character=%s from sector=%s to sector=%s",
            character_id,
            encounter.sector_id,
            destination,
        )

        try:
            await api_move.handle(
                {
                    "character_id": character_id,
                    "to_sector": destination,
                },
                world,
            )
            logger.info(
                "Flee movement completed: character=%s now in sector=%s",
                character_id,
                destination,
            )
        except HTTPException as exc:  # pragma: no cover
            logger.warning(
                "Failed to move fleeing character %s to sector %s: %s",
                character_id,
                destination,
                exc,
            )

    logger.debug("on_round_resolved complete")


async def on_combat_ended(encounter, outcome, world, event_dispatcher) -> None:
    """Called when combat ends.

    - Calls finalization logic (salvage, escape pods, garrison updates)
    - Emits combat.ended event with salvage data

    Args:
        encounter: Combat encounter state
        outcome: Combat round outcome
        world: Game world instance
        event_dispatcher: Event dispatcher instance
    """
    logger.debug(
        "on_combat_ended start: combat_id=%s round=%s result=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )

    # Finalize combat (salvage, escape pods, garrison updates)
    salvage = await finalize_combat(
        encounter,
        outcome,
        world,
        lambda char_id: emit_status_update(char_id, world, event_dispatcher),
        event_dispatcher,
    )

    # Build and emit combat.ended event
    payload = serialize_round(encounter, outcome, include_logs=True)
    payload["combat_id"] = encounter.combat_id
    payload["sector"] = encounter.sector_id
    payload["result"] = outcome.end_state

    if salvage:
        payload["salvage"] = [container.to_dict() for container in salvage]

    logger.debug(
        "Emitting combat.ended: combat_id=%s round=%s result=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )
    logger.info("combat.ended payload %s", payload)

    # Notify all participants and recently fled characters
    base_filter = extract_character_filter(encounter)
    recent_flee_ids = encounter.context.pop("recent_flee_character_ids", [])
    notify_ids = set(base_filter)
    if isinstance(recent_flee_ids, list):
        notify_ids.update(str(cid) for cid in recent_flee_ids if cid)

    await event_dispatcher.emit(
        "combat.ended",
        payload,
        character_filter=sorted(notify_ids),
    )

    logger.debug("on_combat_ended complete: combat_id=%s", encounter.combat_id)


async def on_toll_payment(
    payer_id: str, amount: int, world, credit_locks: CreditLockManager
) -> bool:
    """Handle toll payment with atomic credit locking.

    Args:
        payer_id: Character ID paying the toll
        amount: Toll amount to deduct
        world: Game world instance
        credit_locks: CreditLockManager for atomic credit operations

    Returns:
        True if payment successful, False if insufficient credits
    """
    if amount <= 0:
        return True

    # Use credit lock manager for atomic deduction
    success = await credit_locks.deduct_credits(payer_id, amount, world)

    if success:
        # Emit status update to reflect credit change
        # Note: We can't access event_dispatcher here without additional plumbing
        # The combat manager will handle status updates after toll payment
        logger.info("Toll payment accepted: payer=%s amount=%s", payer_id, amount)
    else:
        logger.info(
            "Toll payment declined for %s (insufficient credits, required=%s)",
            payer_id,
            amount,
        )

    return success
