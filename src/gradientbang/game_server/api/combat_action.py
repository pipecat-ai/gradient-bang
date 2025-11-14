from __future__ import annotations

from fastapi import HTTPException

from gradientbang.game_server.combat.models import CombatantAction
from gradientbang.game_server.api.move import parse_move_destination, validate_move_destination
from gradientbang.game_server.api.utils import (
    rpc_success,
    build_event_source,
    enforce_actor_authorization,
    build_log_context,
)
from gradientbang.game_server.rpc.events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    combat_id = request.get("combat_id")
    action_raw = request.get("action")
    round_hint = request.get("round")
    commit = int(request.get("commit") or 0)
    target_id = request.get("target_id")

    if not character_id or not combat_id or not action_raw:
        raise HTTPException(status_code=400, detail="Missing required fields")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

    if character_id in world.characters:
        character = world.characters[character_id]
        if character.in_hyperspace:
            raise HTTPException(
                status_code=400,
                detail="Character is in hyperspace, cannot perform combat action",
            )

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

    updated = await world.combat_manager.get_encounter(combat_id)
    round_number = updated.round_number if updated else encounter.round_number
    round_resolved = outcome is not None

    request_id = request.get("request_id") or "missing-request-id"
    event_payload = {
        "source": build_event_source("combat.action", request_id),
        "combat_id": combat_id,
        "round": round_number,
        "action": action_raw,
        "round_resolved": round_resolved,
    }

    if commit:
        event_payload["commit"] = commit
    if target_id:
        event_payload["target_id"] = target_id
    if destination_sector is not None:
        event_payload["destination_sector"] = destination_sector

    if action == CombatantAction.PAY:
        pay_processed = None
        if outcome:
            effective = outcome.effective_actions.get(character_id) if outcome.effective_actions else None
            pay_processed = bool(effective and effective.action == CombatantAction.PAY)
        elif updated:
            pending = updated.pending_actions.get(character_id) if hasattr(updated, "pending_actions") else None
            pay_processed = bool(pending and pending.action == CombatantAction.PAY)
        if pay_processed is not None:
            event_payload["pay_processed"] = pay_processed
            if not pay_processed:
                event_payload["message"] = "Payment failed; action treated as brace."

    await event_dispatcher.emit(
        "combat.action_accepted",
        event_payload,
        character_filter=[character_id],
        log_context=build_log_context(character_id=character_id, world=world),
    )

    return rpc_success({"combat_id": combat_id})
