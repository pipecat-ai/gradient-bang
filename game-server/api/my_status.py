from typing import Optional

from fastapi import HTTPException

from .utils import (
    build_status_payload,
    rpc_success,
    build_event_source,
    build_log_context,
    emit_error_event,
)
from rpc.events import event_dispatcher


async def _fail(
    character_id: Optional[str],
    request_id: str,
    detail: str,
    *,
    status: int = 400,
    world=None,
) -> None:
    if character_id:
        await emit_error_event(
            event_dispatcher,
            character_id,
            "my_status",
            request_id,
            detail,
            world=world,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: dict, world) -> dict:
    request_id = request.get("request_id") or "missing-request-id"
    character_id = request.get("character_id")
    if not character_id:
        await _fail(None, request_id, "Missing character_id", world=world)
    if character_id not in world.characters:
        await _fail(
            character_id,
            request_id,
            f"Character '{character_id}' not found",
            status=404,
            world=world,
        )

    character = world.characters[character_id]
    if character.in_hyperspace:
        await _fail(
            character_id,
            request_id,
            "Character is in hyperspace, status unavailable until arrival",
            status=409,
            world=world,
        )

    status_payload = await build_status_payload(world, character_id)
    status_payload["source"] = build_event_source("my_status", request_id)

    await event_dispatcher.emit(
        "status.snapshot",
        status_payload,
        character_filter=[character_id],
        log_context=build_log_context(character_id=character_id, world=world),
    )

    return rpc_success()
