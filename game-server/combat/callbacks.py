"""Combat system callbacks that integrate with server infrastructure.

This module provides callback functions that are registered with the combat manager
to handle combat events (round waiting, round resolved, combat ended, toll payment).
"""

import logging
from typing import Any, Dict, List

from fastapi import HTTPException

from api import move as api_move
from api.utils import build_status_payload, build_log_context
from combat.utils import (
    serialize_round_waiting_event,
    serialize_round_resolved_event,
    serialize_combat_ended_event,
)
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
        logger.debug(
            "emit_status_update skipped; character %s not connected", character_id
        )
        return

    logger.debug("emit_status_update building status for %s", character_id)
    payload = await build_status_payload(world, character_id)
    await event_dispatcher.emit(
        "status.update",
        payload,
        character_filter=[character_id],
        log_context=build_log_context(character_id=character_id, world=world),
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
    character_filter = extract_character_filter(encounter)
    unique_recipients = sorted(set(character_filter))

    logger.info(
        "Emitting combat.round_waiting: combat_id=%s round=%s participants=%s filter=%s",
        encounter.combat_id,
        encounter.round_number,
        list(encounter.participants.keys()),
        unique_recipients,
    )

    for recipient in unique_recipients:
        payload = await serialize_round_waiting_event(
            world,
            encounter,
            viewer_id=recipient,
        )
        await event_dispatcher.emit(
            "combat.round_waiting",
            payload,
            character_filter=[recipient],
            log_context=build_log_context(
                character_id=recipient,
                world=world,
                sector=encounter.sector_id,
            ),
        )

    # Auto-submit garrison actions
    await auto_submit_garrison_actions(encounter, world.combat_manager, world)


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

            destination = (
                getattr(action, "destination_sector", None) if action else None
            )
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

    # Emit combat.round_resolved event using new serializer
    # TODO: Pass previous_encounter for accurate deltas
    logger.info(
        "round_resolved event combat_id=%s round=%s",
        encounter.combat_id,
        outcome.round_number,
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

    recipients = sorted(notify_ids)
    for recipient in recipients:
        payload = await serialize_round_resolved_event(
            world,
            encounter,
            outcome,
            viewer_id=recipient,
            previous_encounter=None,
        )
        await event_dispatcher.emit(
            "combat.round_resolved",
            payload,
            character_filter=[recipient],
            log_context=build_log_context(
                character_id=recipient,
                world=world,
                sector=encounter.sector_id,
            ),
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

            # Send immediate combat.ended event to fled character
            fled_payload = {
                "combat_id": encounter.combat_id,
                "sector": {"id": encounter.sector_id},  # Where they fled FROM
                "result": "fled",
                "round": outcome.round_number,
                "fled_to_sector": destination,
                "salvage": [],  # Fled characters don't participate in salvage
            }

            await event_dispatcher.emit(
                "combat.ended",
                fled_payload,
                character_filter=[character_id],
                log_context=build_log_context(
                    character_id=character_id,
                    world=world,
                    sector=encounter.sector_id,
                ),
            )
            logger.info(
                "Sent immediate combat.ended to fled character %s (fled from sector %s to %s)",
                character_id,
                encounter.sector_id,
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

    # Build combat logs (placeholder)
    logs = []

    logger.debug(
        "Emitting combat.ended: combat_id=%s round=%s result=%s",
        encounter.combat_id,
        outcome.round_number,
        outcome.end_state,
    )

    # Notify only current participants (fled characters already received their own combat.ended)
    character_filter = extract_character_filter(encounter)
    unique_recipients = sorted(set(character_filter))

    # Clean up fled character tracking from context
    encounter.context.pop("recent_flee_character_ids", None)

    for recipient in unique_recipients:
        payload = await serialize_combat_ended_event(
            world,
            encounter,
            salvage or [],
            logs,
            outcome,
            viewer_id=recipient,
        )
        await event_dispatcher.emit(
            "combat.ended",
            payload,
            character_filter=[recipient],
            log_context=build_log_context(
                character_id=recipient,
                world=world,
                sector=encounter.sector_id,
            ),
        )

    # Emit sector.update to all characters in the sector
    # (combat ended changes sector state: salvage, escape pods, etc.)
    from api.utils import sector_contents

    # Find all characters in this sector (including those who just fled)
    characters_in_sector = [
        cid
        for cid, char in world.characters.items()
        if char.sector == encounter.sector_id and not char.in_hyperspace
    ]

    for cid in characters_in_sector:
        sector_payload = await sector_contents(
            world, encounter.sector_id, current_character_id=cid
        )
        await event_dispatcher.emit(
            "sector.update",
            sector_payload,
            character_filter=[cid],
            log_context=build_log_context(
                character_id=cid,
                world=world,
                sector=encounter.sector_id,
            ),
        )
    if characters_in_sector:
        logger.debug(
            "Emitted sector.update to %d characters in sector %s after combat ended",
            len(characters_in_sector),
            encounter.sector_id,
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
