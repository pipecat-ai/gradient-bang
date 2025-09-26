from datetime import datetime, timezone
from fastapi import HTTPException

from .utils import build_status_payload, sector_contents
from ships import validate_ship_type
from events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if character_id is None or character_id == "":
        raise HTTPException(status_code=422, detail="Invalid or missing character_id")

    ship_type = request.get("ship_type")
    credits = request.get("credits")
    sector = request.get("sector")

    is_connected = character_id in world.characters
    # Determine if we have prior knowledge on disk
    has_saved = world.knowledge_manager.has_knowledge(character_id)
    if not is_connected:
        # Decide the starting sector
        if sector is not None:
            start_sector = sector
        elif has_saved:
            # Use last known sector if available
            last_sector = world.knowledge_manager.get_current_sector(character_id)
            start_sector = last_sector if last_sector is not None else 0
        else:
            start_sector = 0

        if start_sector < 0 or start_sector >= world.universe_graph.sector_count:
            raise HTTPException(status_code=400, detail=f"Invalid sector: {start_sector}")

        from core.world import Character
        character = Character(character_id, sector=start_sector)
        world.characters[character_id] = character

        # Initialize ship only for brand-new characters (no saved knowledge)
        if not has_saved:
            validated_ship_type = None
            if ship_type:
                validated_ship_type = validate_ship_type(ship_type)
                if not validated_ship_type:
                    raise HTTPException(status_code=400, detail=f"Invalid ship type: {ship_type}")
            world.knowledge_manager.initialize_ship(character_id, validated_ship_type)

        if credits is not None:
            world.knowledge_manager.update_credits(character_id, credits)

        await event_dispatcher.emit(
            "character.joined",
            {
                "character_id": character_id,
                "sector": start_sector,
                "timestamp": character.last_active.isoformat(),
            },
        )
    else:
        character = world.characters[character_id]
        character.update_activity()
        if sector is not None:
            if sector < 0 or sector >= world.universe_graph.sector_count:
                raise HTTPException(status_code=400, detail=f"Invalid sector: {sector}")
            old_sector = character.sector
            character.sector = sector
            await event_dispatcher.emit(
                "character.moved",
                {
                    "character_id": character_id,
                    "from_sector": old_sector,
                    "to_sector": sector,
                    "timestamp": character.last_active.isoformat(),
                    "move_type": "teleport",
                },
            )
        if credits is not None:
            world.knowledge_manager.update_credits(character_id, credits)

    contents = sector_contents(world, character.sector, character_id)
    world.knowledge_manager.update_sector_visit(
        character_id=character_id,
        sector_id=character.sector,
        port=contents.get("port"),
        position=contents.get("position", (0, 0)),
        planets=contents.get("planets", []),
        adjacent_sectors=contents.get("adjacent_sectors", []),
    )
    status_payload = build_status_payload(
        world, character_id, sector_snapshot=contents
    )

    await event_dispatcher.emit(
        "status.update",
        status_payload,
        character_filter=[character_id],
    )

    return status_payload
