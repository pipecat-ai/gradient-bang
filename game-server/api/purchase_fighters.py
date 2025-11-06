from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from .utils import (
    build_event_source,
    build_log_context,
    build_status_payload,
    emit_error_event,
    enforce_actor_authorization,
    log_trade,
    rpc_success,
)
from ships import FIGHTER_PRICE, ShipType, get_ship_stats
from rpc.events import event_dispatcher


async def _fail(
    character_id: Optional[str],
    request_id: str,
    detail: str,
    *,
    status: int = 400,
) -> None:
    if character_id:
        await emit_error_event(
            event_dispatcher,
            character_id,
            "purchase_fighters",
            request_id,
            detail,
        )
    raise HTTPException(status_code=status, detail=detail)


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    units = request.get("units")
    request_id = request.get("request_id") or "missing-request-id"

    if not character_id or units is None:
        raise HTTPException(status_code=400, detail="Missing character_id or units")

    if not isinstance(units, int) or units <= 0:
        raise HTTPException(status_code=400, detail="units must be a positive integer")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_id}")

    character = world.characters[character_id]
    if character.in_hyperspace:
        await _fail(character_id, request_id, "Cannot purchase fighters while in hyperspace")

    if character.sector != 0:
        await _fail(
            character_id,
            request_id,
            f"Fighter armory is only available in sector 0. You are in sector {character.sector}",
        )

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_id = getattr(knowledge, "current_ship_id", None)
    ship = world.ships_manager.get_ship(ship_id) if ship_id else None
    if ship is None:
        raise HTTPException(status_code=500, detail="Ship data unavailable")

    ship_stats = get_ship_stats(ShipType(ship["ship_type"]))
    ship_state = ship.get("state", {}) or {}
    current_fighters = int(ship_state.get("fighters", ship_stats.fighters))
    max_fighters = ship_stats.fighters

    available_capacity = max_fighters - current_fighters
    if available_capacity <= 0:
        await _fail(character_id, request_id, "Fighter capacity is already at maximum")

    units_to_buy = min(units, available_capacity)
    total_cost = units_to_buy * FIGHTER_PRICE
    ship_credits = int(ship_state.get("credits", 0))
    if ship_credits < total_cost:
        await _fail(
            character_id,
            request_id,
            f"Insufficient credits. Need {total_cost} but only have {ship_credits}",
        )

    new_credits = ship_credits - total_cost
    new_fighters = current_fighters + units_to_buy

    world.ships_manager.update_ship_state(ship_id, fighters=new_fighters)
    world.knowledge_manager.update_ship_credits(character_id, new_credits)
    if hasattr(knowledge, "credits"):
        knowledge.credits = new_credits
    world.knowledge_manager.save_knowledge(knowledge)

    character.update_activity()
    log_context = build_log_context(
        character_id=character_id,
        world=world,
        sector=character.sector,
        timestamp=character.last_active,
    )

    log_trade(
        character_id=character_id,
        sector=character.sector,
        trade_type="buy",
        commodity="fighters",
        quantity=units_to_buy,
        price_per_unit=FIGHTER_PRICE,
        total_price=total_cost,
        credits_after=new_credits,
    )

    timestamp = character.last_active.isoformat()
    status_payload = await build_status_payload(world, character_id)
    ship_payload = status_payload.get("ship", {})
    player_payload = status_payload.get("player", {})
    sector_payload = status_payload.get("sector", {"id": character.sector})

    await event_dispatcher.emit(
        "fighter.purchase",
        {
            "source": build_event_source("purchase_fighters", request_id),
            "character_id": character_id,
            "timestamp": timestamp,
            "sector": sector_payload,
            "units": units_to_buy,
            "price_per_unit": FIGHTER_PRICE,
            "total_cost": total_cost,
            "fighters_before": current_fighters,
            "fighters_after": new_fighters,
            "max_fighters": max_fighters,
            "credits_before": ship_credits,
            "credits_after": new_credits,
            "ship": ship_payload,
            "player": player_payload,
        },
        character_filter=[character_id],
        log_context=log_context,
    )

    await event_dispatcher.emit(
        "status.update",
        status_payload,
        character_filter=[character_id],
        log_context=log_context,
    )

    return rpc_success()
