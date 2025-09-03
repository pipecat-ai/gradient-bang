from fastapi import HTTPException


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    return knowledge.model_dump()

