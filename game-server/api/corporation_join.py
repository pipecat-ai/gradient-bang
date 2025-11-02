from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from .utils import rpc_success
from rpc.events import event_dispatcher, EventLogContext


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    corp_id = request.get("corp_id")
    invite_code = request.get("invite_code", "")

    if not character_id or not corp_id or not invite_code:
        raise HTTPException(status_code=400, detail="Missing character_id, corp_id, or invite_code")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    try:
        corp = world.corporation_manager.load(corp_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Corporation not found") from exc

    if not world.corporation_manager.verify_invite_code(corp_id, invite_code):
        raise HTTPException(status_code=400, detail="Invalid invite code")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    if isinstance(knowledge.corporation, dict) and knowledge.corporation.get("corp_id"):
        raise HTTPException(status_code=400, detail="Already in a corporation")

    now = datetime.now(timezone.utc).isoformat()
    knowledge.corporation = {"corp_id": corp_id, "joined_at": now}
    knowledge.last_update = now
    world.knowledge_manager.save_knowledge(knowledge)

    world.corporation_manager.add_member(corp_id, character_id)
    world.character_to_corp[character_id] = corp_id

    updated_corp = world.corporation_manager.load(corp_id)
    members = list(updated_corp.get("members", []))

    character = world.characters[character_id]
    await event_dispatcher.emit(
        "corporation.member_joined",
        {
            "corp_id": corp_id,
            "name": updated_corp.get("name"),
            "member_id": character_id,
            "member_name": getattr(character, "name", character_id),
            "member_count": len(members),
            "timestamp": now,
        },
        character_filter=members,
        log_context=EventLogContext(
            sender=character_id,
            sector=character.sector,
            corporation_id=corp_id,
        ),
    )

    return rpc_success(
        {
            "corp_id": corp_id,
            "name": updated_corp.get("name"),
            "member_count": len(members),
        }
    )
