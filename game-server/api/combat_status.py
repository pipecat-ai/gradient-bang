from __future__ import annotations

from fastapi import HTTPException

from combat.utils import serialize_encounter, serialize_log


async def handle(request: dict, world) -> dict:
    combat_id = request.get("combat_id")
    character_id = request.get("character_id")
    include_logs = bool(request.get("include_logs"))

    if world.combat_manager is None:
        raise HTTPException(status_code=503, detail="Combat system not initialised")

    encounter = None
    if combat_id:
        encounter = await world.combat_manager.get_encounter(combat_id)
    elif character_id:
        encounter = await world.combat_manager.find_encounter_for(character_id)
    else:
        raise HTTPException(status_code=400, detail="Provide combat_id or character_id")

    if not encounter:
        raise HTTPException(status_code=404, detail="Combat encounter not found")

    payload = serialize_encounter(encounter)
    payload["ended"] = encounter.ended
    payload["end_state"] = encounter.end_state

    if include_logs:
        payload["logs"] = [serialize_log(log) for log in encounter.logs]

    return payload
