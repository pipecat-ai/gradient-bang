from fastapi import HTTPException
from .utils import build_status_payload


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    if character_id not in world.characters:
        raise HTTPException(
            status_code=404, detail=f"Character '{character_id}' not found"
        )

    status_payload = await build_status_payload(world, character_id)
    return status_payload
