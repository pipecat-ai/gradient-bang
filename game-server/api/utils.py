import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional

from fastapi import HTTPException

from ships import ShipType, get_ship_stats
from trading import get_port_prices, get_port_stock


COMBAT_ACTION_REQUIRED = (
    "Cannot perform this action during combat. Submit attack/brace/flee instead."
)


async def ensure_not_in_combat(world, character_id: str) -> None:
    """Raise if the character is currently participating in active combat."""

    manager = getattr(world, "combat_manager", None)
    if manager is None:
        return
    encounter = await manager.find_encounter_for(character_id)
    if encounter and not encounter.ended:
        raise HTTPException(status_code=409, detail=COMBAT_ACTION_REQUIRED)


def log_trade(
    character_id: str,
    sector: int,
    trade_type: str,
    commodity: str,
    quantity: int,
    price_per_unit: int,
    total_price: int,
    credits_after: int,
) -> None:
    """Append a trade (or warp power) transaction to JSONL trade history."""
    trade_log_path = (
        Path(__file__).parent.parent.parent / "world-data" / "trade_history.jsonl"
    )

    trade_record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "character_id": character_id,
        "sector": sector,
        "trade_type": trade_type,
        "commodity": commodity,
        "quantity": quantity,
        "price_per_unit": price_per_unit,
        "total_price": total_price,
        "credits_after": credits_after,
    }

    try:
        with open(trade_log_path, "a") as f:
            f.write(json.dumps(trade_record) + "\n")
    except Exception as e:
        print(f"Failed to log trade: {e}")


def player_self(world, character_id: str) -> Dict[str, Any]:
    """Build player status for player's own character."""
    character = world.characters[character_id]
    return {
        "created_at": character.first_visit.isoformat(),
        "last_active": character.last_active.isoformat(),
        "id": character.id,
        "name": character.id,  # todo: make name settable
        "credits_on_hand": world.knowledge_manager.get_credits(character_id),
        "credits_in_bank": 0,
    }


def ship_self(world, character_id: str) -> Dict[str, Any]:
    """Build ship status for player's own ship."""
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_config = knowledge.ship_config
    ship_stats = get_ship_stats(ShipType(ship_config.ship_type))

    # Use custom name if set, otherwise default to ship type name
    display_name = ship_config.ship_name or ship_stats.name

    # todo: refactor ship_config and ship_stats
    return {
        "ship_type": ship_config.ship_type,
        "ship_name": display_name,
        "cargo": ship_config.cargo,
        "cargo_capacity": ship_stats.cargo_holds,
        "warp_power": ship_config.current_warp_power,
        "warp_power_capacity": ship_stats.warp_power_capacity,
        "shields": ship_config.current_shields,
        "max_shields": ship_stats.shields,
        "fighters": ship_config.current_fighters,
        "max_fighters": ship_stats.fighters,
    }


def port_snapshot(world, sector_id: int) -> Dict[str, Any]:
    """Compute port snapshot visible to a character."""
    port = None
    port_state = world.port_manager.load_port_state(sector_id)
    if port_state:
        # Compute current prices now, but only store/send minimal snapshot
        full_port_for_pricing = {
            "class": port_state.port_class,
            "code": port_state.code,
            "stock": port_state.stock,
            "max_capacity": port_state.max_capacity,
            "buys": [],
            "sells": [],
        }
        commodities = [("FO", "fuel_ore"), ("OG", "organics"), ("EQ", "equipment")]
        for i, (key, name) in enumerate(commodities):
            if port_state.code[i] == "B":
                full_port_for_pricing["buys"].append(name)
            else:
                full_port_for_pricing["sells"].append(name)
        prices = get_port_prices(full_port_for_pricing)
        stock = get_port_stock(full_port_for_pricing)
        if sector_id == 0:
            prices["warp_power_depot"] = {
                "price_per_unit": 2,
                "note": "Special warp power depot - recharge your ship",
            }
        port = {
            "code": port_state.code,
            "last_seen_prices": prices,
            "last_seen_stock": stock,
            "observed_at": datetime.now(timezone.utc).isoformat(),
        }
    return port


async def sector_contents(
    world, sector_id: int, current_character_id: Optional[str] = None
) -> Dict[str, Any]:
    """Compute contents of a sector visible to a character."""

    # adjacent_sectors
    adjacent_sectors = sorted(world.universe_graph.adjacency[sector_id])

    # Port (minimal snapshot) -- todo: write tests and refactor this. there's much more logic here than there needs to be
    port = port_snapshot(world, sector_id)

    # Other players (names + ship type when known)
    players = []
    for char_id, character in world.characters.items():
        if character.sector != sector_id or char_id == current_character_id:
            continue
        if character.in_hyperspace:  # Skip characters in transit
            continue
        # fill in created_at, name, player_type, ship
        knowledge = world.knowledge_manager.load_knowledge(char_id)
        ship_config = knowledge.ship_config
        ship_stats = get_ship_stats(ShipType(ship_config.ship_type))

        # Use custom name if set, otherwise default to ship type name
        display_name = ship_config.ship_name or ship_stats.name

        player = {
            "created_at": character.first_visit.isoformat(),
            "name": character.id,  # todo: make name settable
            "player_type": character.player_type,
            "ship": {
                "ship_type": ship_config.ship_type,
                "ship_name": display_name,
            },
        }
        players.append(player)

    # Garrisons
    garrisons = []
    if getattr(world, "garrisons", None):
        for garrison in await world.garrisons.list_sector(sector_id):
            entry = garrison.to_dict()
            entry["is_friendly"] = garrison.owner_id == current_character_id
            garrisons.append(entry)

    # Salvage containers
    salvage = []
    if getattr(world, "salvage_manager", None):
        for container in world.salvage_manager.list_sector(sector_id):
            salvage.append(container.to_dict())

    return {
        "id": sector_id,
        "adjacent_sectors": adjacent_sectors,
        "port": port,
        "players": players,
        "garrisons": garrisons,
        "salvage": salvage,
    }


async def build_status_payload(
    world,
    character_id: str,
) -> Dict[str, Any]:
    """Assemble the canonical status payload for a character."""
    character = world.characters[character_id]

    return {
        "player": player_self(world, character_id),
        "ship": ship_self(world, character_id),
        "sector": await sector_contents(world, character.sector, character_id),
    }
