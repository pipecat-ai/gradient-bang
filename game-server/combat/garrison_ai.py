"""Garrison automated combat behavior.

This module handles automated action submission for garrison combatants in combat,
including offensive, defensive, and toll mode behaviors.
"""

import logging
from typing import Dict, List, Optional

from combat.models import CombatantAction

logger = logging.getLogger("gradient-bang.combat.garrison_ai")


def calculate_garrison_commit(mode: str, fighters: int) -> int:
    """Calculate how many fighters garrison commits based on mode.

    Args:
        mode: Garrison mode ("offensive", "defensive", or "toll")
        fighters: Total fighters available

    Returns:
        Number of fighters to commit to attack
    """
    if fighters <= 0:
        return 0

    mode = (mode or "offensive").lower()

    if mode == "defensive":
        # Defensive: commit fewer fighters (1/4, min 25)
        return max(1, min(fighters, max(25, fighters // 4)))

    if mode == "toll":
        # Toll: commit moderate fighters (1/3, min 50)
        return max(1, min(fighters, max(50, fighters // 3)))

    # Offensive (default): commit more fighters (1/2, min 50)
    return max(1, min(fighters, max(50, fighters // 2)))


async def auto_submit_garrison_actions(encounter, manager) -> None:
    """Auto-submit actions for all garrison participants.

    Handles:
    - Offensive/defensive garrison behavior (attack strongest target)
    - Toll garrison behavior (demand payment, then attack if not paid)

    Args:
        encounter: Combat encounter state
        manager: CombatManager instance
    """
    if not manager:
        return

    # Extract garrison sources from encounter context
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

    # Ensure context has toll registry
    if not isinstance(encounter.context, dict):
        encounter.context = {}
    ctx: dict[str, object] = encounter.context  # type: ignore[assignment]
    toll_registry: dict[str, dict[str, object]] = ctx.setdefault("toll_registry", {})  # type: ignore[arg-type]

    # Process each garrison participant
    for state in encounter.participants.values():
        if state.combatant_type != "garrison":
            continue
        if state.fighters <= 0:
            continue

        # Find source info for this garrison
        source = next(
            (entry for entry in garrison_sources if entry.get("owner_id") == state.owner_character_id),
            {},
        )
        mode = source.get("mode", "offensive")
        mode = (mode or "offensive").lower()

        # Handle offensive/defensive modes
        if mode != "toll":
            await _handle_offensive_defensive_garrison(
                encounter, state, mode, manager
            )
            continue

        # Handle toll mode
        await _handle_toll_garrison(
            encounter, state, source, toll_registry, manager
        )


async def _handle_offensive_defensive_garrison(
    encounter, state, mode: str, manager
) -> None:
    """Handle offensive or defensive garrison behavior.

    Garrisons attack the strongest available enemy character.

    Args:
        encounter: Combat encounter state
        state: Garrison combatant state
        mode: Garrison mode ("offensive" or "defensive")
        manager: CombatManager instance
    """
    commit = calculate_garrison_commit(mode, state.fighters)
    if commit <= 0:
        return

    # Find enemy character targets
    target_candidates = [
        participant
        for participant in encounter.participants.values()
        if participant.combatant_type == "character"
        and participant.combatant_id != state.combatant_id
        and participant.fighters > 0
        and participant.owner_character_id != state.owner_character_id
    ]

    if not target_candidates:
        return

    # Target strongest enemy (most fighters, then shields, then id)
    target_candidates.sort(
        key=lambda participant: (
            participant.fighters,
            participant.shields,
            participant.combatant_id,
        ),
        reverse=True,
    )

    try:
        await manager.submit_action(
            combat_id=encounter.combat_id,
            combatant_id=state.combatant_id,
            action=CombatantAction.ATTACK,
            commit=commit,
            target_id=target_candidates[0].combatant_id,
        )
        logger.debug(
            "Garrison %s submitted %s attack with %d fighters targeting %s",
            state.combatant_id,
            mode,
            commit,
            target_candidates[0].combatant_id,
        )
    except ValueError as exc:
        logger.warning(
            "Failed to submit action for garrison %s: %s",
            state.combatant_id,
            exc,
        )


async def _handle_toll_garrison(
    encounter, state, source: dict, toll_registry: dict, manager
) -> None:
    """Handle toll mode garrison behavior.

    Toll garrisons:
    1. First round: BRACE (demand payment)
    2. Subsequent rounds: ATTACK with all fighters if not paid, BRACE if paid

    Args:
        encounter: Combat encounter state
        state: Garrison combatant state
        source: Garrison source info with toll_amount, toll_balance
        toll_registry: Registry tracking toll payment state per garrison
        manager: CombatManager instance
    """
    # Get or create toll registry entry for this garrison
    entry = toll_registry.setdefault(
        state.combatant_id,
        {
            "owner_id": state.owner_character_id,
            "toll_amount": source.get("toll_amount", 0),
            "toll_balance": source.get("toll_balance", 0),
            "target_id": None,
            "paid": False,
            "paid_round": None,
            "demand_round": encounter.round_number,
        },
    )

    # Select target if not already set
    if entry.get("target_id") is None:
        # Prefer combat initiator as target
        ctx = encounter.context if isinstance(encounter.context, dict) else {}
        initiator_id = ctx.get("initiator") if isinstance(ctx.get("initiator"), str) else None

        if (
            initiator_id
            and initiator_id in encounter.participants
            and encounter.participants[initiator_id].combatant_type == "character"
            and encounter.participants[initiator_id].owner_character_id != state.owner_character_id
            and encounter.participants[initiator_id].fighters > 0
        ):
            entry["target_id"] = initiator_id

        # Fall back to strongest enemy
        if entry.get("target_id") is None:
            target_candidates = [
                participant
                for participant in encounter.participants.values()
                if participant.combatant_type == "character"
                and participant.owner_character_id != state.owner_character_id
                and participant.fighters > 0
            ]
            target_candidates.sort(
                key=lambda participant: (
                    participant.fighters,
                    participant.shields,
                    participant.combatant_id,
                ),
                reverse=True,
            )
            if target_candidates:
                entry["target_id"] = target_candidates[0].combatant_id

    # Get target state
    target_id = entry.get("target_id")
    target_state = (
        encounter.participants.get(target_id) if isinstance(target_id, str) else None
    )

    # Determine action based on payment state
    demand_round = entry.setdefault("demand_round", encounter.round_number)
    already_paid = bool(entry.get("paid"))
    paid_round = entry.get("paid_round")
    target_available = bool(target_state and target_state.fighters > 0)

    action = CombatantAction.BRACE
    commit = 0
    submit_target: Optional[str] = None

    if already_paid and (paid_round is None or paid_round <= encounter.round_number):
        # Payment received, stand down
        action = CombatantAction.BRACE
    elif not already_paid and target_available:
        if encounter.round_number == demand_round:
            # First round: demand payment (brace)
            action = CombatantAction.BRACE
        else:
            # Subsequent rounds: attack with all fighters
            action = CombatantAction.ATTACK
            commit = state.fighters
            submit_target = target_state.combatant_id
    else:
        # No valid target
        action = CombatantAction.BRACE

    try:
        await manager.submit_action(
            combat_id=encounter.combat_id,
            combatant_id=state.combatant_id,
            action=action,
            commit=commit,
            target_id=submit_target,
        )
        logger.debug(
            "Toll garrison %s submitted %s (commit=%d, target=%s, paid=%s)",
            state.combatant_id,
            action.value,
            commit,
            submit_target,
            already_paid,
        )
    except ValueError as exc:
        logger.warning(
            "Failed to submit action for toll garrison %s: %s",
            state.combatant_id,
            exc,
        )
