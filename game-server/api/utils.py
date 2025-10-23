import json
from copy import deepcopy
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional, TYPE_CHECKING

from fastapi import HTTPException

from ships import ShipType, get_ship_stats
from trading import get_port_prices, get_port_stock

from sector import generate_scene_variant

if TYPE_CHECKING:
    from combat.models import GarrisonState

COMBAT_ACTION_REQUIRED = (
    "Cannot perform this action during combat. Submit attack/brace/flee instead."
)


def rpc_success(data: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Return standardized success response for RPC handlers."""
    response: Dict[str, Any] = {"success": True}
    if data:
        response.update(data)
    return response


def build_event_source(
    endpoint: str,
    request_id: str,
    *,
    source_type: str = "rpc",
    timestamp: datetime | None = None,
) -> Dict[str, Any]:
    """Construct correlation metadata shared across emitted events."""
    return {
        "type": source_type,
        "method": endpoint,
        "request_id": request_id,
        "timestamp": (timestamp or datetime.now(timezone.utc)).isoformat(),
    }


async def emit_error_event(
    event_dispatcher,
    character_id: str,
    endpoint: str,
    request_id: str,
    error: str,
) -> None:
    """Emit a correlated error event to the requesting character."""

    await event_dispatcher.emit(
        "error",
        {
            "source": build_event_source(endpoint, request_id),
            "endpoint": endpoint,
            "error": error,
        },
        character_filter=[character_id],
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
        commodities = [("QF", "quantum_foam"), ("RO", "retro_organics"), ("NS", "neuro_symbolics")]
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
            "prices": prices,
            "stock": stock,
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
    # if the character is currently in this sector, set observed_at to null
    if (
        current_character_id
        and world.characters[current_character_id].sector == sector_id
        and port
    ):
        port["observed_at"] = None

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
            "id": character.id,
            "name": character.id,  # todo: make name settable
            "player_type": character.player_type,
            "ship": {
                "ship_type": ship_config.ship_type,
                "ship_name": display_name,
            },
        }
        players.append(player)

    # Garrisons
    garrison = await serialize_sector_garrison(
        world, sector_id, current_character_id=current_character_id
    )
    garrisons_list = [deepcopy(garrison)] if garrison else []

    # Salvage containers
    salvage = []
    if getattr(world, "salvage_manager", None):
        for container in world.salvage_manager.list_sector(sector_id):
            salvage.append(container.to_dict())

    # Scene config
    # @TODO: we should be storing / retrieving this from the game world 
    return {
        "id": sector_id,
        "adjacent_sectors": adjacent_sectors,
        "port": port,
        "players": players,
        "garrison": garrison,
        "garrisons": garrisons_list,
        "salvage": salvage,
        "scene_config": generate_scene_variant(sector_id),
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


def resolve_character_name(world, character_id: str) -> str:
    character = world.characters.get(character_id)
    if character:
        display_name = getattr(character, "display_name", None)
        if isinstance(display_name, str) and display_name.strip():
            return display_name
    return character_id


def serialize_garrison_for_client(
    world,
    garrison_state: Optional["GarrisonState"],
    sector_id: int,
    *,
    current_character_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if garrison_state is None:
        return None

    owner_name = resolve_character_name(world, garrison_state.owner_id)
    payload: Dict[str, Any] = {
        "owner_name": owner_name,
        "fighters": garrison_state.fighters,
        "mode": garrison_state.mode,
        "toll_amount": garrison_state.toll_amount,
        "deployed_at": garrison_state.deployed_at,
    }
    if current_character_id is not None:
        payload["is_friendly"] = garrison_state.owner_id == current_character_id
    return payload


async def serialize_sector_garrison(
    world,
    sector_id: int,
    current_character_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not getattr(world, "garrisons", None):
        return None

    garrisons = await world.garrisons.list_sector(sector_id)
    if not garrisons:
        return None

    return serialize_garrison_for_client(
        world,
        garrisons[0],
        sector_id,
        current_character_id=current_character_id,
    )


async def build_local_map_region(
    world,
    *,
    character_id: str,
    center_sector: int,
    max_hops: int = 3,
    max_sectors: int = 100,
) -> Dict[str, Any]:
    """Build local map region with visited/unvisited sectors around a center.

    Args:
        world: World instance
        character_id: Character ID for knowledge lookup
        center_sector: Center sector for the map
        max_hops: Number of hops from center (default 3, max 10)
        max_sectors: Cap on number of sectors to return (default 100)

    Returns:
        Dict with center_sector, sectors list, and totals
    """
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    visited_sectors = set(int(k) for k in knowledge.sectors_visited.keys())

    # BFS to find sectors within range
    result_sectors = []
    distance_map: Dict[int, int] = {center_sector: 0}
    queue = deque([(center_sector, 0)])
    visited_in_bfs = {center_sector}

    # Track which unvisited sectors we've seen
    unvisited_seen: Dict[int, set[int]] = {}

    while queue and len(distance_map) < max_sectors:
        current, hops = queue.popleft()

        if hops >= max_hops:
            continue

        # Get adjacent sectors from knowledge if this sector is visited
        if current in visited_sectors:
            sector_knowledge = knowledge.sectors_visited[str(current)]
            adjacent = sector_knowledge.adjacent_sectors or []

            for adj_id in adjacent:
                adj_id = int(adj_id)

                if adj_id not in visited_in_bfs:
                    visited_in_bfs.add(adj_id)
                    distance_map[adj_id] = hops + 1

                    # Track unvisited sectors
                    if adj_id not in visited_sectors:
                        if adj_id not in unvisited_seen:
                            unvisited_seen[adj_id] = set()
                        unvisited_seen[adj_id].add(current)

                    # Only continue BFS from visited sectors
                    if adj_id in visited_sectors:
                        queue.append((adj_id, hops + 1))

                    # Check sector limit
                    if len(distance_map) >= max_sectors:
                        break

    # Build result with full data for visited, minimal for unvisited
    for sector_id in sorted(distance_map.keys()):
        hops_from_center = distance_map[sector_id]

        if sector_id in visited_sectors:
            # Get full sector contents
            contents = await sector_contents(world, sector_id, character_id)

            # Get last visited time
            sector_knowledge = knowledge.sectors_visited[str(sector_id)]
            last_visited = (
                sector_knowledge.last_visited
                if hasattr(sector_knowledge, "last_visited")
                else None
            )

            # Get sector position from universe graph
            position = (
                world.universe_graph.positions.get(sector_id, (0, 0))
                if world.universe_graph
                else (0, 0)
            )

            # Build lanes from warp data
            lanes = []
            if world.universe_graph and sector_id in world.universe_graph.warps:
                for warp in world.universe_graph.warps[sector_id]:
                    lanes.append(
                        {
                            "to": warp["to"],
                            "two_way": warp["two_way"],
                            "hyperlane": warp["hyperlane"],
                        }
                    )

            sector_dict = {
                "id": sector_id,
                "visited": True,
                "hops_from_center": hops_from_center,
                "adjacent_sectors": contents["adjacent_sectors"],
                "port": contents["port"].get("code", "") if contents["port"] else "",
                "last_visited": last_visited,
                "position": position,
                "lanes": lanes,
            }

            if last_visited:
                sector_dict["last_visited"] = last_visited

            result_sectors.append(sector_dict)
        else:
            # Minimal info for unvisited sectors
            # Get sector position from universe graph
            position = (
                world.universe_graph.positions.get(sector_id, (0, 0))
                if world.universe_graph
                else (0, 0)
            )

            # For unvisited sectors, build lanes from known adjacent visited sectors
            # (these are the lanes we know about that lead to this sector)
            lanes = []
            seen_from_sectors = unvisited_seen.get(sector_id, set())
            for source_sector in seen_from_sectors:
                if world.universe_graph and source_sector in world.universe_graph.warps:
                    # Find the warp from source to this unvisited sector
                    for warp in world.universe_graph.warps[source_sector]:
                        if warp["to"] == sector_id:
                            # This is an incoming lane from the visited sector
                            lanes.append(
                                {
                                    "to": source_sector,
                                    "two_way": warp["two_way"],
                                    "hyperlane": warp["hyperlane"],
                                }
                            )
                            break

            result_sectors.append(
                {
                    "id": sector_id,
                    "visited": False,
                    "hops_from_center": hops_from_center,
                    "position": position,
                    "port": "",
                    "lanes": lanes,
                }
            )

    total_visited = sum(1 for s in result_sectors if s["visited"])
    total_unvisited = len(result_sectors) - total_visited

    return {
        "center_sector": center_sector,
        "sectors": result_sectors,
        "total_sectors": len(result_sectors),
        "total_visited": total_visited,
        "total_unvisited": total_unvisited,
    }
