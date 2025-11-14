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

    knowledge_manager = getattr(world, "knowledge_manager", None)
    corporation_manager = getattr(world, "corporation_manager", None)
    ships_manager = getattr(world, "ships_manager", None)
    character_to_corp = getattr(world, "character_to_corp", None)

    corp_id = None
    if knowledge_manager is not None:
        knowledge = knowledge_manager.load_knowledge(character_id)
        corp_membership = knowledge.corporation if isinstance(knowledge.corporation, dict) else None
        if corp_membership:
            corp_id = corp_membership.get("corp_id")

    if corp_id and corporation_manager is not None:
        ships_to_release: list[str] = []
        corp_name = corp_id
        try:
            corp_record = corporation_manager.load(corp_id)
            corp_name = corp_record.get("name", corp_id)
            ships_to_release = list(corp_record.get("ships", []))
        except FileNotFoundError:
            corp_record = None

        if corp_record is not None:
            became_empty = corporation_manager.remove_member(corp_id, character_id)
            if became_empty:
                if ships_manager is not None:
                    for ship_id in ships_to_release:
                        try:
                            ships_manager.mark_as_unowned(ship_id, corp_name)
                        except KeyError:
                            continue
                corporation_manager.delete(corp_id)

    if isinstance(character_to_corp, dict):
        character_to_corp.pop(character_id, None)

    registry.delete(character_id)
    if knowledge_manager is not None:
        knowledge_manager.delete_knowledge(character_id)
    world.characters.pop(character_id, None)

    return rpc_success({"character_id": character_id, "deleted": True})
