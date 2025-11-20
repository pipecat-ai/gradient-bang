from __future__ import annotations

from fastapi import HTTPException

from gradientbang.game_server.api.utils import (
    rpc_success,
    build_corporation_public_payload,
    build_corporation_member_payload,
    is_corporation_member,
)


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    corp_id = request.get("corp_id")

    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    # Auto-detect corp_id from character if not provided
    if not corp_id:
        corp_id = world.character_to_corp.get(character_id)
        if not corp_id:
            raise HTTPException(
                status_code=404,
                detail="Character is not in a corporation. Use corporation.list to see all corporations."
            )

    try:
        corp = world.corporation_manager.load(corp_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Corporation not found") from exc

    if not is_corporation_member(corp, character_id):
        return rpc_success(build_corporation_public_payload(world, corp))

    payload = build_corporation_member_payload(world, corp)
    return rpc_success(payload)
