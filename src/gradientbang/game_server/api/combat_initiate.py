from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Dict, List, Optional
from fastapi import HTTPException

import logging

from gradientbang.game_server.combat import CombatEncounter

from gradientbang.game_server.ships import ShipType
from gradientbang.game_server.combat.utils import (
    build_character_combatant,
    build_garrison_combatant,
    new_combat_id,
    serialize_encounter,
)
from gradientbang.game_server.api.utils import rpc_success, enforce_actor_authorization

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
            if character.sector == sector_id and not character.in_hyperspace:
                states.append(build_character_combatant(world, cid))
        return states

    if garrisons_to_include is None and world.garrisons is not None:
        garrisons_to_include = await world.garrisons.list_sector(sector_id)

    def _collect_garrisons() -> tuple[List[object], List[dict]]:
        """Collect garrisons to add as combat participants WITHOUT removing them from sector.

        Garrisons remain visible in sector_contents during combat so clients can:
        - Display toll demands
        - Offer "pay" action
        - Show garrison status
        """
        results: List[object] = []
        sources: List[dict] = []
        if not garrisons_to_include or world.garrisons is None:
            return results, sources
        for garrison in garrisons_to_include:
            owner_id = getattr(garrison, "owner_id", None)
            if owner_id is None or garrison.fighters <= 0:
                continue
            # Reference garrison without removing it from the store
            results.append(build_garrison_combatant(sector_id, garrison, world=world))
            sources.append(
                {
                    "sector": sector_id,
                    "owner_id": owner_id,
                    "fighters": garrison.fighters,
                    "mode": garrison.mode,
                    "toll_amount": garrison.toll_amount,
                    "toll_balance": garrison.toll_balance,
                    "deployed_at": garrison.deployed_at,
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
            if (
                character.sector == sector_id
                and cid not in existing.participants
                and not character.in_hyperspace
            ):
                await manager.add_participant(
                    existing.combat_id,
                    build_character_combatant(world, cid),
                )
        garrison_states, garrison_sources = _collect_garrisons()
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
    garrison_states, garrison_sources = _collect_garrisons()
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
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

    if character_id not in world.characters:
        raise HTTPException(
            status_code=404, detail=f"Character '{character_id}' not found"
        )

    initiator = world.characters[character_id]

    fighters = getattr(initiator, "fighters", 0) or 0
    if fighters <= 0:
        ship = world.knowledge_manager.get_ship(character_id)
        fighters = ship.get("state", {}).get("fighters", 0)
    if fighters <= 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot initiate combat while you have no fighters.",
        )

    sector_id = initiator.sector

    corp_cache = getattr(world, "character_to_corp", None)
    initiator_corp = None
    if isinstance(corp_cache, dict):
        initiator_corp = corp_cache.get(character_id)

    targetable_found = False
    for other_id, other_char in world.characters.items():
        if other_id == character_id:
            continue
        if other_char.sector != sector_id or other_char.in_hyperspace:
            continue

        same_corp = False
        if initiator_corp and isinstance(corp_cache, dict):
            other_corp = corp_cache.get(other_id)
            same_corp = bool(other_corp and initiator_corp == other_corp)
        if same_corp:
            continue

        ship = world.knowledge_manager.get_ship(other_id)
        ship_type_value = ship.get("ship_type")
        try:
            ship_type = ShipType(ship_type_value)
        except ValueError:
            ship_type = None
        if ship_type == ShipType.ESCAPE_POD:
            continue

        fighters_available = ship.get("state", {}).get("fighters", 0)
        if fighters_available <= 0:
            continue

        targetable_found = True
        break

    if not targetable_found:
        garrison_store = getattr(world, "garrisons", None)
        if garrison_store is not None:
            garrisons = await garrison_store.list_sector(sector_id)
            for garrison in garrisons:
                owner_id = getattr(garrison, "owner_id", None)
                if not owner_id or owner_id == character_id:
                    continue
                if garrison.fighters <= 0:
                    continue
                if initiator_corp and isinstance(corp_cache, dict):
                    owner_corp = corp_cache.get(owner_id)
                    if owner_corp and owner_corp == initiator_corp:
                        continue
                targetable_found = True
                break

    if not targetable_found:
        raise HTTPException(
            status_code=409,
            detail="No targetable opponents available to engage",
        )

    payload = await start_sector_combat(
        world,
        sector_id=sector_id,
        initiator_id=character_id,
        garrisons_to_include=None,
        reason="manual",
    )
    combat_id = payload.get("combat_id")
    if not combat_id:
        logger.warning(
            "start_sector_combat returned payload without combat_id for %s in sector %s",
            character_id,
            sector_id,
        )
        return rpc_success()
    return rpc_success({"combat_id": combat_id})
