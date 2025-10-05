"""Local map region endpoint - returns known sectors around a center point."""

import logging
from collections import deque
from typing import Dict, Any, Set, Tuple

from fastapi import HTTPException

from .utils import sector_contents

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

    # Parse limits
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

    # Build map of visited sectors and their adjacents
    visited_sectors = set(int(k) for k in knowledge.sectors_visited.keys())

    # BFS to find sectors within range
    result_sectors = []
    distance_map: Dict[int, int] = {center_sector: 0}
    queue = deque([(center_sector, 0)])
    visited_in_bfs = {center_sector}

    # Track which unvisited sectors we've seen
    unvisited_seen: Dict[int, Set[int]] = {}  # sector_id -> set of sectors that reference it

    while queue and len(distance_map) < max_sectors:
        current, hops = queue.popleft()

        # Stop if we've exceeded max hops
        if hops >= max_hops:
            continue

        # Get adjacent sectors from knowledge if this sector is visited
        if current in visited_sectors:
            sector_knowledge = knowledge.sectors_visited[str(current)]
            adjacent = sector_knowledge.adjacent_sectors or []

            for adj_id in adjacent:
                adj_id = int(adj_id)

                if adj_id not in visited_in_bfs:
                    visited_in_bfs.add(adj_id)
                    distance_map[adj_id] = hops + 1

                    # Track unvisited sectors
                    if adj_id not in visited_sectors:
                        if adj_id not in unvisited_seen:
                            unvisited_seen[adj_id] = set()
                        unvisited_seen[adj_id].add(current)

                    # Only continue BFS from visited sectors
                    if adj_id in visited_sectors:
                        queue.append((adj_id, hops + 1))

                    # Check sector limit
                    if len(distance_map) >= max_sectors:
                        break

    # Build result with full data for visited, minimal for unvisited
    for sector_id in sorted(distance_map.keys()):
        hops_from_center = distance_map[sector_id]

        if sector_id in visited_sectors:
            # Get full sector contents
            contents = await sector_contents(world, sector_id, character_id)

            # Get last visited time
            sector_knowledge = knowledge.sectors_visited[str(sector_id)]
            last_visited = sector_knowledge.last_visited if hasattr(sector_knowledge, 'last_visited') else None

            sector_dict = {
                "sector_id": sector_id,
                "visited": True,
                "hops_from_center": hops_from_center,
                **contents
            }

            if last_visited:
                sector_dict["last_visited"] = last_visited

            result_sectors.append(sector_dict)
        else:
            # Minimal info for unvisited sectors
            result_sectors.append({
                "sector_id": sector_id,
                "visited": False,
                "hops_from_center": hops_from_center,
                "seen_from": sorted(unvisited_seen.get(sector_id, set()))
            })

    total_visited = sum(1 for s in result_sectors if s["visited"])
    total_unvisited = len(result_sectors) - total_visited

    return {
        "center_sector": center_sector,
        "sectors": result_sectors,
        "total_sectors": len(result_sectors),
        "total_visited": total_visited,
        "total_unvisited": total_unvisited
    }
