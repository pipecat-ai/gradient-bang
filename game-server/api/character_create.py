"""Admin endpoint for creating characters with UUID identities."""

from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import HTTPException

from core.character_registry import CharacterProfile
from core.name_validation import ensure_safe_character_name
from ships import ShipType, validate_ship_type
from .utils import rpc_success


ALLOWED_PLAYER_FIELDS = {"credits", "player_type"}
ALLOWED_SHIP_FIELDS = {
    "ship_type",
    "ship_name",
    "cargo",
    "current_warp_power",
    "current_shields",
    "current_fighters",
}


def sanitize_player_payload(payload: Any) -> dict[str, Any]:
    if not payload:
        return {}
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="player must be an object")
    sanitized: dict[str, Any] = {}
    for key, value in payload.items():
        if key not in ALLOWED_PLAYER_FIELDS:
            raise HTTPException(status_code=400, detail=f"Unsupported player field: {key}")
        if key == "credits":
            try:
                sanitized[key] = int(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="credits must be an integer")
        else:
            sanitized[key] = value
    return sanitized


def sanitize_ship_payload(payload: Any) -> dict[str, Any]:
    if not payload:
        return {}
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="ship must be an object")
    sanitized: dict[str, Any] = {}
    for key, value in payload.items():
        if key not in ALLOWED_SHIP_FIELDS:
            raise HTTPException(status_code=400, detail=f"Unsupported ship field: {key}")
        if key in {"current_warp_power", "current_shields", "current_fighters"}:
            try:
                sanitized[key] = int(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key} must be an integer")
        elif key == "cargo":
            if not isinstance(value, dict):
                raise HTTPException(status_code=400, detail="cargo must be an object")
            sanitized[key] = {k: int(v) for k, v in value.items()}
        elif key == "ship_type":
            if not isinstance(value, str) or not value.strip():
                raise HTTPException(status_code=400, detail="ship_type must be a string")
            sanitized[key] = value.strip().lower()
        else:
            sanitized[key] = value
    return sanitized


def apply_player_overrides(world, character_id: str, player_data: dict[str, Any]) -> None:
    if "credits" in player_data:
        world.knowledge_manager.update_credits(character_id, player_data["credits"])
    character = world.characters.get(character_id)
    if character and "player_type" in player_data:
        character.player_type = player_data["player_type"]


def apply_ship_overrides(world, character_id: str, ship_data: dict[str, Any]) -> None:
    if not ship_data:
        return
    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship_config = knowledge.ship_config
    if "ship_name" in ship_data:
        ship_config.ship_name = ship_data["ship_name"]
    if "cargo" in ship_data:
        ship_config.cargo.update(ship_data["cargo"])
    if "current_warp_power" in ship_data:
        ship_config.current_warp_power = ship_data["current_warp_power"]
    if "current_shields" in ship_data:
        ship_config.current_shields = ship_data["current_shields"]
    if "current_fighters" in ship_data:
        ship_config.current_fighters = ship_data["current_fighters"]
    world.knowledge_manager.save_knowledge(knowledge)


async def handle(payload: Dict[str, Any], world) -> dict:
    registry = getattr(world, "character_registry", None)
    if registry is None:
        raise HTTPException(status_code=500, detail="Character registry unavailable")

    admin_password = payload.get("admin_password")
    if not registry.validate_admin_password(admin_password):
        raise HTTPException(status_code=403, detail="Invalid admin password")

    raw_name = payload.get("name")
    if not isinstance(raw_name, str) or not raw_name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    sanitized_name = ensure_safe_character_name(raw_name.strip())
    if registry.name_exists(sanitized_name):
        raise HTTPException(status_code=409, detail="Character name already exists")

    player_data = sanitize_player_payload(payload.get("player"))
    ship_data = sanitize_ship_payload(payload.get("ship"))

    ship_type_value = ship_data.get("ship_type")
    validated_ship_type: ShipType | None = None
    if ship_type_value:
        validated_ship_type = validate_ship_type(ship_type_value)
        if validated_ship_type is None:
            raise HTTPException(status_code=400, detail=f"Invalid ship type: {ship_type_value}")
    else:
        validated_ship_type = ShipType.KESTREL_COURIER

    character_id = str(uuid.uuid4())
    world.knowledge_manager.initialize_ship(character_id, validated_ship_type)
    apply_player_overrides(world, character_id, player_data)
    apply_ship_overrides(world, character_id, ship_data)

    registry.add_or_update(
        CharacterProfile(
            character_id=character_id,
            name=sanitized_name,
            player=player_data,
            ship=ship_data,
        )
    )

    return rpc_success(
        {
            "character_id": character_id,
            "name": sanitized_name,
            "player": player_data,
            "ship": ship_data,
        }
    )
