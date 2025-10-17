from typing import Optional

from fastapi import HTTPException

from .utils import rpc_success, build_event_source, emit_error_event
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
            "my_map",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: dict, world) -> dict:
    request_id = request.get("request_id") or "missing-request-id"
    character_id = request.get("character_id")
    if not character_id:
        await _fail(None, request_id, "Missing character_id")

    # Load persisted knowledge
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    data = knowledge.model_dump()

    # Determine authoritative current sector from live world if connected
    live_sector = None
    if hasattr(world, "characters") and character_id in world.characters:
        live_sector = world.characters[character_id].sector
    # Fall back to persisted current_sector if no live character exists
    if live_sector is None:
        live_sector = data.get("current_sector", 0)

    # Expose sector and drop legacy/current-sector naming
    data["sector"] = live_sector
    if "current_sector" in data:
        del data["current_sector"]

    data["source"] = build_event_source("my_map", request_id)

    await event_dispatcher.emit(
        "map.knowledge",
        data,
        character_filter=[character_id],
    )

    return rpc_success()
