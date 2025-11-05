from __future__ import annotations

from fastapi import HTTPException

from .utils import rpc_success, build_corporation_member_payload, is_corporation_member


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")

    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    corp_id = world.character_to_corp.get(character_id)
    if not corp_id:
        return rpc_success({"corporation": None})

    try:
        corp = world.corporation_manager.load(corp_id)
    except FileNotFoundError:
        world.character_to_corp.pop(character_id, None)
        return rpc_success({"corporation": None})

    if not is_corporation_member(corp, character_id):
        world.character_to_corp.pop(character_id, None)
        return rpc_success({"corporation": None})

    payload = build_corporation_member_payload(world, corp)

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    joined_at = None
    if isinstance(knowledge.corporation, dict):
        joined_at = knowledge.corporation.get("joined_at")
    payload["joined_at"] = joined_at

    return rpc_success({"corporation": payload})
