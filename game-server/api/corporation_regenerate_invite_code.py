from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from .utils import rpc_success, build_log_context
from rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    actor_character_id = request.get("actor_character_id")
    if not character_id:
        raise HTTPException(status_code=400, detail="Missing character_id")
    if actor_character_id is not None:
        if not isinstance(actor_character_id, str):
            raise HTTPException(status_code=400, detail="actor_character_id must be a string")
        if actor_character_id != character_id:
            raise HTTPException(
                status_code=400,
                detail="actor_character_id must match character_id for corporation.regenerate_invite_code",
            )
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    corp_membership = (
        knowledge.corporation if isinstance(knowledge.corporation, dict) else None
    )
    corp_id = corp_membership.get("corp_id") if corp_membership else None
    if not corp_id:
        raise HTTPException(status_code=400, detail="Not in a corporation")

    try:
        corp = world.corporation_manager.load(corp_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Corporation not found") from exc

    if character_id not in corp.get("members", []):
        raise HTTPException(status_code=403, detail="Not authorized for this corporation")

    new_code = world.corporation_manager.regenerate_invite_code(corp_id, character_id)
    updated_corp = world.corporation_manager.load(corp_id)
    members = list(updated_corp.get("members", []))

    now = datetime.now(timezone.utc).isoformat()
    character = world.characters[character_id]
    await event_dispatcher.emit(
        "corporation.invite_code_regenerated",
        {
            "corp_id": corp_id,
            "name": updated_corp.get("name"),
            "new_invite_code": new_code,
            "generated_by": character_id,
            "timestamp": now,
        },
        character_filter=members,
        log_context=build_log_context(
            character_id=character_id,
            world=world,
            sector=character.sector,
            corporation_id=corp_id,
        ),
    )

    return rpc_success({"new_invite_code": new_code})
