from datetime import datetime, timezone
import asyncio
from fastapi import HTTPException

from .utils import build_ship_status
from ships import validate_ship_type


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

        join_event = {
            "event": "join",
            "character": character_id,
            "sector": start_sector,
            "timestamp": character.last_active.isoformat(),
        }
        asyncio.create_task(world.connection_manager.broadcast_event(join_event))
    else:
        character = world.characters[character_id]
        character.update_activity()
        if sector is not None:
            if sector < 0 or sector >= world.universe_graph.sector_count:
                raise HTTPException(status_code=400, detail=f"Invalid sector: {sector}")
            old_sector = character.sector
            character.sector = sector
            move_event = {
                "event": "admin_move",
                "character": character_id,
                "from_sector": old_sector,
                "to_sector": sector,
                "timestamp": character.last_active.isoformat(),
            }
            asyncio.create_task(world.connection_manager.broadcast_event(move_event))
        if credits is not None:
            world.knowledge_manager.update_credits(character_id, credits)

    from .utils import sector_contents
    contents = sector_contents(world, character.sector, character_id)
    world.knowledge_manager.update_sector_visit(
        character_id=character_id,
        sector_id=character.sector,
        port_info=contents.get("port"),
        planets=contents.get("planets", []),
        adjacent_sectors=contents.get("adjacent_sectors", []),
    )

    return {
        **character.to_response(),
        "sector_contents": contents,
        "ship": build_ship_status(world, character_id),
    }
