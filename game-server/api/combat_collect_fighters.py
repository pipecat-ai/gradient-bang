from __future__ import annotations

from fastapi import HTTPException

from rpc.events import event_dispatcher



async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    sector = request.get("sector")
    quantity = int(request.get("quantity") or 0)

    if not character_id or sector is None:
        raise HTTPException(status_code=400, detail="Missing character_id or sector")

    if quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be positive")

    if world.garrisons is None:
        raise HTTPException(status_code=503, detail="Garrison system unavailable")

    garrisons = await world.garrisons.list_sector(sector)
    garrison = next((g for g in garrisons if g.owner_id == character_id), None)
    if not garrison:
        raise HTTPException(status_code=404, detail="No garrison found for character in this sector")

    if quantity > garrison.fighters:
        raise HTTPException(status_code=400, detail="Cannot collect more fighters than stationed")

    remaining_fighters = garrison.fighters - quantity
    toll_payout = garrison.toll_balance if garrison.mode == "toll" else 0
    if toll_payout > 0:
        current_credits = world.knowledge_manager.get_credits(character_id)
        world.knowledge_manager.update_credits(character_id, current_credits + toll_payout)

    if remaining_fighters > 0:
        await world.garrisons.deploy(
            sector_id=sector,
            owner_id=character_id,
            fighters=remaining_fighters,
            mode=garrison.mode,
            toll_amount=garrison.toll_amount,
            toll_balance=0,
        )
    else:
        await world.garrisons.remove(sector, character_id)

    world.knowledge_manager.adjust_fighters(character_id, quantity)
    updated_knowledge = world.knowledge_manager.load_knowledge(character_id)
    character = world.characters.get(character_id)
    if character:
        character.update_ship_state(
            fighters=updated_knowledge.ship_config.current_fighters,
            max_fighters=character.max_fighters,
        )

    await event_dispatcher.emit(
        "sector.garrison_updated",
        {
            "sector": sector,
            "garrisons": await world.garrisons.to_payload(sector) if world.garrisons else [],
        },
        character_filter=[character_id],
    )

    return {
        "sector": sector,
        "credits_collected": toll_payout,
        "garrison": None if remaining_fighters <= 0 else {
            "owner_id": character_id,
            "fighters": remaining_fighters,
            "mode": garrison.mode,
            "toll_amount": garrison.toll_amount,
            "toll_balance": 0,
            "deployed_at": garrison.deployed_at,
        },
        "fighters_on_ship": updated_knowledge.ship_config.current_fighters,
    }
