from typing import Optional

from fastapi import HTTPException

from .utils import (
    rpc_success,
    build_event_source,
    emit_error_event,
    enforce_actor_authorization,
    build_log_context,
)
from rpc.events import event_dispatcher


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
            "plot_course",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: dict, world) -> dict:
    request_id = request.get("request_id") or "missing-request-id"

    if not world.universe_graph:
        await _fail(request.get("character_id"), request_id, "Game world not loaded", status=503)

    character_id = request.get("character_id")
    to_sector = request.get("to_sector")

    if not character_id:
        await _fail(None, request_id, "Missing character_id")
    if to_sector is None:
        await _fail(character_id, request_id, "Missing to_sector")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

    # Get character's current sector
    character = world.characters.get(character_id)
    if not character:
        await _fail(character_id, request_id, f"Character not found: {character_id}", status=404)

    from_sector = character.sector

    if to_sector < 0:
        await _fail(character_id, request_id, "Sectors must be non-negative")

    if to_sector >= world.universe_graph.sector_count:
        await _fail(character_id, request_id, f"Invalid to_sector: {to_sector}")

    path = world.universe_graph.find_path(from_sector, to_sector)
    if path is None:
        await _fail(
            character_id,
            request_id,
            f"No path found from sector {from_sector} to sector {to_sector}",
        )

    await event_dispatcher.emit(
        "course.plot",
        {
            "source": build_event_source("plot_course", request_id),
            "from_sector": from_sector,
            "to_sector": to_sector,
            "path": path,
            "distance": len(path) - 1,
        },
        character_filter=[character_id],
        log_context=build_log_context(character_id=character_id, world=world),
    )

    return rpc_success()
