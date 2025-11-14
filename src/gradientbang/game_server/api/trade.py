from copy import deepcopy
from datetime import datetime, timezone

from fastapi import HTTPException

from gradientbang.game_server.api.utils import (
    log_trade,
    ensure_not_in_combat,
    player_self,
    ship_self,
    port_snapshot,
    build_event_source,
    build_status_payload,
    rpc_success,
    enforce_actor_authorization,
    build_log_context,
)
from gradientbang.game_server.rpc.events import event_dispatcher
from gradientbang.game_server.trading import TradingError
from gradientbang.game_server.ships import ShipType, get_ship_stats


async def handle(request: dict, world, port_locks=None) -> dict:
    character_id = request.get("character_id")
    commodity = request.get("commodity")
    quantity = request.get("quantity")
    trade_type = request.get("trade_type")
    request_id = request.get("request_id") or "missing-request-id"

    if not all([character_id, commodity, quantity, trade_type]):
        raise HTTPException(status_code=400, detail="Missing required parameters")

    enforce_actor_authorization(
        world,
        target_character_id=character_id,
        actor_character_id=request.get("actor_character_id"),
        admin_override=bool(request.get("admin_override")),
    )

    if character_id not in world.characters:
        raise HTTPException(status_code=404, detail="Character not found")

    character = world.characters[character_id]
    if character.in_hyperspace:
        raise HTTPException(
            status_code=400,
            detail="Character is in hyperspace, cannot trade",
        )

    await ensure_not_in_combat(world, character_id)
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship = world.knowledge_manager.get_ship(character_id)
    ship_stats = get_ship_stats(ShipType(ship["ship_type"]))

    # Pre-validation before acquiring lock
    port_state = world.port_manager.load_port_state(character.sector)
    if not port_state:
        raise HTTPException(status_code=400, detail="No port at current location")

    if commodity not in ["quantum_foam", "retro_organics", "neuro_symbolics"]:
        raise HTTPException(status_code=400, detail=f"Invalid commodity: {commodity}")

    commodity_key = {"quantum_foam": "QF", "retro_organics": "RO", "neuro_symbolics": "NS"}[commodity]

    # Acquire port lock for atomic trade operation
    # If port_locks not provided (for backwards compatibility), skip locking
    if port_locks is not None:
        async with port_locks.lock(character.sector, character_id):
            return await _execute_trade(
                trade_type,
                commodity,
                commodity_key,
                quantity,
                character,
                character_id,
                knowledge,
                ship_stats,
                world,
                port_state,
                request_id,
            )
    else:
        return await _execute_trade(
            trade_type,
            commodity,
            commodity_key,
            quantity,
            character,
            character_id,
            knowledge,
            ship_stats,
            world,
            port_state,
            request_id,
        )


async def _execute_trade(
    trade_type: str,
    commodity: str,
    commodity_key: str,
    quantity: int,
    character,
    character_id: str,
    knowledge,
    ship_stats,
    world,
    port_state,
    request_id: str,
) -> dict:
    """Execute trade operation (must be called with port lock held)."""
    from gradientbang.game_server.trading import (
        calculate_price_sell_to_player,
        calculate_price_buy_from_player,
        validate_buy_transaction,
        validate_sell_transaction,
        get_port_prices,
    )

    commodities = [("QF", "quantum_foam"), ("RO", "retro_organics"), ("NS", "neuro_symbolics")]
    log_context = build_log_context(
        character_id=character_id,
        world=world,
        sector=character.sector,
    )

    ship_id = getattr(knowledge, "current_ship_id", None)
    ship = world.ships_manager.get_ship(ship_id) if ship_id else None
    if ship is None:
        raise HTTPException(status_code=500, detail="Ship data unavailable")
    ship_state = ship.get("state", {})
    ship_credits = int(ship_state.get("credits", 0))
    cargo_state = dict(ship_state.get("cargo", {}))
    for key in ("quantum_foam", "retro_organics", "neuro_symbolics"):
        cargo_state.setdefault(key, 0)

    def build_port_data(state):
        port_data = {
            "class": state.port_class,
            "code": state.code,
            "stock": state.stock,
            "max_capacity": state.max_capacity,
            "buys": [],
            "sells": [],
        }
        for i, (key, name) in enumerate(commodities):
            if state.code[i] == "B":
                port_data["buys"].append(name)
            else:
                port_data["sells"].append(name)
        return port_data

    async def _broadcast_port_update():
        base_port = port_snapshot(world, character.sector)
        if not base_port:
            return

        characters_in_sector = [
            cid
            for cid, char in world.characters.items()
            if char.sector == character.sector and not char.in_hyperspace
        ]
        if not characters_in_sector:
            return

        observation_time = datetime.now(timezone.utc).isoformat()
        knowledge_port = deepcopy(base_port)
        knowledge_port["observed_at"] = observation_time

        event_port = deepcopy(base_port)
        event_port["observed_at"] = None

        for cid in characters_in_sector:
            world.knowledge_manager.update_port_observation(
                cid,
                character.sector,
                knowledge_port,
            )

        sector_payload = {"id": character.sector, "port": event_port}

        await event_dispatcher.emit(
            "port.update",
            {
                "sector": sector_payload,
                "updated_at": observation_time,
            },
            character_filter=characters_in_sector,
            log_context=build_log_context(
                character_id=character_id,
                world=world,
                sector=character.sector,
            ),
        )

    if trade_type == "buy":
        idx = {"QF": 0, "RO": 1, "NS": 2}[commodity_key]
        if port_state.code[idx] != "S":
            raise HTTPException(
                status_code=400, detail=f"Port does not sell {commodity}"
            )
        price_per_unit = calculate_price_sell_to_player(
            commodity,
            port_state.stock[commodity_key],
            port_state.max_capacity[commodity_key],
        )
        try:
            validate_buy_transaction(
                ship_credits,
                sum(cargo_state.values()),
                ship_stats.cargo_holds,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                price_per_unit,
            )
        except TradingError as e:
            raise HTTPException(status_code=400, detail=str(e))
        total_price = price_per_unit * quantity
        new_ship_credits = ship_credits - total_price
        world.knowledge_manager.update_ship_credits(character_id, new_ship_credits)
        cargo_state[commodity] += quantity
        world.ships_manager.update_ship_state(ship_id, cargo=cargo_state)
        world.port_manager.update_port_inventory(
            character.sector, commodity_key, quantity, "buy"
        )
        updated_port_state = world.port_manager.load_port_state(character.sector)
        port_data = build_port_data(updated_port_state)
        new_prices = get_port_prices(port_data)

        log_trade(
            character_id=character_id,
            sector=character.sector,
            trade_type="buy",
            commodity=commodity,
            quantity=quantity,
            price_per_unit=price_per_unit,
            total_price=total_price,
            credits_after=new_ship_credits,
        )

        # Emit trade.executed event to the trader
        await event_dispatcher.emit(
            "trade.executed",
            {
                "source": build_event_source("trade", request_id),
                "player": player_self(world, character_id),
                "ship": ship_self(world, character_id),
                "trade": {
                    "trade_type": "buy",
                    "commodity": commodity,
                    "units": quantity,
                    "price_per_unit": price_per_unit,
                    "total_price": total_price,
                    "new_credits": new_ship_credits,
                    "new_cargo": cargo_state,
                    "new_prices": new_prices,
                },
            },
            character_filter=[character_id],
            log_context=log_context,
        )

        # Emit status.update after trade
        status_payload = await build_status_payload(world, character_id)
        await event_dispatcher.emit(
            "status.update",
            status_payload,
            character_filter=[character_id],
            log_context=log_context,
        )

        await _broadcast_port_update()

        return rpc_success()
    else:
        idx = {"QF": 0, "RO": 1, "NS": 2}[commodity_key]
        if port_state.code[idx] != "B":
            raise HTTPException(
                status_code=400, detail=f"Port does not buy {commodity}"
            )
        price_per_unit = calculate_price_buy_from_player(
            commodity,
            port_state.stock[commodity_key],
            port_state.max_capacity[commodity_key],
        )
        try:
            validate_sell_transaction(
                cargo_state,
                commodity,
                quantity,
                port_state.stock[commodity_key],
                port_state.max_capacity[commodity_key],
            )
        except TradingError as e:
            raise HTTPException(status_code=400, detail=str(e))
        total_price = price_per_unit * quantity
        new_ship_credits = ship_credits + total_price
        world.knowledge_manager.update_ship_credits(character_id, new_ship_credits)
        cargo_state[commodity] = max(0, cargo_state.get(commodity, 0) - quantity)
        world.ships_manager.update_ship_state(ship_id, cargo=cargo_state)
        world.port_manager.update_port_inventory(
            character.sector, commodity_key, quantity, "sell"
        )
        updated_port_state = world.port_manager.load_port_state(character.sector)
        port_data = build_port_data(updated_port_state)
        new_prices = get_port_prices(port_data)

        log_trade(
            character_id=character_id,
            sector=character.sector,
            trade_type="sell",
            commodity=commodity,
            quantity=quantity,
            price_per_unit=price_per_unit,
            total_price=total_price,
            credits_after=new_ship_credits,
        )

        # Emit trade.executed event to the trader
        await event_dispatcher.emit(
            "trade.executed",
            {
                "source": build_event_source("trade", request_id),
                "player": player_self(world, character_id),
                "ship": ship_self(world, character_id),
                "trade": {
                    "trade_type": "sell",
                    "commodity": commodity,
                    "units": quantity,
                    "price_per_unit": price_per_unit,
                    "total_price": total_price,
                    "new_credits": new_ship_credits,
                    "new_cargo": cargo_state,
                    "new_prices": new_prices,
                },
            },
            character_filter=[character_id],
            log_context=log_context,
        )

        # Emit status.update after trade
        status_payload = await build_status_payload(world, character_id)
        await event_dispatcher.emit(
            "status.update",
            status_payload,
            character_filter=[character_id],
            log_context=log_context,
        )

        await _broadcast_port_update()

        return rpc_success()
