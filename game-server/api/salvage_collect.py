from __future__ import annotations

from fastapi import HTTPException
from rpc.events import event_dispatcher
from api.utils import sector_contents


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    salvage_id = request.get("salvage_id")

    if not character_id or not salvage_id:
        raise HTTPException(status_code=400, detail="Missing character_id or salvage_id")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Character is in hyperspace, cannot collect salvage",
        )

    if world.salvage_manager is None:
        raise HTTPException(status_code=503, detail="Salvage system unavailable")

    container = world.salvage_manager.claim(salvage_id, character_id)
    if not container:
        raise HTTPException(status_code=404, detail="Salvage not available")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    cargo = knowledge.ship_config.cargo.copy()

    for commodity, amount in container.cargo.items():
        if amount <= 0:
            continue
        if commodity in cargo:
            world.knowledge_manager.update_cargo(character_id, commodity, amount)
        else:
            # Treat unknown salvage as neuro_symbolics scrap
            world.knowledge_manager.update_cargo(character_id, "neuro_symbolics", amount)

    if container.scrap:
        world.knowledge_manager.update_cargo(character_id, "neuro_symbolics", container.scrap)

    if container.credits:
        existing = world.knowledge_manager.get_credits(character_id)
        world.knowledge_manager.update_credits(character_id, existing + container.credits)

    world.salvage_manager.remove(salvage_id)

    # Emit sector.update to all characters in the sector (salvage removed)
    sector_id = character.sector
    sector_update_payload = await sector_contents(world, sector_id, current_character_id=None)

    characters_in_sector = [
        cid
        for cid, char in world.characters.items()
        if char.sector == sector_id and not char.in_hyperspace
    ]

    if characters_in_sector:
        await event_dispatcher.emit(
            "sector.update",
            sector_update_payload,
            character_filter=characters_in_sector,
        )

    return {
        "salvage": container.to_dict(),
        "cargo": world.knowledge_manager.load_knowledge(character_id).ship_config.cargo,
        "credits": world.knowledge_manager.get_credits(character_id),
    }
