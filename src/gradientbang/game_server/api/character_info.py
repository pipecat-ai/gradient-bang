"""Public endpoint for looking up character information by character_id."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException

from gradientbang.game_server.api.utils import rpc_success


async def handle(payload: Dict[str, Any], world) -> dict:
    """Return public character information by character_id.

    This endpoint does NOT require admin password since character display names
    are already public information visible in-game.

    Args:
        payload: Must contain "character_id"
        world: World instance with character_registry

    Returns:
        Character profile information (name, created_at, updated_at)
    """
    registry = getattr(world, "character_registry", None)
    if registry is None:
        raise HTTPException(status_code=500, detail="Character registry unavailable")

    character_id = payload.get("character_id")
    if not character_id or not isinstance(character_id, str):
        raise HTTPException(status_code=400, detail="character_id is required")

    profile = registry.get_profile(character_id)
    if profile is None:
        raise HTTPException(
            status_code=404,
            detail=f"Character not found: {character_id}"
        )

    return rpc_success(
        {
            "character_id": profile.character_id,
            "name": profile.name,
            "created_at": profile.created_at,
            "updated_at": profile.updated_at,
        }
    )
