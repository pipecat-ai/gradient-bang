from fastapi import HTTPException
from .utils import ensure_not_in_combat


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    commodity = request.get("commodity")
    quantity = request.get("quantity")
    trade_type = request.get("trade_type")

    if not all([character_id, commodity, quantity, trade_type]):
        raise HTTPException(status_code=400, detail="Missing required parameters")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    await ensure_not_in_combat(world, character_id)

    character = world.characters[character_id]
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    from ships import ShipType, get_ship_stats

    ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))

    port_state = world.port_manager.load_port_state(character.sector)
    if not port_state:
        return {
            "can_trade": False,
            "error": "No port at current location",
            "current_credits": knowledge.credits,
            "current_cargo": knowledge.ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(knowledge.ship_config.cargo.values()),
        }

    if commodity not in ["fuel_ore", "organics", "equipment"]:
        return {
            "can_trade": False,
            "error": f"Invalid commodity: {commodity}",
            "current_credits": knowledge.credits,
            "current_cargo": knowledge.ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(knowledge.ship_config.cargo.values()),
        }

    commodity_key = {"fuel_ore": "FO", "organics": "OG", "equipment": "EQ"}[commodity]

    from trading import (
        calculate_price_sell_to_player,
        calculate_price_buy_from_player,
        validate_buy_transaction,
        validate_sell_transaction,
        TradingError,
    )

    try:
        if trade_type == "buy":
            idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
            if port_state.code[idx] != "S":
                return {
                    "can_trade": False,
                    "error": f"Port does not sell {commodity}",
                    "current_credits": knowledge.credits,
                    "current_cargo": knowledge.ship_config.cargo,
                    "cargo_capacity": ship_stats.cargo_holds,
                    "cargo_used": sum(knowledge.ship_config.cargo.values()),
                }
            price_per_unit = calculate_price_sell_to_player(
                commodity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key],
            )
            validate_buy_transaction(
                knowledge.credits,
                sum(knowledge.ship_config.cargo.values()),
                ship_stats.cargo_holds,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                price_per_unit,
            )
        else:
            idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
            if port_state.code[idx] != "B":
                return {
                    "can_trade": False,
                    "error": f"Port does not buy {commodity}",
                    "current_credits": knowledge.credits,
                    "current_cargo": knowledge.ship_config.cargo,
                    "cargo_capacity": ship_stats.cargo_holds,
                    "cargo_used": sum(knowledge.ship_config.cargo.values()),
                }
            price_per_unit = calculate_price_buy_from_player(
                commodity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key],
            )
            validate_sell_transaction(
                knowledge.ship_config.cargo,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key],
            )

        total_price = price_per_unit * quantity
        return {
            "can_trade": True,
            "price_per_unit": price_per_unit,
            "total_price": total_price,
            "current_credits": knowledge.credits,
            "current_cargo": knowledge.ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(knowledge.ship_config.cargo.values()),
        }
    except TradingError as e:
        return {
            "can_trade": False,
            "error": str(e),
            "current_credits": knowledge.credits,
            "current_cargo": knowledge.ship_config.cargo,
            "cargo_capacity": ship_stats.cargo_holds,
            "cargo_used": sum(knowledge.ship_config.cargo.values()),
        }
