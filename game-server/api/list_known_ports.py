"""List known ports endpoint - finds ports within travel range."""

import logging
from collections import deque
from typing import Dict, Any, List, Optional

from fastapi import HTTPException

from .utils import (
    sector_contents,
    rpc_success,
    build_event_source,
    emit_error_event,
    apply_port_observation,
)
from rpc.events import event_dispatcher

logger = logging.getLogger("gradient-bang.api.list_known_ports")


async def _fail(
    character_id: Optional[str],
    request_id: str,
    detail: str,
    *,
    status: int = 400,
) -> None:
    if character_id:
        await emit_error_event(
            event_dispatcher,
            character_id,
            "list_known_ports",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Find all known ports within range of a starting sector."""
    request_id = request.get("request_id") or "missing-request-id"
    character_id = request.get("character_id")

    if not world.universe_graph:
        await _fail(character_id, request_id, "Game world not loaded", status=503)

    if not character_id:
        await _fail(None, request_id, "Missing character_id")

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
            await _fail(character_id, request_id, "from_sector must be an integer")

    if str(from_sector) not in knowledge.sectors_visited:
        await _fail(
            character_id,
            request_id,
            f"Starting sector {from_sector} must be a visited sector",
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
        await _fail(
            character_id,
            request_id,
            "max_hops must be an integer between 0 and 10",
        )

    if trade_type and trade_type not in ("buy", "sell"):
        await _fail(character_id, request_id, "trade_type must be 'buy' or 'sell'")

    if trade_type and not commodity:
        await _fail(
            character_id,
            request_id,
            "commodity required when trade_type is specified",
        )
    if commodity and not trade_type:
        await _fail(
            character_id,
            request_id,
            "trade_type required when commodity is specified",
        )

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
                        await _fail(
                            character_id,
                            request_id,
                            f"Unknown commodity: {commodity}",
                        )
                    pos = commodity_map[commodity]
                    code_char = port_code[pos] if port_code and len(port_code) > pos else None
                    if trade_type == "buy":
                        port_matches = code_char == "S"
                    else:
                        port_matches = code_char == "B"
                else:
                    port_matches = True

                if port_matches:
                    in_sector = False
                    if character_id in world.characters:
                        char_state = world.characters[character_id]
                        in_sector = (
                            getattr(char_state, "sector", None) == current
                            and not getattr(char_state, "in_hyperspace", False)
                        )

                    event_port, observed_at = apply_port_observation(
                        world,
                        observer_id=character_id,
                        sector_id=current,
                        port_data=port,
                        in_sector=in_sector,
                    )

                    position = getattr(sector_knowledge, "position", None)
                    last_visited = getattr(sector_knowledge, "last_visited", None)

                    if event_port is None:
                        continue

                    sector_entry: Dict[str, Any] = {"id": current, "port": event_port}
                    if position is not None:
                        sector_entry["position"] = position

                    ports.append(
                        {
                            "sector": sector_entry,
                            "updated_at": observed_at,
                            "hops_from_start": hops,
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
