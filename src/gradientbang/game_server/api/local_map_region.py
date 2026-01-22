"""Local map region endpoint - returns known sectors around a center point."""

import logging
from typing import Dict, Any, Optional

from fastapi import HTTPException

from gradientbang.game_server.api.utils import (
    build_local_map_region,
    rpc_success,
    build_event_source,
    emit_error_event,
    enforce_actor_authorization,
    build_log_context,
)
from gradientbang.game_server.rpc.events import event_dispatcher

logger = logging.getLogger("gradient-bang.api.local_map_region")


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
            "local_map_region",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: Dict[str, Any], world) -> Dict[str, Any]:
    """Return sectors known to character in region around center sector."""
    request_id = request.get("request_id") or "missing-request-id"
    character_id = request.get("character_id")

    if not world.universe_graph:
        await _fail(character_id, request_id, "Game world not loaded", status=503)

    if not character_id:
        await _fail(None, request_id, "Missing character_id")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

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
            await _fail(character_id, request_id, "center_sector must be an integer")

    if str(center_sector) not in knowledge.sectors_visited:
        await _fail(
            character_id,
            request_id,
            f"Center sector {center_sector} must be a visited sector",
        )

    max_hops = request.get("max_hops", 3)
    max_sectors = request.get("max_sectors", 100)

    try:
        max_hops = int(max_hops)
        if max_hops < 0 or max_hops > 100:
            raise ValueError
    except (TypeError, ValueError):
        await _fail(
            character_id,
            request_id,
            "max_hops must be an integer between 0 and 10",
        )

    try:
        max_sectors = int(max_sectors)
        if max_sectors <= 0:
            raise ValueError
    except (TypeError, ValueError):
        await _fail(
            character_id,
            request_id,
            "max_sectors must be a positive integer",
        )

    region_payload = await build_local_map_region(
        world,
        character_id=character_id,
        center_sector=center_sector,
        max_hops=max_hops,
        max_sectors=max_sectors,
    )

    request_id = request.get("request_id") or "missing-request-id"
    region_payload["source"] = build_event_source(
        request.get("source", "local_map_region"), request_id
    )

    await event_dispatcher.emit(
        "map.region",
        region_payload,
        character_filter=[character_id],
        log_context=build_log_context(character_id=character_id, world=world),
    )

    return rpc_success()
