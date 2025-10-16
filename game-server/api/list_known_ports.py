"""List known ports endpoint - finds ports within travel range."""

import logging
from collections import deque
from typing import Dict, Any, List

from .utils import (
    sector_contents,
    rpc_success,
    rpc_failure,
    build_event_source,
)
from rpc.events import event_dispatcher

logger = logging.getLogger("gradient-bang.api.list_known_ports")


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Find all known ports within range of a starting sector."""
    if not world.universe_graph:
        return rpc_failure("Game world not loaded")

    character_id = request.get("character_id")
    if not character_id:
        return rpc_failure("Missing character_id")

    knowledge = world.knowledge_manager.load_knowledge(character_id)

    from_sector = request.get("from_sector")
    if from_sector is None:
        if character_id in world.characters:
            from_sector = world.characters[character_id].sector
        else:
            from_sector = (
                knowledge.current_sector if knowledge.current_sector is not None else 0
            )
    else:
        try:
            from_sector = int(from_sector)
        except (TypeError, ValueError):
            return rpc_failure("from_sector must be an integer")

    if str(from_sector) not in knowledge.sectors_visited:
        return rpc_failure(
            f"Starting sector {from_sector} must be a visited sector"
        )

    max_hops = request.get("max_hops", 5)
    port_type = request.get("port_type")
    commodity = request.get("commodity")
    trade_type = request.get("trade_type")

    try:
        max_hops = int(max_hops)
        if max_hops < 0 or max_hops > 10:
            raise ValueError
    except (TypeError, ValueError):
        return rpc_failure("max_hops must be an integer between 0 and 10")

    if trade_type and trade_type not in ("buy", "sell"):
        return rpc_failure("trade_type must be 'buy' or 'sell'")

    if trade_type and not commodity:
        return rpc_failure("commodity required when trade_type is specified")
    if commodity and not trade_type:
        return rpc_failure("trade_type required when commodity is specified")

    visited_sectors = set(int(k) for k in knowledge.sectors_visited.keys())

    ports: List[Dict[str, Any]] = []
    queue = deque([(from_sector, 0)])
    visited_in_bfs = {from_sector}
    sectors_searched = 0

    commodity_map = {
        "quantum_foam": 0,
        "retro_organics": 1,
        "neuro_symbolics": 2,
    }

    while queue:
        current, hops = queue.popleft()
        sectors_searched += 1

        if current in visited_sectors:
            sector_knowledge = knowledge.sectors_visited[str(current)]
            port = getattr(sector_knowledge, "port", None)

            port_matches = False
            if port:
                port_code = port.get("code")

                if port_type and port_code != port_type:
                    port_matches = False
                elif commodity and trade_type:
                    if commodity not in commodity_map:
                        return rpc_failure(f"Unknown commodity: {commodity}")
                    pos = commodity_map[commodity]
                    code_char = port_code[pos] if port_code and len(port_code) > pos else None
                    if trade_type == "buy":
                        port_matches = code_char == "S"
                    else:
                        port_matches = code_char == "B"
                else:
                    port_matches = True

                if port_matches:
                    contents = await sector_contents(world, current, character_id)
                    last_visited = getattr(sector_knowledge, "last_visited", None)

                    ports.append(
                        {
                            "sector_id": current,
                            "hops_from_start": hops,
                            "port": port,
                            "position": contents.get("position"),
                            "last_visited": last_visited,
                        }
                    )

            if hops < max_hops:
                adjacent = getattr(sector_knowledge, "adjacent_sectors", []) or []
                for adj_id in adjacent:
                    try:
                        adj_int = int(adj_id)
                    except (TypeError, ValueError):
                        continue
                    if adj_int not in visited_in_bfs and adj_int in visited_sectors:
                        visited_in_bfs.add(adj_int)
                        queue.append((adj_int, hops + 1))

    ports.sort(key=lambda p: p["hops_from_start"])

    payload = {
        "from_sector": from_sector,
        "ports": ports,
        "total_ports_found": len(ports),
        "searched_sectors": sectors_searched,
    }

    request_id = request.get("request_id") or "missing-request-id"
    payload["source"] = build_event_source("list_known_ports", request_id)

    await event_dispatcher.emit(
        "ports.list",
        payload,
        character_filter=[character_id],
    )

    return rpc_success()
