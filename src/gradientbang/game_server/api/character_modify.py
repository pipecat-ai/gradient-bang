"""Admin endpoint for modifying existing characters."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import HTTPException

from gradientbang.game_server.core.character_registry import CharacterProfile
from gradientbang.game_server.core.name_validation import ensure_safe_character_name
from gradientbang.game_server.ships import validate_ship_type, ShipType
from gradientbang.game_server.api.character_create import (
    sanitize_player_payload,
    sanitize_ship_payload,
    apply_player_overrides,
    apply_ship_overrides,
)
from gradientbang.game_server.api.utils import rpc_success


async def handle(payload: Dict[str, Any], world) -> dict:
    registry = getattr(world, "character_registry", None)
    if registry is None:
        raise HTTPException(status_code=500, detail="Character registry unavailable")

    admin_password = payload.get("admin_password")
    if not registry.validate_admin_password(admin_password):
        raise HTTPException(status_code=403, detail="Invalid admin password")

    character_id = payload.get("character_id")
    if not isinstance(character_id, str) or not character_id.strip():
        raise HTTPException(status_code=400, detail="character_id is required")

    profile = registry.get_profile(character_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Character not found")

    new_name = profile.name
    raw_name = payload.get("name")
    if raw_name is not None:
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise HTTPException(status_code=400, detail="name must be a non-empty string")
        candidate = ensure_safe_character_name(raw_name.strip())
        existing = registry.find_by_name(candidate)
        if existing and existing.character_id != character_id:
            raise HTTPException(status_code=409, detail="Character name already exists")
        new_name = candidate

    player_data = sanitize_player_payload(payload.get("player"))
    ship_data = sanitize_ship_payload(payload.get("ship"))

    ship_type_value = ship_data.get("ship_type")
    if ship_type_value:
        validated_ship_type = validate_ship_type(ship_type_value)
        if validated_ship_type is None:
            raise HTTPException(status_code=400, detail=f"Invalid ship type: {ship_type_value}")
        sector_hint = world.characters.get(character_id).sector if character_id in world.characters else world.knowledge_manager.get_current_sector(character_id) or 0
        display_name = new_name or character_id
        world.knowledge_manager.create_ship_for_character(
            character_id,
            validated_ship_type,
            sector=sector_hint,
            name=ship_data.get("ship_name"),
            fighters=ship_data.get("current_fighters"),
            shields=ship_data.get("current_shields"),
            warp_power=ship_data.get("current_warp_power"),
            cargo=ship_data.get("cargo"),
            abandon_existing=True,
            former_owner_name=display_name,
        )

    apply_player_overrides(world, character_id, player_data)
    apply_ship_overrides(world, character_id, ship_data)

    character = world.characters.get(character_id)
    if character:
        character.name = new_name

    combined_player = dict(profile.player)
    combined_player.update(player_data)
    combined_ship = dict(profile.ship)
    combined_ship.update(ship_data)
    if ship_type_value:
        combined_ship["ship_type"] = ship_type_value

    registry.add_or_update(
        CharacterProfile(
            character_id=character_id,
            name=new_name,
            player=combined_player,
            ship=combined_ship,
            created_at=profile.created_at,
        )
    )

    return rpc_success(
        {
            "character_id": character_id,
            "name": new_name,
            "player": combined_player,
            "ship": combined_ship,
        }
    )
