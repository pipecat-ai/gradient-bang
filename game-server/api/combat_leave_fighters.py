from __future__ import annotations

import logging

from fastapi import HTTPException

from rpc.events import event_dispatcher
from .combat_initiate import start_sector_combat


logger = logging.getLogger("gradient-bang.api.combat_leave_fighters")



async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    sector = request.get("sector")
    quantity = int(request.get("quantity") or 0)
    mode = (request.get("mode") or "offensive").lower()
    toll_amount = int(request.get("toll_amount") or 0)

    if not character_id or sector is None:
        raise HTTPException(status_code=400, detail="Missing character_id or sector")

    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")

    if world.garrisons is None:
        raise HTTPException(status_code=503, detail="Garrison system unavailable")

    if mode not in {"offensive", "defensive", "toll"}:
        raise HTTPException(status_code=400, detail="Invalid garrison mode")
    if mode != "toll" and toll_amount:
        toll_amount = 0

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Character '{character_id}' not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Character is in hyperspace, cannot leave fighters",
        )

    if character.sector != sector:
        raise HTTPException(status_code=409, detail="Character not in requested sector")

    existing_garrisons = await world.garrisons.list_sector(sector)
    for garrison in existing_garrisons:
        if garrison.owner_id != character_id:
            raise HTTPException(
                status_code=409,
                detail="Sector already contains another player's garrison; clear it before deploying your fighters.",
            )

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    current_fighters = knowledge.ship_config.current_fighters
    if quantity > current_fighters:
        raise HTTPException(status_code=400, detail="Insufficient fighters to deploy")

    # Update ship fighters
    world.knowledge_manager.adjust_fighters(character_id, -quantity)

    existing = next((g for g in existing_garrisons if g.owner_id == character_id), None)
    new_total = quantity + (existing.fighters if existing else 0)
    existing_balance = existing.toll_balance if existing else None
    try:
        updated = await world.garrisons.deploy(
            sector_id=sector,
            owner_id=character_id,
            fighters=new_total,
            mode=mode,
            toll_amount=toll_amount,
            toll_balance=existing_balance,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    updated_knowledge = world.knowledge_manager.load_knowledge(character_id)
    remaining = updated_knowledge.ship_config.current_fighters
    character.update_ship_state(fighters=remaining, max_fighters=character.max_fighters)

    await event_dispatcher.emit(
        "sector.garrison_updated",
        {
            "sector": sector,
            "garrisons": await world.garrisons.to_payload(sector),
        },
        character_filter=[character_id],
    )

    if mode == "offensive":
        await _auto_attack_on_deploy(world, sector, character_id, updated)

    return {
        "sector": sector,
        "garrison": updated.to_dict(),
        "fighters_remaining": remaining,
    }


async def _auto_attack_on_deploy(world, sector: int, owner_id: str, garrison_state) -> None:
    manager = world.combat_manager
    if manager is None:
        return
    opponents = [
        cid
        for cid, character in world.characters.items()
        if character.sector == sector and cid != owner_id
    ]
    if not opponents:
        return
    try:
        await start_sector_combat(
            world,
            sector_id=sector,
            initiator_id=owner_id,
            garrisons_to_include=[garrison_state],
            reason="garrison_deploy_auto",
        )
    except HTTPException as exc:
        logger.warning(
            "Auto combat on garrison deploy failed in sector %s: %s",
            sector,
            exc,
        )
