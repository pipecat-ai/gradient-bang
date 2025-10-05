from fastapi import HTTPException


async def handle(request: dict, world) -> dict:
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    character_id = request.get("character_id")
    to_sector = request.get("to_sector")

    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    if to_sector is None:
        raise HTTPException(status_code=400, detail="Missing to_sector")

    # Get character's current sector
    character = world.characters.get(character_id)
    if not character:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_id}")

    from_sector = character.sector

    if to_sector < 0:
        raise HTTPException(status_code=422, detail="Sectors must be non-negative")

    if to_sector >= world.universe_graph.sector_count:
        raise HTTPException(status_code=400, detail=f"Invalid to_sector: {to_sector}")

    path = world.universe_graph.find_path(from_sector, to_sector)
    if path is None:
        raise HTTPException(status_code=404, detail=f"No path found from sector {from_sector} to sector {to_sector}")

    return {"from_sector": from_sector, "to_sector": to_sector, "path": path, "distance": len(path) - 1}

