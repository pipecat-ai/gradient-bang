from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from .utils import rpc_success
from rpc.events import event_dispatcher, EventLogContext

CORPORATION_CREATION_COST = 10_000


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    name = (request.get("name") or "").strip()

    if not character_id or not name:
        raise HTTPException(status_code=400, detail="Missing character_id or name")
    if len(name) < 3 or len(name) > 50:
        raise HTTPException(status_code=400, detail="Name must be 3-50 characters")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    if isinstance(knowledge.corporation, dict) and knowledge.corporation.get("corp_id"):
        raise HTTPException(status_code=400, detail="Already in a corporation")

    if knowledge.credits < CORPORATION_CREATION_COST:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient credits (need {CORPORATION_CREATION_COST:,})",
        )

    try:
        corp = world.corporation_manager.create(name, character_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    joined_at = corp["founded"]
    knowledge.corporation = {
        "corp_id": corp["corp_id"],
        "joined_at": joined_at,
    }
    knowledge.credits -= CORPORATION_CREATION_COST
    knowledge.last_update = datetime.now(timezone.utc).isoformat()
    world.knowledge_manager.save_knowledge(knowledge)
    world.character_to_corp[character_id] = corp["corp_id"]

    character = world.characters[character_id]
    await event_dispatcher.emit(
        "corporation.created",
        {
            "corp_id": corp["corp_id"],
            "name": corp["name"],
            "invite_code": corp["invite_code"],
            "founder_id": character_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
        character_filter=[character_id],
        log_context=EventLogContext(
            sender=character_id,
            sector=character.sector,
            corporation_id=corp["corp_id"],
        ),
    )

    return rpc_success(
        {
            "corp_id": corp["corp_id"],
            "name": corp["name"],
            "invite_code": corp["invite_code"],
            "founder_id": character_id,
            "member_count": 1,
        }
    )
