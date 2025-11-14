"""Combat aftermath processing and cleanup.

This module handles all post-combat finalization logic including:
- Defeated character cleanup (escape pod conversion, salvage creation)
- Garrison updates (surviving or destroyed)
- Credit transfers to winners
- Toll balance distribution
"""

import logging
from typing import List, Dict, Optional

from ships import ShipType, get_ship_stats

logger = logging.getLogger("gradient-bang.combat.finalization")


def resolve_participant_owner(encounter, participant_id: str) -> Optional[str]:
    """Extract owner ID from participant state.

    Args:
        encounter: Combat encounter state
        participant_id: Participant ID to resolve owner for

    Returns:
        Owner character ID if available, None otherwise
    """
    state = encounter.participants.get(participant_id)
    if not state:
        return None
    return state.owner_character_id or (
        state.combatant_id if state.combatant_type == "character" else None
    )


async def finalize_combat(
    encounter,
    outcome,
    world,
    emit_status_update,
    event_dispatcher,
):
    """Handle all combat finalization logic.

    Processes:
    1. Surviving/destroyed garrisons
    2. Toll balance distribution to victors
    3. Defeated character cleanup (escape pod conversion, salvage creation)
    4. Credit transfers to winners

    Args:
        encounter: Combat encounter state
        outcome: Combat round outcome
        world: Game world instance
        emit_status_update: Async function to emit status updates (character_id) -> None
        event_dispatcher: Event dispatcher for garrison updates

    Returns:
        List of salvage containers created
    """
    salvages = []

    fighters_remaining = (
        outcome.fighters_remaining if outcome.fighters_remaining else {}
    )
    flee_results = outcome.flee_results if outcome.flee_results else {}

    # Determine losers and winners
    losers = [pid for pid, remaining in fighters_remaining.items() if remaining <= 0]
    winners = [
        pid
        for pid, remaining in fighters_remaining.items()
        if remaining > 0 and not flee_results.get(pid, False)
    ]

    # Find first winner's owner for credit/toll transfers
    winner_owner = None
    for pid in winners:
        owner = resolve_participant_owner(encounter, pid)
        if owner:
            winner_owner = owner
            break

    # Update garrisons
    toll_winnings = await _update_garrisons_after_combat(
        encounter,
        winner_owner,
        world,
        emit_status_update,
        event_dispatcher,
    )

    # Distribute toll winnings to victor
    if toll_winnings and winner_owner:
        for recipient, amount in toll_winnings.items():
            credits = world.knowledge_manager.get_ship_credits(recipient)
            world.knowledge_manager.update_ship_credits(recipient, credits + amount)
            logger.info(
                "Awarded %s toll credits to victor %s from destroyed garrisons",
                amount,
                recipient,
            )
            await emit_status_update(recipient)

    # Process defeated characters
    salvages = await _process_defeated_characters(
        encounter,
        losers,
        winner_owner,
        world,
        emit_status_update,
    )

    return salvages


async def _update_garrisons_after_combat(
    encounter,
    winner_owner: Optional[str],
    world,
    emit_status_update,
    event_dispatcher,
) -> Dict[str, int]:
    """Update or remove garrisons based on combat outcome.

    Args:
        encounter: Combat encounter state
        winner_owner: Winner's character ID (for toll distribution)
        world: Game world instance
        emit_status_update: Async function to emit status updates
        event_dispatcher: Event dispatcher for garrison updates

    Returns:
        Dict of toll winnings by owner_id
    """
    # Extract garrison sources from context
    garrison_sources: List[dict] = []
    if isinstance(encounter.context, dict):
        ctx = encounter.context
        sources = ctx.get("garrison_sources")
        if isinstance(sources, list):
            garrison_sources = [dict(item) for item in sources]
        else:
            single = ctx.get("garrison_source")
            if isinstance(single, dict):
                garrison_sources = [dict(single)]

    garrison_lookup = {
        entry.get("owner_id"): entry
        for entry in garrison_sources
        if entry.get("owner_id")
    }
    notified_owners: set[str] = set()
    toll_winnings: Dict[str, int] = {}

    # Update or remove garrisons based on surviving fighters
    for pid, state in encounter.participants.items():
        if state.combatant_type != "garrison":
            continue
        owner = state.owner_character_id
        if not owner or not world.garrisons:
            continue

        if state.fighters > 0:
            # Update surviving garrison
            source_info = garrison_lookup.get(owner, {})
            mode = source_info.get("mode", "offensive")
            toll_amount = source_info.get("toll_amount", 0)
            toll_balance = source_info.get("toll_balance", 0)

            try:
                await world.garrisons.deploy(
                    sector_id=encounter.sector_id,
                    owner_id=owner,
                    fighters=state.fighters,
                    mode=mode,
                    toll_amount=toll_amount,
                    toll_balance=toll_balance,
                )
                await emit_status_update(owner)
                notified_owners.add(owner)
            except Exception as exc:
                logger.warning(
                    "Failed to update garrison for owner=%s sector=%s: %s",
                    owner,
                    encounter.sector_id,
                    exc,
                )
        else:
            # Remove destroyed garrison
            try:
                await world.garrisons.remove(encounter.sector_id, owner)
                logger.info(
                    "Removed destroyed garrison for owner=%s from sector=%s",
                    owner,
                    encounter.sector_id,
                )
                await emit_status_update(owner)
                notified_owners.add(owner)
            except Exception:
                # Garrison already removed or never existed in store
                pass

    # Calculate toll winnings from destroyed garrisons
    surviving_garrison_owners = {
        state.owner_character_id
        for state in encounter.participants.values()
        if state.combatant_type == "garrison"
        and state.owner_character_id
        and state.fighters > 0
    }

    for source in garrison_sources:
        owner = source.get("owner_id")
        if not owner or owner in surviving_garrison_owners:
            continue
        balance = int(source.get("toll_balance", 0) or 0)
        if balance <= 0 or not winner_owner:
            continue
        toll_winnings[winner_owner] = toll_winnings.get(winner_owner, 0) + balance

    # Emit garrison update events
    if garrison_sources and world.garrisons:
        for source in garrison_sources:
            owner = source.get("owner_id")
            if owner and owner not in notified_owners:
                await emit_status_update(owner)

    return toll_winnings


async def _process_defeated_characters(
    encounter,
    losers: List[str],
    winner_owner: Optional[str],
    world,
    emit_status_update,
) -> list:
    """Handle defeated character cleanup.

    Processes:
    - Create salvage from cargo and ship scrap
    - Transfer credits to winner
    - Convert defeated character to escape pod

    Args:
        encounter: Combat encounter state
        losers: List of defeated participant IDs
        winner_owner: Winner's character ID (for credit transfer)
        world: Game world instance
        emit_status_update: Async function to emit status updates

    Returns:
        List of salvage containers created
    """
    salvages = []

    for loser_pid in losers:
        state = encounter.participants.get(loser_pid)
        if not state or state.combatant_type != "character":
            continue

        owner_id = state.owner_character_id or state.combatant_id
        if not owner_id:
            continue

        ship = world.knowledge_manager.get_ship(owner_id)
        ship_type = ShipType(ship["ship_type"])

        # Skip if already in escape pod
        if ship_type == ShipType.ESCAPE_POD:
            continue

        stats = get_ship_stats(ship_type)
        state = ship.get("state", {})
        cargo = {k: v for k, v in state.get("cargo", {}).items() if v > 0}
        credits = world.knowledge_manager.get_ship_credits(owner_id)
        scrap = max(5, stats.price // 1000)

        # Get ship name for metadata
        ship_name = ship.get("name") or stats.name

        salvage_credits = credits if isinstance(credits, int) and credits > 0 else 0
        world.knowledge_manager.update_ship_credits(owner_id, 0)

        # Create salvage container
        if world.salvage_manager and (cargo or scrap or salvage_credits):
            salvages.append(
                world.salvage_manager.create(
                    sector=encounter.sector_id,
                    cargo=cargo,
                    scrap=scrap,
                    credits=salvage_credits,
                    metadata={
                        "ship_type": ship_type.value,
                        "ship_name": ship_name,
                        "combat_id": encounter.combat_id,
                    },
                )
            )

        corp_owned = (
            ship.get("owner_type") == "corporation"
            and ship.get("ship_id") == owner_id
        )

        if corp_owned:
            corp_id = ship.get("owner_id")
            if corp_id:
                try:
                    world.corporation_manager.remove_ship(corp_id, owner_id)
                except FileNotFoundError:
                    pass
            world.character_to_corp.pop(owner_id, None)
            registry = getattr(world, "character_registry", None)
            if registry is not None:
                registry.delete(owner_id)
            world.knowledge_manager.delete_knowledge(owner_id)
            world.ships_manager.delete_ship(owner_id)
            world.characters.pop(owner_id, None)
            logger.info(
                "Defeated corporation ship %s destroyed with no escape pod",
                owner_id,
            )
        else:
            # Convert to escape pod for personal ships
            owner_character = world.characters.get(owner_id)
            former_owner_name = owner_character.name if owner_character else owner_id
            world.knowledge_manager.create_ship_for_character(
                owner_id,
                ShipType.ESCAPE_POD,
                sector=encounter.sector_id,
                abandon_existing=True,
                former_owner_name=former_owner_name,
            )
            await emit_status_update(owner_id)

        # Update winner status
        if winner_owner:
            await emit_status_update(winner_owner)

        if not corp_owned:
            logger.info(
                "Defeated character %s converted to escape pod, salvage created in sector %s",
                owner_id,
                encounter.sector_id,
            )

    return salvages
