from fastapi import HTTPException


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")

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

    return data
