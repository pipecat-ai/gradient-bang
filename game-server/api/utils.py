import inspect
import json
from copy import deepcopy
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Iterable, Optional, TYPE_CHECKING, List

from fastapi import HTTPException

from ships import ShipType, get_ship_stats
from trading import get_port_prices, get_port_stock

from sector import generate_scene_variant
from rpc.events import EventLogContext

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


def enforce_actor_authorization(
    world,
    *,
    target_character_id: str,
    actor_character_id: Optional[str],
    admin_override: bool = False,
) -> None:
    """Ensure the actor is authorized to control the target entity.

    For corporation-owned autonomous ships we require that the actor be a
    member of the owning corporation unless an explicit admin override is set.
    """

    ships_manager = getattr(world, "ships_manager", None)
    if ships_manager is None:
        return

    try:
        ship = ships_manager.get_ship(target_character_id)
    except KeyError:
        ship = None

    if not ship or ship.get("ship_id") != target_character_id:
        # Target is not a ship; nothing to enforce
        return

    if ship.get("owner_type") != "corporation":
        return

    if admin_override:
        return

    if not actor_character_id:
        raise HTTPException(
            status_code=400,
            detail="actor_character_id is required when controlling a corporation ship",
        )

    corp_id = ship.get("owner_id")
    if not corp_id:
        raise HTTPException(
            status_code=403,
            detail="Corporation ship is missing ownership data",
        )

    corp_cache = getattr(world, "character_to_corp", None)
    actor_corp_id = None
    if isinstance(corp_cache, dict):
        actor_corp_id = corp_cache.get(actor_character_id)

    if actor_corp_id != corp_id:
        raise HTTPException(
            status_code=403,
            detail="Actor is not authorized to control this corporation ship",
        )


def _get_character_ship(world, character_id: str):
    """Return (ship_record, knowledge) for the character."""
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship = world.knowledge_manager.get_ship(character_id)
    return ship, knowledge


def build_public_player_data(world, character_id: str) -> Dict[str, Any]:
    """Build public player data (no private stats like credits/cargo/warp).

    Used in sector.update, transfer events, and other public contexts.
    Pattern matches sector_contents() player list items.

    Returns:
        {
            "created_at": "2025-10-28T10:00:00.000Z",
            "id": "character_uuid",
            "name": "Display Name",
            "player_type": "human",
            "ship": {
                "ship_type": "kestrel_courier",
                "ship_name": "Ship Name"
            }
        }
    """
    character = world.characters[character_id]
    ship, _ = _get_character_ship(world, character_id)
    ship_type_value = ship["ship_type"]
    ship_stats = get_ship_stats(ShipType(ship_type_value))
    ship_name = ship.get("name") or ship_stats.name

    display_name = resolve_character_name(world, character_id)

    corp_info: Dict[str, Any] | None = None
    corp_cache = getattr(world, "character_to_corp", None)
    corp_id = None
    if isinstance(corp_cache, dict):
        corp_id = corp_cache.get(character_id)
    if corp_id:
        corp_manager = getattr(world, "corporation_manager", None)
        if corp_manager is not None:
            try:
                corp = corp_manager.load(corp_id)
            except FileNotFoundError:
                corp = None
            if corp and corp.get("name"):
                corp_info = {
                    "corp_id": corp_id,
                    "name": corp.get("name"),
                }
                if character.player_type != "corporation_ship":
                    corp_info["member_count"] = len(corp.get("members", []) or [])
        if corp_info is None:
            corp_info = {"corp_id": corp_id}

    return {
        "created_at": character.first_visit.isoformat(),
        "id": character.id,
        "name": display_name,
        "player_type": character.player_type,
        "corporation": corp_info,
        "ship": {
            "ship_type": ship_type_value,
            "ship_name": ship_name,
        },
    }


def build_character_moved_payload(
    world,
    character_id: str,
    *,
    move_type: str,
    movement: Optional[str] = None,
    timestamp: Optional[datetime | str] = None,
    knowledge: Any | None = None,
    extra_fields: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Construct a standardized character.moved payload."""

    if knowledge is None:
        knowledge = world.knowledge_manager.load_knowledge(character_id)

    ship, _ = _get_character_ship(world, character_id)
    ship_type_value = ship["ship_type"]
    ship_stats = get_ship_stats(ShipType(ship_type_value))
    display_name = ship.get("name") or ship_stats.name

    if isinstance(timestamp, datetime):
        iso_timestamp = timestamp.isoformat()
    elif isinstance(timestamp, str):
        iso_timestamp = timestamp
    else:
        iso_timestamp = datetime.now(timezone.utc).isoformat()

    payload: Dict[str, Any] = {
        "player": {
            "id": character_id,
            "name": resolve_character_name(world, character_id),
        },
        "ship": {
            "ship_name": display_name,
            "ship_type": ship_type_value,
        },
        "timestamp": iso_timestamp,
        "move_type": move_type,
        # Legacy fields retained for backward compatibility
        "name": character_id,
        "ship_type": ship_type_value,
    }

    if movement is not None:
        payload["movement"] = movement

    if extra_fields:
        payload.update(extra_fields)

    return payload


async def emit_garrison_character_moved_event(
    world,
    dispatcher,
    *,
    sector_id: int,
    payload: Dict[str, Any],
) -> None:
    """Emit garrison.character_moved to connected corp members when applicable."""

    garrison_store = getattr(world, "garrisons", None)
    if not garrison_store:
        return

    list_sector = getattr(garrison_store, "list_sector", None)
    if list_sector is None:
        return

    garrisons = list_sector(sector_id)
    if inspect.isawaitable(garrisons):
        garrisons = await garrisons
    if not garrisons:
        return

    character_to_corp = getattr(world, "character_to_corp", None)
    if not isinstance(character_to_corp, dict):
        return

    characters = getattr(world, "characters", {})

    for garrison in garrisons or []:
        owner_id = getattr(garrison, "owner_id", None)
        if owner_id is None and isinstance(garrison, dict):
            owner_id = garrison.get("owner_id")
        if not owner_id:
            continue

        corp_id = character_to_corp.get(owner_id)
        if not corp_id:
            continue

        recipients: list[str] = []
        owner_state = characters.get(owner_id)
        if owner_state and getattr(owner_state, "connected", False):
            recipients.append(owner_id)

        for character_id, character in characters.items():
            if character_id == owner_id:
                continue
            if not getattr(character, "connected", False):
                continue
            if character_to_corp.get(character_id) == corp_id:
                recipients.append(character_id)

        if not recipients:
            continue

        recipients = list(dict.fromkeys(recipients))

        fighters = getattr(garrison, "fighters", None)
        if fighters is None and isinstance(garrison, dict):
            fighters = garrison.get("fighters")

        toll_amount = getattr(garrison, "toll_amount", None)
        if toll_amount is None and isinstance(garrison, dict):
            toll_amount = garrison.get("toll_amount")

        deployed_at = getattr(garrison, "deployed_at", None)
        if deployed_at is None and isinstance(garrison, dict):
            deployed_at = garrison.get("deployed_at")

        mode = getattr(garrison, "mode", None)
        if mode is None and isinstance(garrison, dict):
            mode = garrison.get("mode")

        garrison_payload = {
            "owner_id": owner_id,
            "owner_name": resolve_character_name(world, owner_id),
            "corporation_id": corp_id,
            "fighters": fighters,
            "mode": mode,
            "toll_amount": toll_amount,
            "deployed_at": deployed_at,
        }

        event_payload = deepcopy(payload)
        event_payload["garrison"] = garrison_payload

        log_context = build_log_context(
            character_id=owner_id,
            world=world,
            sector=sector_id,
            corporation_id=corp_id,
        )

        await dispatcher.emit(
            "garrison.character_moved",
            event_payload,
            character_filter=recipients,
            log_context=log_context,
        )


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
    *,
    world=None,
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
        log_context=build_log_context(character_id=character_id, world=world),
    )


def build_log_context(
    *,
    character_id: str | None = None,
    world=None,
    sector: int | None = None,
    meta: dict | None = None,
    payload_override: dict | None = None,
    timestamp: datetime | None = None,
    corporation_id: str | None = None,
) -> EventLogContext:
    """Create a reusable EventLogContext with optional sector inference."""

    resolved_sector = sector
    if resolved_sector is None and world and character_id:
        character = getattr(world, "characters", {}).get(character_id)
        if character:
            resolved_sector = getattr(character, "sector", None)

    resolved_corp = corporation_id
    if resolved_corp is None and world and character_id:
        corp_cache = getattr(world, "character_to_corp", None)
        if isinstance(corp_cache, dict):
            resolved_corp = corp_cache.get(character_id)

    return EventLogContext(
        sender=character_id,
        sector=resolved_sector,
        corporation_id=resolved_corp,
        meta=meta,
        payload_override=payload_override,
        timestamp=timestamp,
    )


async def ensure_not_in_combat(world, character_ids: str | Iterable[str]) -> None:
    """Raise if any provided character is currently participating in active combat."""

    manager = getattr(world, "combat_manager", None)
    if manager is None:
        return

    if isinstance(character_ids, str):
        ids_to_check = [character_ids]
    else:
        try:
            ids_to_check = list(character_ids)
        except TypeError as exc:  # pragma: no cover - defensive guard
            raise TypeError("character_ids must be a string or iterable of strings") from exc

    for cid in ids_to_check:
        if not isinstance(cid, str):
            raise TypeError("character_ids iterable must contain string values")
        encounter = await manager.find_encounter_for(cid)
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
    player_type = getattr(character, "player_type", "human")
    payload = {
        "id": character.id,
        "name": getattr(character, "name", character.id),
        "player_type": player_type,
        "credits_in_bank": world.knowledge_manager.get_bank_credits(character_id),
    }
    if player_type != "corporation_ship":
        payload.update(
            {
                "created_at": character.first_visit.isoformat(),
                "last_active": character.last_active.isoformat(),
            }
        )
    return payload


def ship_self(world, character_id: str) -> Dict[str, Any]:
    """Build ship status for player's own ship."""
    ship, _ = _get_character_ship(world, character_id)
    ship_type_value = ship["ship_type"]
    ship_stats = get_ship_stats(ShipType(ship_type_value))
    state = ship.get("state", {})
    display_name = ship.get("name") or ship_stats.name
    cargo = {
        "quantum_foam": int(state.get("cargo", {}).get("quantum_foam", 0)),
        "retro_organics": int(state.get("cargo", {}).get("retro_organics", 0)),
        "neuro_symbolics": int(state.get("cargo", {}).get("neuro_symbolics", 0)),
    }
    cargo_capacity = state.get("cargo_holds", ship_stats.cargo_holds)
    warp_power = state.get("warp_power", ship_stats.warp_power_capacity)
    shields = state.get("shields", ship_stats.shields)
    fighters = state.get("fighters", ship_stats.fighters)

    cargo_used = sum(cargo.values())
    empty_holds = cargo_capacity - cargo_used

    return {
        "ship_id": ship.get("ship_id"),
        "ship_type": ship_type_value,
        "ship_name": display_name,
        "credits": int(state.get("credits", 0)),
        "cargo": cargo,
        "cargo_capacity": cargo_capacity,
        "empty_holds": empty_holds,
        "warp_power": warp_power,
        "warp_power_capacity": ship_stats.warp_power_capacity,
        "shields": shields,
        "max_shields": ship_stats.shields,
        "fighters": fighters,
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
        }
    return port


def apply_port_observation(
    world,
    *,
    observer_id: Optional[str],
    sector_id: int,
    port_data: Optional[Dict[str, Any]],
    in_sector: bool,
    observation_time: Optional[datetime | str] = None,
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Annotate port data for an observer and persist their observation."""

    if not port_data:
        return None, None

    base_port = deepcopy(port_data)
    base_port.pop("observed_at", None)

    if observation_time is None:
        observation_time_dt = datetime.now(timezone.utc)
        observation_time = observation_time_dt.isoformat()
    elif isinstance(observation_time, datetime):
        observation_time = observation_time.isoformat()

    event_port = deepcopy(base_port)
    event_port["observed_at"] = None if in_sector else observation_time

    if observer_id and hasattr(world.knowledge_manager, "update_port_observation"):
        knowledge_port = deepcopy(base_port)
        knowledge_port["observed_at"] = observation_time
        world.knowledge_manager.update_port_observation(
            observer_id, sector_id, knowledge_port
        )

    return event_port, observation_time


async def sector_contents(
    world, sector_id: int, current_character_id: Optional[str] = None
) -> Dict[str, Any]:
    """Compute contents of a sector visible to a character."""

    # adjacent_sectors
    adjacent_sectors = sorted(world.universe_graph.adjacency[sector_id])

    # Port (minimal snapshot) -- todo: write tests and refactor this. there's much more logic here than there needs to be
    port_base = port_snapshot(world, sector_id)
    port = None
    if port_base:
        if current_character_id and current_character_id in world.characters:
            character = world.characters[current_character_id]
            in_sector = character.sector == sector_id and not character.in_hyperspace
            port, _ = apply_port_observation(
                world,
                observer_id=current_character_id,
                sector_id=sector_id,
                port_data=port_base,
                in_sector=in_sector,
            )
        else:
            port = deepcopy(port_base)
            port["observed_at"] = None

    # Other players (names + ship type when known)
    players = []
    for char_id, character in world.characters.items():
        if character.sector != sector_id or char_id == current_character_id:
            continue
        if character.in_hyperspace:  # Skip characters in transit
            continue
        # Build public player data (no private stats)
        player = build_public_player_data(world, char_id)
        players.append(player)

    # Garrisons
    garrison = await serialize_sector_garrison(
        world, sector_id, current_character_id=current_character_id
    )

    # Salvage containers
    salvage = []
    if getattr(world, "salvage_manager", None):
        for container in world.salvage_manager.list_sector(sector_id):
            salvage.append(container.to_dict())

    # Unowned ships in sector
    unowned_ships: List[Dict[str, Any]] = []
    ships_manager = getattr(world, "ships_manager", None)
    if ships_manager is not None:
        for ship in ships_manager.list_unowned_ships_in_sector(sector_id):
            unowned_ships.append(
                {
                    "ship_id": ship.get("ship_id"),
                    "ship_type": ship.get("ship_type"),
                    "name": ship.get("name"),
                    "became_unowned": ship.get("became_unowned"),
                    "former_owner_name": ship.get("former_owner_name"),
                }
            )

    # Scene config
    # @TODO: we should be storing / retrieving this from the game world
    return {
        "id": sector_id,
        "adjacent_sectors": adjacent_sectors,
        "port": port,
        "players": players,
        "garrison": garrison,
        "salvage": salvage,
        "unowned_ships": unowned_ships,
        "scene_config": generate_scene_variant(sector_id),
    }


async def build_status_payload(
    world,
    character_id: str,
) -> Dict[str, Any]:
    """Assemble the canonical status payload for a character."""
    character = world.characters[character_id]
    knowledge = world.knowledge_manager.load_knowledge(character_id)

    corp_payload = None
    corp_membership = getattr(knowledge, "corporation", None)
    corp_id = None
    if isinstance(corp_membership, dict):
        corp_id = corp_membership.get("corp_id")
    if corp_id:
        corp_manager = getattr(world, "corporation_manager", None)
        if corp_manager is not None:
            try:
                corp = corp_manager.load(corp_id)
            except FileNotFoundError:
                corp = None
            if corp:
                corp_payload = {
                    "corp_id": corp_id,
                    "name": corp.get("name"),
                }
                player_type = getattr(character, "player_type", "human")
                if player_type != "corporation_ship":
                    corp_payload.update(
                        {
                            "member_count": len(corp.get("members", []) or []),
                            "joined_at": corp_membership.get("joined_at"),
                        }
                    )
        else:
            # Even if the corporation manager cannot load the corp (e.g., data
            # mutation in progress), surface the identifier so clients can fall
            # back to corp-level queries.
            corp_payload = {"corp_id": corp_id}

    return {
        "player": player_self(world, character_id),
        "ship": ship_self(world, character_id),
        "sector": await sector_contents(world, character.sector, character_id),
        "corporation": corp_payload,
    }


def resolve_character_name(world, character_id: str) -> str:
    character = world.characters.get(character_id)
    if character:
        name = getattr(character, "name", None)
        if isinstance(name, str) and name.strip():
            return name
    registry = getattr(world, "character_registry", None)
    if registry:
        profile = registry.get_profile(character_id)
        if profile:
            return profile.name
    return character_id


def _normalize_corp_member_ids(corp: dict) -> List[str]:
    return [
        member for member in corp.get("members", []) if isinstance(member, str) and member
    ]


def _build_corp_ship_summaries(world, corp: dict) -> List[Dict[str, Any]]:
    ships_manager = getattr(world, "ships_manager", None)
    if ships_manager is None:
        return []

    summaries: List[Dict[str, Any]] = []
    for ship_id in corp.get("ships", []) or []:
        if not isinstance(ship_id, str) or not ship_id:
            continue
        ship = ships_manager.get_ship(ship_id)
        if not ship:
            continue

        # Get ship stats for defaults
        ship_type_value = ship.get("ship_type")
        try:
            ship_stats = get_ship_stats(ShipType(ship_type_value))
        except (ValueError, KeyError):
            ship_stats = None

        # Extract state
        state = ship.get("state", {})
        cargo = state.get("cargo", {})

        control_ready = False
        knowledge_manager = getattr(world, "knowledge_manager", None)
        if knowledge_manager is not None:
            try:
                control_ready = knowledge_manager.has_knowledge(ship_id)
            except Exception:  # noqa: BLE001
                control_ready = False

        summary = {
            "ship_id": ship_id,
            "ship_type": ship_type_value,
            "name": ship.get("name") or (ship_stats.name if ship_stats else ship_type_value),
            "sector": ship.get("sector"),
            "owner_type": ship.get("owner_type"),
            "control_ready": control_ready,
        }

        # Add detailed stats if available
        if ship_stats:
            summary.update({
                "cargo": {
                    "quantum_foam": int(cargo.get("quantum_foam", 0)),
                    "retro_organics": int(cargo.get("retro_organics", 0)),
                    "neuro_symbolics": int(cargo.get("neuro_symbolics", 0)),
                },
                "cargo_capacity": state.get("cargo_holds", ship_stats.cargo_holds),
                "warp_power": state.get("warp_power", ship_stats.warp_power_capacity),
                "warp_power_capacity": ship_stats.warp_power_capacity,
                "shields": state.get("shields", ship_stats.shields),
                "max_shields": ship_stats.shields,
                "fighters": state.get("fighters", ship_stats.fighters),
                "max_fighters": ship_stats.fighters,
            })

        summaries.append(summary)
    return summaries


def build_corporation_public_payload(world, corp: dict) -> Dict[str, Any]:
    member_ids = _normalize_corp_member_ids(corp)
    return {
        "corp_id": corp.get("corp_id"),
        "name": corp.get("name"),
        "founded": corp.get("founded"),
        "member_count": len(member_ids),
    }


def build_corporation_member_payload(world, corp: dict) -> Dict[str, Any]:
    payload = build_corporation_public_payload(world, corp)
    member_ids = _normalize_corp_member_ids(corp)
    payload.update(
        {
            "founder_id": corp.get("founder_id"),
            "invite_code": corp.get("invite_code"),
            "invite_code_generated": corp.get("invite_code_generated"),
            "invite_code_generated_by": corp.get("invite_code_generated_by"),
            "members": [
                {
                    "character_id": member_id,
                    "name": resolve_character_name(world, member_id),
                }
                for member_id in member_ids
            ],
            "ships": _build_corp_ship_summaries(world, corp),
        }
    )
    return payload


def is_corporation_member(corp: dict, character_id: str | None) -> bool:
    if not character_id:
        return False
    return character_id in _normalize_corp_member_ids(corp)


def resolve_sector_character_id(
    world,
    *,
    source_character_id: str,
    to_character_id: str | None = None,
    to_player_name: str | None = None,
    endpoint: str,
) -> str:
    """Resolve a sector-local character either by ID or by display name."""

    if to_character_id:
        if to_character_id not in world.characters:
            raise HTTPException(
                status_code=404,
                detail=f"Target character not found: {to_character_id}",
            )
        return to_character_id

    if not to_player_name:
        raise HTTPException(
            status_code=400,
            detail=f"{endpoint} requires either to_player_name or to_character_id",
        )

    source_character = world.characters.get(source_character_id)
    if not source_character:
        raise HTTPException(status_code=404, detail="Source character not found")

    needle = to_player_name.strip().casefold()
    matches: list[str] = []
    for candidate_id, character in world.characters.items():
        if candidate_id == source_character_id:
            continue
        if character.sector != source_character.sector or character.in_hyperspace:
            continue
        display_name = resolve_character_name(world, candidate_id)
        if display_name.strip().casefold() == needle:
            matches.append(candidate_id)

    if not matches:
        raise HTTPException(
            status_code=404,
            detail=f"No player named '{to_player_name}' in your sector",
        )
    if len(matches) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Multiple players named '{to_player_name}' present; specify by ID",
        )

    return matches[0]


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
        corp_cache = getattr(world, "character_to_corp", None)
        owner_corp_id = None
        viewer_corp_id = None
        if isinstance(corp_cache, dict):
            owner_corp_id = corp_cache.get(garrison_state.owner_id)
            viewer_corp_id = corp_cache.get(current_character_id)
        is_owner = garrison_state.owner_id == current_character_id
        is_corp_ally = bool(viewer_corp_id and viewer_corp_id == owner_corp_id)
        payload["is_friendly"] = bool(is_owner or is_corp_ally)
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
