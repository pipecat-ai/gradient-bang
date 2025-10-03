from fastapi import HTTPException


async def handle(request: dict, world) -> dict:
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    from_sector = request.get("from_sector")
    to_sector = request.get("to_sector")
    if from_sector is None or to_sector is None:
        raise HTTPException(status_code=400, detail="Missing from_sector or to_sector")

    if from_sector < 0 or to_sector < 0:
        raise HTTPException(status_code=422, detail="Sectors must be non-negative")

    if from_sector >= world.universe_graph.sector_count:
        raise HTTPException(status_code=400, detail=f"Invalid from_sector: {from_sector}")
    if to_sector >= world.universe_graph.sector_count:
        raise HTTPException(status_code=400, detail=f"Invalid to_sector: {to_sector}")

    path = world.universe_graph.find_path(from_sector, to_sector)
    if path is None:
        raise HTTPException(status_code=404, detail=f"No path found from sector {from_sector} to sector {to_sector}")

    return {"from_sector": from_sector, "to_sector": to_sector, "path": path, "distance": len(path) - 1}

