from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Dict, List, Optional
from fastapi import HTTPException

import logging

from combat import CombatEncounter
from combat.utils import (
    build_character_combatant,
    build_garrison_combatant,
    new_combat_id,
    serialize_encounter,
)
from events import event_dispatcher

logger = logging.getLogger("gradient-bang.api.combat_initiate")


async def start_sector_combat(
    world,
    *,
    sector_id: int,
    initiator_id: str,
    garrisons_to_include: Optional[List[object]] = None,
    reason: str = "manual",
):
    manager = world.combat_manager
    if manager is None:
        raise HTTPException(status_code=503, detail="Combat system not initialised")

    existing = await manager.find_encounter_in_sector(sector_id)

    def _collect_characters() -> List[object]:
        states: List[object] = []
        for cid, character in world.characters.items():
            if character.sector == sector_id:
                states.append(build_character_combatant(world, cid))
        return states

    if garrisons_to_include is None and world.garrisons is not None:
        garrisons_to_include = world.garrisons.list_sector(sector_id)

    def _pop_garrisons() -> tuple[List[object], List[dict]]:
        results: List[object] = []
        sources: List[dict] = []
        if not garrisons_to_include or world.garrisons is None:
            return results, sources
        for garrison in garrisons_to_include:
            owner_id = getattr(garrison, "owner_id", None)
            if owner_id is None:
                continue
            popped = world.garrisons.pop(sector_id, owner_id)
            if not popped or popped.fighters <= 0:
                continue
            results.append(build_garrison_combatant(sector_id, popped))
            sources.append(
                {
                    "sector": sector_id,
                    "owner_id": owner_id,
                    "fighters": popped.fighters,
                    "mode": popped.mode,
                    "toll_amount": popped.toll_amount,
                    "deployed_at": popped.deployed_at,
                }
            )
        return results, sources

    if existing:
        if initiator_id not in existing.participants:
            await manager.add_participant(
                existing.combat_id,
                build_character_combatant(world, initiator_id),
            )
        for cid, character in world.characters.items():
            if character.sector == sector_id and cid not in existing.participants:
                await manager.add_participant(
                    existing.combat_id,
                    build_character_combatant(world, cid),
                )
        garrison_states, garrison_sources = _pop_garrisons()
        for state in garrison_states:
            await manager.add_participant(existing.combat_id, state)
        if garrison_sources:
            refreshed = await manager.get_encounter(existing.combat_id)
            if refreshed:
                ctx = refreshed.context
                if not isinstance(ctx, dict):
                    ctx = {}
                    refreshed.context = ctx
                ctx.setdefault("garrison_sources", []).extend(garrison_sources)
        payload_encounter = await manager.get_encounter(existing.combat_id)
        payload = serialize_encounter(payload_encounter)
        payload["initiator"] = initiator_id
        payload["target"] = None
        payload["target_type"] = None
        logger.info(
            "Combat refresh in sector %s (reason=%s): participants=%s",
            sector_id,
            reason,
            list(payload.get("participants", {}).keys()),
        )
        return payload

    participants = _collect_characters()
    garrison_states, garrison_sources = _pop_garrisons()
    participants.extend(garrison_states)

    unique = {}
    for state in participants:
        unique[state.combatant_id] = state  # type: ignore[attr-defined]

    if len(unique) <= 1:
        raise HTTPException(status_code=409, detail="No opponents available to engage")

    encounter_context: Dict[str, object] = {
        "initiator": initiator_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "reason": reason,
    }
    if garrison_sources:
        encounter_context["garrison_sources"] = garrison_sources

    combat_id = new_combat_id()
    encounter = CombatEncounter(
        combat_id=combat_id,
        sector_id=sector_id,
        participants=unique,
        context=encounter_context,
    )

    await manager.start_encounter(encounter, emit_waiting=False)

    payload = serialize_encounter(encounter)
    payload["initiator"] = initiator_id
    payload["target"] = None
    payload["target_type"] = None

    character_filter = []
    for state in encounter.participants.values():
        if state.owner_character_id:
            character_filter.append(state.owner_character_id)
        elif state.combatant_type == "character":
            character_filter.append(state.combatant_id)
    character_filter = sorted(set(character_filter))

    await event_dispatcher.emit(
        "combat.started",
        payload,
        character_filter=character_filter,
    )

    logger.info(
        "Combat initiated in sector %s (reason=%s): participants=%s",
        sector_id,
        reason,
        list(payload.get("participants", {}).keys()),
    )

    asyncio.create_task(manager.emit_round_waiting(encounter.combat_id))

    return payload


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    target_id = request.get("target_id")
    target_type = (request.get("target_type") or "character").lower()

    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Character '{character_id}' not found")

    initiator = world.characters[character_id]

    sector_id = initiator.sector
    payload = await start_sector_combat(
        world,
        sector_id=sector_id,
        initiator_id=character_id,
        garrisons_to_include=None,
        reason="manual",
    )
    payload["target"] = target_id
    if target_id:
        payload["target_type"] = target_type
    return payload
