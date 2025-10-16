"""Local map region endpoint - returns known sectors around a center point."""

import logging
from typing import Dict, Any

from .utils import (
    build_local_map_region,
    rpc_success,
    rpc_failure,
    build_event_source,
)
from rpc.events import event_dispatcher

logger = logging.getLogger("gradient-bang.api.local_map_region")


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Return sectors known to character in region around center sector."""
    if not world.universe_graph:
        return rpc_failure("Game world not loaded")

    character_id = request.get("character_id")
    if not character_id:
        return rpc_failure("Missing character_id")

    knowledge = world.knowledge_manager.load_knowledge(character_id)

    center_sector = request.get("center_sector")
    if center_sector is None:
        if character_id in world.characters:
            center_sector = world.characters[character_id].sector
        else:
            center_sector = (
                knowledge.current_sector if knowledge.current_sector is not None else 0
            )
    else:
        try:
            center_sector = int(center_sector)
        except (TypeError, ValueError):
            return rpc_failure("center_sector must be an integer")

    if str(center_sector) not in knowledge.sectors_visited:
        return rpc_failure(f"Center sector {center_sector} must be a visited sector")

    max_hops = request.get("max_hops", 3)
    max_sectors = request.get("max_sectors", 100)

    try:
        max_hops = int(max_hops)
        if max_hops < 0 or max_hops > 10:
            raise ValueError
    except (TypeError, ValueError):
        return rpc_failure("max_hops must be an integer between 0 and 10")

    try:
        max_sectors = int(max_sectors)
        if max_sectors <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return rpc_failure("max_sectors must be a positive integer")

    region_payload = await build_local_map_region(
        world,
        character_id=character_id,
        center_sector=center_sector,
        max_hops=max_hops,
        max_sectors=max_sectors,
    )

    request_id = request.get("request_id") or "missing-request-id"
    region_payload["source"] = build_event_source("local_map_region", request_id)

    await event_dispatcher.emit(
        "map.region",
        region_payload,
        character_filter=[character_id],
    )

    return rpc_success()
