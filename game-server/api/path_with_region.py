"""Path with region endpoint - returns path plus local context around each node."""

import logging
from collections import deque
from typing import Dict, Any, Set

from fastapi import HTTPException

from .utils import sector_contents

logger = logging.getLogger("gradient-bang.api.path_with_region")


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Return path to destination plus context around each path node.

    Request:
        character_id: str (required)
        to_sector: int (required)
        region_hops: int (optional, default 1, how many hops around each path node)
        max_sectors: int (optional, default 200, total sector limit)

    Response:
        path: list of sector IDs on shortest path
        distance: int (number of hops)
        sectors: list of sector dicts (on-path and nearby known sectors)
        total_sectors: int
        known_sectors: int (visited)
        unknown_sectors: int (on path but not visited)
    """
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

    try:
        to_sector = int(to_sector)
        if to_sector < 0:
            raise ValueError()
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="to_sector must be a non-negative integer") from exc

    if to_sector >= world.universe_graph.sector_count:
        raise HTTPException(status_code=400, detail=f"Invalid to_sector: {to_sector}")

    # Parse options
    region_hops = request.get("region_hops", 1)
    max_sectors = request.get("max_sectors", 200)

    try:
        region_hops = int(region_hops)
        if region_hops < 0:
            raise ValueError()
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="region_hops must be a non-negative integer") from exc

    try:
        max_sectors = int(max_sectors)
        if max_sectors <= 0:
            raise ValueError()
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="max_sectors must be a positive integer") from exc

    # Find path using universe graph
    path = world.universe_graph.find_path(from_sector, to_sector)
    if path is None:
        raise HTTPException(status_code=404, detail=f"No path found from sector {from_sector} to sector {to_sector}")

    # Load knowledge
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    visited_sectors = set(int(k) for k in knowledge.sectors_visited.keys())

    # Build set of sectors to include: path nodes + neighbors of path nodes
    path_set = set(path)
    sectors_to_include: Set[int] = set(path)
    sectors_with_distance: Dict[int, int] = {}  # sector_id -> hops_from_path

    # For each path node, add its region
    for path_node in path:
        sectors_with_distance[path_node] = 0  # On path

        if path_node in visited_sectors and region_hops > 0:
            # BFS to get nearby known sectors
            distance_map: Dict[int, int] = {path_node: 0}
            queue = deque([(path_node, 0)])
            visited_in_bfs = {path_node}

            while queue and len(sectors_to_include) < max_sectors:
                current, hops = queue.popleft()

                if hops >= region_hops:
                    continue

                # Only explore from visited sectors
                if current in visited_sectors:
                    sector_knowledge = knowledge.sectors_visited[str(current)]
                    adjacent = sector_knowledge.adjacent_sectors or []

                    for adj_id in adjacent:
                        adj_id = int(adj_id)

                        if adj_id not in visited_in_bfs:
                            visited_in_bfs.add(adj_id)
                            distance_map[adj_id] = hops + 1

                            # Only include visited sectors in region
                            if adj_id in visited_sectors:
                                sectors_to_include.add(adj_id)

                                # Track distance from path
                                if adj_id not in path_set:
                                    if adj_id not in sectors_with_distance:
                                        sectors_with_distance[adj_id] = hops + 1

                                # Continue BFS only from visited sectors
                                queue.append((adj_id, hops + 1))

                        # Check limit
                        if len(sectors_to_include) >= max_sectors:
                            break

        # Check global limit
        if len(sectors_to_include) >= max_sectors:
            break

    # Build result sectors list
    result_sectors = []

    for sector_id in sorted(sectors_to_include):
        is_on_path = sector_id in path_set
        is_visited = sector_id in visited_sectors

        if is_visited:
            # Get full sector contents
            contents = await sector_contents(world, sector_id, character_id)

            # Get last visited time
            sector_knowledge = knowledge.sectors_visited[str(sector_id)]
            last_visited = sector_knowledge.last_visited if hasattr(sector_knowledge, 'last_visited') else None

            sector_dict = {
                "sector_id": sector_id,
                "on_path": is_on_path,
                "visited": True,
                "hops_from_path": sectors_with_distance.get(sector_id, 0),
                **contents
            }

            if last_visited:
                sector_dict["last_visited"] = last_visited

            # Add which path node this is adjacent to (if not on path)
            if not is_on_path and sector_id in sectors_with_distance:
                # Find which path node(s) this is adjacent to
                adjacent_path_nodes = []
                for path_node in path:
                    if path_node in visited_sectors:
                        sk = knowledge.sectors_visited[str(path_node)]
                        if sector_id in (sk.adjacent_sectors or []):
                            adjacent_path_nodes.append(path_node)
                if adjacent_path_nodes:
                    sector_dict["adjacent_to_path_nodes"] = adjacent_path_nodes

            result_sectors.append(sector_dict)
        else:
            # Unknown sector on path - minimal info
            result_sectors.append({
                "sector_id": sector_id,
                "on_path": True,
                "visited": False,
                "hops_from_path": 0,
                "seen_from": []  # Can't know adjacents for unvisited sectors
            })

    known_sectors = sum(1 for s in result_sectors if s["visited"])
    unknown_sectors = len(result_sectors) - known_sectors

    return {
        "path": path,
        "distance": len(path) - 1,
        "sectors": result_sectors,
        "total_sectors": len(result_sectors),
        "known_sectors": known_sectors,
        "unknown_sectors": unknown_sectors
    }
