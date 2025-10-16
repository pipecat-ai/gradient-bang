from .utils import rpc_success, rpc_failure, build_event_source
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        return rpc_failure("Missing character_id")

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

    request_id = request.get("request_id") or "missing-request-id"
    data["source"] = build_event_source("my_map", request_id)

    await event_dispatcher.emit(
        "map.knowledge",
        data,
        character_filter=[character_id],
    )

    return rpc_success()
