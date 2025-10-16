"""Path with region endpoint - returns path plus local context around each node."""

import logging
from collections import deque
from typing import Dict, Any, Set

from .utils import (
    sector_contents,
    rpc_success,
    rpc_failure,
    build_event_source,
)
from rpc.events import event_dispatcher

logger = logging.getLogger("gradient-bang.api.path_with_region")


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Return path to destination plus context around each path node."""
    if not world.universe_graph:
        return rpc_failure("Game world not loaded")

    character_id = request.get("character_id")
    to_sector = request.get("to_sector")

    if not character_id:
        return rpc_failure("Missing character_id")
    if to_sector is None:
        return rpc_failure("Missing to_sector")

    character = world.characters.get(character_id)
    if not character:
        return rpc_failure(f"Character not found: {character_id}")

    from_sector = character.sector

    try:
        to_sector = int(to_sector)
        if to_sector < 0:
            raise ValueError
    except (TypeError, ValueError):
        return rpc_failure("to_sector must be a non-negative integer")

    if to_sector >= world.universe_graph.sector_count:
        return rpc_failure(f"Invalid to_sector: {to_sector}")

    region_hops = request.get("region_hops", 1)
    max_sectors = request.get("max_sectors", 200)

    try:
        region_hops = int(region_hops)
        if region_hops < 0:
            raise ValueError
    except (TypeError, ValueError):
        return rpc_failure("region_hops must be a non-negative integer")

    try:
        max_sectors = int(max_sectors)
        if max_sectors <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return rpc_failure("max_sectors must be a positive integer")

    path = world.universe_graph.find_path(from_sector, to_sector)
    if path is None:
        return rpc_failure(
            f"No path found from sector {from_sector} to sector {to_sector}"
        )

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    visited_sectors = set(int(k) for k in knowledge.sectors_visited.keys())

    path_set = set(path)
    sectors_to_include: Set[int] = set(path)
    sectors_with_distance: Dict[int, int] = {}

    for path_node in path:
        sectors_with_distance[path_node] = 0

        if path_node in visited_sectors and region_hops > 0:
            queue = deque([(path_node, 0)])
            visited_in_bfs = {path_node}

            while queue and len(sectors_to_include) < max_sectors:
                current, hops = queue.popleft()
                if hops >= region_hops:
                    continue

                if current in visited_sectors:
                    sector_knowledge = knowledge.sectors_visited[str(current)]
                    adjacent = getattr(sector_knowledge, "adjacent_sectors", []) or []

                    for adj_id in adjacent:
                        try:
                            adj_int = int(adj_id)
                        except (TypeError, ValueError):
                            continue

                        if adj_int not in visited_in_bfs:
                            visited_in_bfs.add(adj_int)

                            if adj_int in visited_sectors:
                                sectors_to_include.add(adj_int)
                                if adj_int not in path_set and adj_int not in sectors_with_distance:
                                    sectors_with_distance[adj_int] = hops + 1

                                queue.append((adj_int, hops + 1))

                        if len(sectors_to_include) >= max_sectors:
                            break

        if len(sectors_to_include) >= max_sectors:
            break

    result_sectors = []

    for sector_id in sorted(sectors_to_include):
        is_on_path = sector_id in path_set
        is_visited = sector_id in visited_sectors

        if is_visited:
            contents = await sector_contents(world, sector_id, character_id)
            sector_knowledge = knowledge.sectors_visited[str(sector_id)]
            last_visited = getattr(sector_knowledge, "last_visited", None)

            sector_dict: Dict[str, Any] = {
                "sector_id": sector_id,
                "on_path": is_on_path,
                "visited": True,
                "hops_from_path": sectors_with_distance.get(sector_id, 0),
                **contents,
            }
            if last_visited:
                sector_dict["last_visited"] = last_visited

            if not is_on_path and sector_id in sectors_with_distance:
                adjacent_path_nodes = []
                for path_node in path:
                    if path_node in visited_sectors:
                        sk = knowledge.sectors_visited[str(path_node)]
                        neighbours = getattr(sk, "adjacent_sectors", []) or []
                        if sector_id in neighbours:
                            adjacent_path_nodes.append(path_node)
                if adjacent_path_nodes:
                    sector_dict["adjacent_to_path_nodes"] = adjacent_path_nodes

            result_sectors.append(sector_dict)
        else:
            result_sectors.append(
                {
                    "sector_id": sector_id,
                    "on_path": True,
                    "visited": False,
                    "hops_from_path": 0,
                    "seen_from": [],
                }
            )

    known_sectors = sum(1 for s in result_sectors if s["visited"])
    unknown_sectors = len(result_sectors) - known_sectors

    payload = {
        "path": path,
        "distance": len(path) - 1,
        "sectors": result_sectors,
        "total_sectors": len(result_sectors),
        "known_sectors": known_sectors,
        "unknown_sectors": unknown_sectors,
    }

    request_id = request.get("request_id") or "missing-request-id"
    payload["source"] = build_event_source("path_with_region", request_id)

    await event_dispatcher.emit(
        "path.region",
        payload,
        character_filter=[character_id],
    )

    return rpc_success()
