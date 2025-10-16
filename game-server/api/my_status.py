from .utils import (
    build_status_payload,
    rpc_success,
    rpc_failure,
    build_event_source,
)
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        return rpc_failure("Missing character_id")
    if character_id not in world.characters:
        return rpc_failure(f"Character '{character_id}' not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        return rpc_failure(
            "Character is in hyperspace, status unavailable until arrival"
        )

    status_payload = await build_status_payload(world, character_id)
    request_id = request.get("request_id") or "missing-request-id"
    status_payload["source"] = build_event_source("my_status", request_id)

    await event_dispatcher.emit(
        "status.snapshot",
        status_payload,
        character_filter=[character_id],
    )

    return rpc_success()
