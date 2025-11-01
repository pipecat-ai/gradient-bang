from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from .utils import rpc_success
from rpc.events import event_dispatcher, EventLogContext


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    target_id = request.get("target_id")

    if not character_id or not target_id:
        raise HTTPException(status_code=400, detail="Missing character_id or target_id")
    if character_id == target_id:
        raise HTTPException(status_code=400, detail="Use leave to exit your corporation")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")
    if target_id not in world.characters:
        raise HTTPException(status_code=404, detail="Target character not found")

    kicker_knowledge = world.knowledge_manager.load_knowledge(character_id)
    kicker_membership = (
        kicker_knowledge.corporation
        if isinstance(kicker_knowledge.corporation, dict)
        else None
    )
    corp_id = kicker_membership.get("corp_id") if kicker_membership else None
    if not corp_id:
        raise HTTPException(status_code=400, detail="Not in a corporation")

    try:
        corp = world.corporation_manager.load(corp_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Corporation not found") from exc

    members = list(corp.get("members", []))
    if character_id not in members:
        raise HTTPException(status_code=403, detail="Not authorized for this corporation")
    if target_id not in members:
        raise HTTPException(status_code=400, detail="Target is not in your corporation")

    target_knowledge = world.knowledge_manager.load_knowledge(target_id)
    corp_name = corp.get("name", corp_id)

    became_empty = world.corporation_manager.remove_member(corp_id, target_id)
    if became_empty:
        # Should not happen while kicker remains; re-add kicker to ensure corp persists.
        world.corporation_manager.add_member(corp_id, character_id)
        raise HTTPException(status_code=500, detail="Unexpected empty corporation state")

    target_knowledge.corporation = None
    target_knowledge.last_update = datetime.now(timezone.utc).isoformat()
    world.knowledge_manager.save_knowledge(target_knowledge)

    if isinstance(world.character_to_corp, dict):
        world.character_to_corp.pop(target_id, None)

    updated_corp = world.corporation_manager.load(corp_id)
    remaining_members = list(updated_corp.get("members", []))

    kicker_character = world.characters[character_id]
    target_character = world.characters[target_id]
    timestamp = datetime.now(timezone.utc).isoformat()

    await event_dispatcher.emit(
        "corporation.member_kicked",
        {
            "corp_id": corp_id,
            "corp_name": corp_name,
            "kicked_member_id": target_id,
            "kicked_member_name": getattr(target_character, "name", target_id),
            "kicker_id": character_id,
            "kicker_name": getattr(kicker_character, "name", character_id),
            "member_count": len(remaining_members),
            "timestamp": timestamp,
        },
        character_filter=list(set(remaining_members + [target_id])),
        log_context=EventLogContext(
            sender=character_id,
            sector=kicker_character.sector,
        ),
    )

    return rpc_success({"success": True})
