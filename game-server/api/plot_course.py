from .utils import rpc_success, rpc_failure, build_event_source
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    if not world.universe_graph:
        return rpc_failure("Game world not loaded")

    character_id = request.get("character_id")
    to_sector = request.get("to_sector")

    if not character_id:
        return rpc_failure("Missing character_id")
    if to_sector is None:
        return rpc_failure("Missing to_sector")

    # Get character's current sector
    character = world.characters.get(character_id)
    if not character:
        return rpc_failure(f"Character not found: {character_id}")

    from_sector = character.sector

    if to_sector < 0:
        return rpc_failure("Sectors must be non-negative")

    if to_sector >= world.universe_graph.sector_count:
        return rpc_failure(f"Invalid to_sector: {to_sector}")

    path = world.universe_graph.find_path(from_sector, to_sector)
    if path is None:
        return rpc_failure(
            f"No path found from sector {from_sector} to sector {to_sector}"
        )

    request_id = request.get("request_id") or "missing-request-id"
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
    )

    return rpc_success()
