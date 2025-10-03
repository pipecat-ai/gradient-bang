from fastapi import HTTPException
from api.utils import build_ship_status, sector_contents


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Character '{character_id}' not found")
    character = world.characters[character_id]
    character.update_activity()
    contents = sector_contents(world, character.sector, character_id)
    return {**character.to_response(), "sector_contents": contents, "ship": build_ship_status(world, character_id)}

