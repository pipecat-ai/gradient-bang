from fastapi import HTTPException

from .utils import sector_contents, build_status_payload
from ships import ShipType, get_ship_stats
from events import event_dispatcher


async def handle(request: dict, world) -> dict:
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    character_id = request.get("character_id")
    to_sector = request.get("to_sector")
    if to_sector is None and "to" in request:
        to_sector = request.get("to")

    if not character_id or to_sector is None:
        raise HTTPException(status_code=400, detail="Missing character_id or to_sector")
    if to_sector < 0:
        raise HTTPException(status_code=422, detail="Invalid destination sector")

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Character '{character_id}' not found. Join the game first.")

    character = world.characters[character_id]
    current_sector = character.sector

    if to_sector >= world.universe_graph.sector_count:
        raise HTTPException(status_code=400, detail=f"Invalid sector: {to_sector}")

    adjacent_sectors = world.universe_graph.adjacency.get(current_sector, [])
    if to_sector not in adjacent_sectors:
        raise HTTPException(status_code=400, detail=f"Sector {to_sector} is not adjacent to current sector {current_sector}")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
    warp_cost = ship_stats.turns_per_warp
    if knowledge.ship_config.current_warp_power < warp_cost:
        raise HTTPException(status_code=400, detail=f"Insufficient warp power. Need {warp_cost} units but only have {knowledge.ship_config.current_warp_power}")

    knowledge.ship_config.current_warp_power -= warp_cost
    world.knowledge_manager.save_knowledge(knowledge)

    old_sector = character.sector
    character.sector = to_sector
    character.update_activity()

    contents = sector_contents(world, character.sector, character_id)
    world.knowledge_manager.update_sector_visit(
        character_id=character_id,
        sector_id=character.sector,
        port=contents.get("port"),
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

    await event_dispatcher.emit(
        "character.moved",
        {
            "character_id": character_id,
            "from_sector": old_sector,
            "to_sector": to_sector,
            "timestamp": character.last_active.isoformat(),
            "move_type": "normal",
        },
    )

    return status_payload
