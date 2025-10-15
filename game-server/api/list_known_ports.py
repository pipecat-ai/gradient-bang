"""List known ports endpoint - finds ports within travel range."""

import logging
from collections import deque
from typing import Dict, Any, List, Optional

from fastapi import HTTPException

from .utils import sector_contents

logger = logging.getLogger("gradient-bang.api.list_known_ports")


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Find all known ports within range of a starting sector.

    Request:
        character_id: str (required)
        from_sector: int (optional, defaults to current sector)
        max_hops: int (optional, default 5, max 10)
        port_type: str (optional, filter by port code like "BBB", "SSS")
        commodity: str (optional, filter ports that trade this commodity)
        trade_type: str (optional, "buy" or "sell" - requires commodity)

    Response:
        from_sector: int
        ports: list of port info dicts with distance
        total_ports_found: int
        searched_sectors: int
    """
    if not world.universe_graph:
        raise HTTPException(status_code=503, detail="Game world not loaded")

    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")

    # Load knowledge
    knowledge = world.knowledge_manager.load_knowledge(character_id)

    # Determine starting sector
    from_sector = request.get("from_sector")
    if from_sector is None:
        if character_id in world.characters:
            from_sector = world.characters[character_id].sector
        else:
            from_sector = knowledge.current_sector if knowledge.current_sector is not None else 0
    else:
        from_sector = int(from_sector)

    # Validate from_sector is visited
    if str(from_sector) not in knowledge.sectors_visited:
        raise HTTPException(
            status_code=400,
            detail=f"Starting sector {from_sector} must be a visited sector"
        )

    # Parse limits and filters
    max_hops = request.get("max_hops", 5)
    port_type = request.get("port_type")
    commodity = request.get("commodity")
    trade_type = request.get("trade_type")

    try:
        max_hops = int(max_hops)
        if max_hops < 0 or max_hops > 10:
            raise ValueError("max_hops must be between 0 and 10")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="max_hops must be an integer between 0 and 10") from exc

    # Validate trade_type if provided
    if trade_type and trade_type not in ("buy", "sell"):
        raise HTTPException(status_code=422, detail="trade_type must be 'buy' or 'sell'")

    # Validate commodity and trade_type are used together
    if trade_type and not commodity:
        raise HTTPException(status_code=400, detail="commodity required when trade_type is specified")
    if commodity and not trade_type:
        raise HTTPException(status_code=400, detail="trade_type required when commodity is specified")

    # Build set of visited sectors
    visited_sectors = set(int(k) for k in knowledge.sectors_visited.keys())

    # BFS to find ports within range
    ports: List[Dict[str, Any]] = []
    distance_map: Dict[int, int] = {from_sector: 0}
    queue = deque([(from_sector, 0)])
    visited_in_bfs = {from_sector}
    sectors_searched = 0

    while queue:
        current, hops = queue.popleft()
        sectors_searched += 1

        # Check if current sector has a port (only if visited)
        if current in visited_sectors:
            sector_knowledge = knowledge.sectors_visited[str(current)]
            port = sector_knowledge.port if hasattr(sector_knowledge, 'port') else None

            # Apply filters
            port_matches = False
            if port:
                port_code = port.get("code")

                # Port type filter
                if port_type and port_code != port_type:
                    port_matches = False
                # Commodity + trade type filter
                elif commodity and trade_type:
                    # Check if port buys/sells the commodity
                    # Port code: B=buy, S=sell for each position (QF, RO, NS)
                    commodity_map = {
                        "quantum_foam": 0,
                        "retro_organics": 1,
                        "neuro_symbolics": 2
                    }
                    if commodity not in commodity_map:
                        raise HTTPException(status_code=422, detail=f"Unknown commodity: {commodity}")

                    pos = commodity_map[commodity]
                    code_char = port_code[pos] if port_code and len(port_code) > pos else None

                    if trade_type == "buy":
                        # Player wants to buy, so port must sell (S)
                        port_matches = code_char == "S"
                    else:  # sell
                        # Player wants to sell, so port must buy (B)
                        port_matches = code_char == "B"
                else:
                    # No filters or just port_type matched
                    port_matches = True

                if port_matches:
                    # Get full sector contents for position
                    contents = await sector_contents(world, current, character_id)

                    # Get last visited time from sector knowledge
                    last_visited = (
                        sector_knowledge.last_visited
                        if hasattr(sector_knowledge, "last_visited")
                        else None
                    )

                    ports.append({
                        "sector_id": current,
                        "hops_from_start": hops,
                        "port": port,
                        "position": contents.get("position"),
                        "last_visited": last_visited
                    })

            # Continue BFS if we haven't exceeded max hops
            if hops < max_hops:
                adjacent = sector_knowledge.adjacent_sectors or []

                for adj_id in adjacent:
                    adj_id = int(adj_id)

                    if adj_id not in visited_in_bfs and adj_id in visited_sectors:
                        visited_in_bfs.add(adj_id)
                        distance_map[adj_id] = hops + 1
                        queue.append((adj_id, hops + 1))

    # Sort ports by distance
    ports.sort(key=lambda p: p["hops_from_start"])

    return {
        "from_sector": from_sector,
        "ports": ports,
        "total_ports_found": len(ports),
        "searched_sectors": sectors_searched
    }
