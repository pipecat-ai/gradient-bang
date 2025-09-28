from __future__ import annotations

from fastapi import HTTPException

from combat.models import CombatantAction
from combat.utils import serialize_round
from api.move import parse_move_destination, validate_move_destination


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    combat_id = request.get("combat_id")
    action_raw = request.get("action")
    round_hint = request.get("round")
    commit = int(request.get("commit") or 0)
    target_id = request.get("target_id")

    if not character_id or not combat_id or not action_raw:
        raise HTTPException(status_code=400, detail="Missing required fields")

    if world.combat_manager is None:
        raise HTTPException(status_code=503, detail="Combat system not initialised")

    encounter = await world.combat_manager.get_encounter(combat_id)
    if not encounter or encounter.ended:
        raise HTTPException(status_code=404, detail="Combat encounter not found")

    if round_hint is not None and encounter.round_number != int(round_hint):
        raise HTTPException(status_code=409, detail="Round mismatch for action submission")

    combatant_state = encounter.participants.get(character_id)
    if not combatant_state:
        raise HTTPException(status_code=403, detail="Character not part of this combat")

    try:
        action = CombatantAction.from_str(action_raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if combatant_state.combatant_type == "garrison":
        raise HTTPException(status_code=400, detail="Garrison actions are automated")

    if action == CombatantAction.ATTACK and combatant_state.fighters <= 0:
        raise HTTPException(status_code=400, detail="No fighters available for attack")

    destination_sector = None

    if action == CombatantAction.ATTACK:
        if not target_id:
            raise HTTPException(status_code=400, detail="Missing target_id for attack")
        if target_id == character_id:
            raise HTTPException(status_code=400, detail="Cannot target self")
        if target_id not in encounter.participants:
            raise HTTPException(status_code=404, detail="Target combatant not found in encounter")
    elif action == CombatantAction.FLEE:
        if combatant_state.combatant_type != "character":
            raise HTTPException(status_code=400, detail="Only player-controlled combatants can flee")
        destination_sector = parse_move_destination(request)
        validate_move_destination(world, character_id, destination_sector)
    else:
        target_id = None

    if action == CombatantAction.FLEE and combatant_state.is_escape_pod:
        raise HTTPException(status_code=400, detail="Escape pods cannot flee; they are already safe")

    outcome = await world.combat_manager.submit_action(
        combat_id=combat_id,
        combatant_id=character_id,
        action=action,
        commit=commit,
        target_id=target_id,
        destination_sector=destination_sector,
    )

    response = {
        "accepted": True,
        "combat_id": combat_id,
    }

    updated = await world.combat_manager.get_encounter(combat_id)
    if updated:
        response["round"] = updated.round_number
        response["ended"] = updated.ended

    if outcome:
        response["outcome"] = serialize_round(updated or encounter, outcome, include_logs=True)
        response["round_resolved"] = True
    else:
        response["round_resolved"] = False

    return response
