"""Admin endpoint to delete characters and associated state."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException

from .utils import rpc_success


async def handle(payload: Dict[str, Any], world) -> dict:
    registry = getattr(world, "character_registry", None)
    if registry is None:
        raise HTTPException(status_code=500, detail="Character registry unavailable")

    admin_password = payload.get("admin_password")
    if not registry.validate_admin_password(admin_password):
        raise HTTPException(status_code=403, detail="Invalid admin password")

    character_id = payload.get("character_id")
    if not isinstance(character_id, str) or not character_id.strip():
        raise HTTPException(status_code=400, detail="character_id is required")

    profile = registry.get_profile(character_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Character not found")

    registry.delete(character_id)
    world.knowledge_manager.delete_knowledge(character_id)
    world.characters.pop(character_id, None)

    return rpc_success({"character_id": character_id, "deleted": True})
