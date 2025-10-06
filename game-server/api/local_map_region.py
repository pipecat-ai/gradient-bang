"""Local map region endpoint - returns known sectors around a center point."""

import logging
from typing import Dict, Any

from fastapi import HTTPException

from .utils import build_local_map_region

logger = logging.getLogger("gradient-bang.api.local_map_region")


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Return sectors known to character in region around center sector.

    Request:
        character_id: str (required)
        center_sector: int (optional, defaults to current sector)
        max_hops: int (optional, default 3, max 10)
        max_sectors: int (optional, default 100)

    Response:
        center_sector: int
        sectors: list of sector dicts
        total_sectors: int
        total_visited: int
        total_unvisited: int
    """
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")

    # Load knowledge
    knowledge = world.knowledge_manager.load_knowledge(character_id)

    # Determine center sector
    center_sector = request.get("center_sector")
    if center_sector is None:
        if character_id in world.characters:
            center_sector = world.characters[character_id].sector
        else:
            center_sector = knowledge.current_sector if knowledge.current_sector is not None else 0
    else:
        center_sector = int(center_sector)

    # Validate center sector is visited
    if str(center_sector) not in knowledge.sectors_visited:
        raise HTTPException(
            status_code=400,
            detail=f"Center sector {center_sector} must be a visited sector"
        )

    # Parse and validate limits
    max_hops = request.get("max_hops", 3)
    max_sectors = request.get("max_sectors", 100)

    try:
        max_hops = int(max_hops)
        if max_hops < 0 or max_hops > 10:
            raise ValueError("max_hops must be between 0 and 10")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="max_hops must be an integer between 0 and 10") from exc

    try:
        max_sectors = int(max_sectors)
        if max_sectors <= 0:
            raise ValueError("max_sectors must be positive")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="max_sectors must be a positive integer") from exc

    # Use utility function to build the map
    return await build_local_map_region(
        world,
        character_id=character_id,
        center_sector=center_sector,
        max_hops=max_hops,
        max_sectors=max_sectors,
    )
