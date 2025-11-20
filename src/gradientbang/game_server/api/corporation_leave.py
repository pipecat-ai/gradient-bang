from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from gradientbang.game_server.api.utils import rpc_success, build_log_context
from gradientbang.game_server.rpc.events import event_dispatcher


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
                detail="actor_character_id must match character_id for corporation.leave",
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

    members = list(corp.get("members", []))
    if character_id not in members:
        raise HTTPException(status_code=403, detail="Not authorized for this corporation")

    corp_name = corp.get("name", corp_id)
    ships = list(corp.get("ships", []))

    # Update character knowledge and cache
    knowledge.corporation = None
    knowledge.last_update = datetime.now(timezone.utc).isoformat()
    world.knowledge_manager.save_knowledge(knowledge)

    if isinstance(world.character_to_corp, dict):
        world.character_to_corp.pop(character_id, None)

    became_empty = world.corporation_manager.remove_member(corp_id, character_id)
    remaining_members = [
        member for member in members if member != character_id
    ]

    character = world.characters[character_id]

    if became_empty:
        ship_details = []
        for ship_id in ships:
            try:
                ship_record = world.ships_manager.get_ship(ship_id)
            except KeyError:
                ship_record = None
            if ship_record:
                ship_details.append(
                    {
                        "ship_id": ship_id,
                        "ship_type": ship_record.get("ship_type"),
                        "sector": ship_record.get("sector"),
                    }
                )
                world.ships_manager.mark_as_unowned(ship_id, corp_name)
                world.character_to_corp.pop(ship_id, None)
                registry = getattr(world, "character_registry", None)
                if registry is not None:
                    registry.delete(ship_id)
                    delete_knowledge = getattr(world.knowledge_manager, "delete_knowledge", None)
                    if callable(delete_knowledge):
                        delete_knowledge(ship_id)
                world.characters.pop(ship_id, None)

        world.corporation_manager.delete(corp_id)

        disband_context = build_log_context(
            character_id=character_id,
            world=world,
            sector=character.sector,
            corporation_id=corp_id,
        )

        await event_dispatcher.emit(
            "corporation.disbanded",
            {
                "corp_id": corp_id,
                "corp_name": corp_name,
                "reason": "last_member_left",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            character_filter=[character_id],
            log_context=disband_context,
        )

        if ship_details:
            await event_dispatcher.emit(
                "corporation.ships_abandoned",
                {
                    "corp_id": corp_id,
                    "corp_name": corp_name,
                    "ships": ship_details,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                character_filter=[character_id],
                log_context=disband_context,
            )
    else:
        updated_corp = world.corporation_manager.load(corp_id)
        updated_members = list(updated_corp.get("members", []))
        leave_context = build_log_context(
            character_id=character_id,
            world=world,
            sector=character.sector,
            corporation_id=corp_id,
        )
        await event_dispatcher.emit(
            "corporation.member_left",
            {
                "corp_id": corp_id,
                "corp_name": corp_name,
                "departed_member_id": character_id,
                "departed_member_name": getattr(character, "name", character_id),
                "member_count": len(updated_members),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            character_filter=updated_members,
            log_context=leave_context,
        )

    return rpc_success({"success": True})
