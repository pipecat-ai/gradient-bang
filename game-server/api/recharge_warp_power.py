from fastapi import HTTPException
from .utils import log_trade, build_status_payload
from ships import ShipType, get_ship_stats
from events import event_dispatcher


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    units = request.get("units")
    if not character_id or units is None:
        raise HTTPException(status_code=400, detail="Missing character_id or units")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail=f"Character not found: {character_id}")

    character = world.characters[character_id]
    if character.sector != 0:
        raise HTTPException(status_code=400, detail=f"Warp power depot is only available in sector 0. You are in sector {character.sector}")

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))
    current_warp_power = knowledge.ship_config.current_warp_power
    warp_power_capacity = ship_stats.warp_power_capacity
    max_units = warp_power_capacity - current_warp_power
    if max_units <= 0:
        return {
            "success": False,
            "units_bought": 0,
            "price_per_unit": 2,
            "total_cost": 0,
            "new_warp_power": current_warp_power,
            "warp_power_capacity": warp_power_capacity,
            "new_credits": knowledge.credits,
            "message": "Warp power is already at maximum",
        }

    units_to_buy = min(units, max_units)
    price_per_unit = 2
    total_cost = units_to_buy * price_per_unit
    if knowledge.credits < total_cost:
        return {
            "success": False,
            "units_bought": 0,
            "price_per_unit": price_per_unit,
            "total_cost": total_cost,
            "new_warp_power": current_warp_power,
            "warp_power_capacity": warp_power_capacity,
            "new_credits": knowledge.credits,
            "message": f"Insufficient credits. Need {total_cost} but only have {knowledge.credits}",
        }

    new_credits = knowledge.credits - total_cost
    new_warp_power = current_warp_power + units_to_buy
    knowledge.credits = new_credits
    knowledge.ship_config.current_warp_power = new_warp_power
    world.knowledge_manager.save_knowledge(knowledge)
    character.update_activity()

    log_trade(
        character_id=character_id,
        sector=character.sector,
        trade_type="buy",
        commodity="warp_power",
        quantity=units_to_buy,
        price_per_unit=price_per_unit,
        total_price=total_cost,
        credits_after=new_credits,
    )

    character.update_activity()
    timestamp = character.last_active.isoformat()

    await event_dispatcher.emit(
        "warp.purchase",
        {
            "character_id": character_id,
            "sector": character.sector,
            "units": units_to_buy,
            "price_per_unit": price_per_unit,
            "total_cost": total_cost,
            "timestamp": timestamp,
        },
        character_filter=[character_id],
    )

    status_payload = build_status_payload(world, character_id)
    await event_dispatcher.emit("status.update", status_payload, character_filter=[character_id])

    return {
        "success": True,
        "units_bought": units_to_buy,
        "price_per_unit": price_per_unit,
        "total_cost": total_cost,
        "new_warp_power": new_warp_power,
        "warp_power_capacity": warp_power_capacity,
        "new_credits": new_credits,
        "message": f"Successfully bought {units_to_buy} warp power units for {total_cost} credits at sector 0 depot",
    }
