from fastapi import HTTPException
from api.utils import log_trade


async def handle(request: dict, world) -> dict:
    character_id = request.get("character_id")
    commodity = request.get("commodity")
    quantity = request.get("quantity")
    trade_type = request.get("trade_type")

    if not all([character_id, commodity, quantity, trade_type]):
        raise HTTPException(status_code=400, detail="Missing required parameters")
    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    from ships import ShipType, get_ship_stats
    ship_stats = get_ship_stats(ShipType(knowledge.ship_config.ship_type))

    port_state = world.port_manager.load_port_state(character.sector)
    if not port_state:
        raise HTTPException(status_code=400, detail="No port at current location")

    if commodity not in ["fuel_ore", "organics", "equipment"]:
        raise HTTPException(status_code=400, detail=f"Invalid commodity: {commodity}")

    commodity_key = {"fuel_ore": "FO", "organics": "OG", "equipment": "EQ"}[commodity]

    from trading import (
        calculate_price_sell_to_player,
        calculate_price_buy_from_player,
        validate_buy_transaction,
        validate_sell_transaction,
        TradingError,
        get_port_prices,
    )

    if trade_type == "buy":
        idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
        if port_state.code[idx] != "S":
            raise HTTPException(status_code=400, detail=f"Port does not sell {commodity}")
        price_per_unit = calculate_price_sell_to_player(
            commodity, port_state.stock[commodity_key], port_state.max_capacity[commodity_key]
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
        total_price = price_per_unit * quantity
        new_credits = knowledge.credits - total_price
        world.knowledge_manager.update_credits(character_id, new_credits)
        world.knowledge_manager.update_cargo(character_id, commodity, quantity)
        world.port_manager.update_port_inventory(character.sector, commodity_key, quantity, "buy")
        updated_port_state = world.port_manager.load_port_state(character.sector)
        updated_cargo = world.knowledge_manager.get_cargo(character_id)

        port_data = {
            "class": updated_port_state.port_class,
            "code": updated_port_state.code,
            "stock": updated_port_state.stock,
            "max_capacity": updated_port_state.max_capacity,
            "buys": [],
            "sells": [],
        }
        commodities = [("FO", "fuel_ore"), ("OG", "organics"), ("EQ", "equipment")]
        for i, (key, name) in enumerate(commodities):
            if updated_port_state.code[i] == "B":
                port_data["buys"].append(name)
            else:
                port_data["sells"].append(name)
        new_prices = get_port_prices(port_data)

        log_trade(
            character_id=character_id,
            sector=character.sector,
            trade_type="buy",
            commodity=commodity,
            quantity=quantity,
            price_per_unit=price_per_unit,
            total_price=total_price,
            credits_after=new_credits,
        )

        return {
            "success": True,
            "trade_type": "buy",
            "commodity": commodity,
            "units": quantity,
            "price_per_unit": price_per_unit,
            "total_price": total_price,
            "new_credits": new_credits,
            "new_cargo": updated_cargo,
            "new_prices": new_prices,
        }
    else:
        idx = {"FO": 0, "OG": 1, "EQ": 2}[commodity_key]
        if port_state.code[idx] != "B":
            raise HTTPException(status_code=400, detail=f"Port does not buy {commodity}")
        price_per_unit = calculate_price_buy_from_player(
            commodity, port_state.stock[commodity_key], port_state.max_capacity[commodity_key]
        )
        validate_sell_transaction(
            knowledge.ship_config.cargo,
            commodity,
            quantity,
            port_state.stock[commodity_key],
            port_state.max_capacity[commodity_key],
        )
        total_price = price_per_unit * quantity
        new_credits = knowledge.credits + total_price
        world.knowledge_manager.update_credits(character_id, new_credits)
        world.knowledge_manager.update_cargo(character_id, commodity, -quantity)
        world.port_manager.update_port_inventory(character.sector, commodity_key, quantity, "sell")

        log_trade(
            character_id=character_id,
            sector=character.sector,
            trade_type="sell",
            commodity=commodity,
            quantity=quantity,
            price_per_unit=price_per_unit,
            total_price=total_price,
            credits_after=new_credits,
        )

        return {
            "success": True,
            "trade_type": "sell",
            "commodity": commodity,
            "units": quantity,
            "price_per_unit": price_per_unit,
            "total_price": total_price,
            "new_credits": new_credits,
            "new_cargo": world.knowledge_manager.get_cargo(character_id),
        }
