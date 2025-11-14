"""Helpers for ship credit validation and transfers."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import HTTPException

from .ships_manager import ShipsManager


def resolve_character_id_by_name(world: Any, target_player_name: str) -> str:
    """Resolve a character ID from a display name using world registries."""
    if not target_player_name or not target_player_name.strip():
        raise HTTPException(status_code=400, detail="target_player_name cannot be empty")

    needle = target_player_name.strip().casefold()
    matches: set[str] = set()

    characters: Dict[str, Any] = getattr(world, "characters", {}) or {}
    for character_id, character in characters.items():
        display_name = getattr(character, "name", "") or ""
        if display_name.strip().casefold() == needle:
            matches.add(character_id)

    registry = getattr(world, "character_registry", None)
    if registry is not None:
        profile = registry.find_by_name(target_player_name.strip())
        if profile is not None:
            matches.add(profile.character_id)

    if not matches:
        raise HTTPException(
            status_code=404,
            detail=f"No player named '{target_player_name}' found",
        )
    if len(matches) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Multiple players named '{target_player_name}' found; use character_id instead",
        )
    return next(iter(matches))


def get_ship_credit_info(ships_manager: ShipsManager, ship_id: str) -> dict:
    """Return the current credit balance for a ship."""
    ship = ships_manager.get_ship(ship_id)
    if ship is None:
        raise KeyError(f"Ship not found: {ship_id}")
    credits = int(ship.get("state", {}).get("credits", 0))
    return {"credits": credits}


def transfer_credits_between_ships(
    ships_manager: ShipsManager,
    from_ship_id: str,
    to_ship_id: str,
    amount: int,
) -> None:
    """Wrapper around ShipsManager.transfer_credits_between_ships with validation."""
    ships_manager.transfer_credits_between_ships(from_ship_id, to_ship_id, amount)


def _resolve_character_corp_id(world: Any, character_id: Optional[str]) -> Optional[str]:
    if not character_id:
        return None

    corp_cache = getattr(world, "character_to_corp", None)
    if isinstance(corp_cache, dict):
        corp_id = corp_cache.get(character_id)
        if corp_id:
            return corp_id

    knowledge_manager = getattr(world, "knowledge_manager", None)
    if knowledge_manager is not None:
        try:
            knowledge = knowledge_manager.load_knowledge(character_id)
        except Exception:  # noqa: BLE001
            return None
        corporation = getattr(knowledge, "corporation", None)
        if isinstance(corporation, dict):
            return corporation.get("corp_id")
    return None


def transfer_credits_to_bank(
    world: Any,
    ships_manager: ShipsManager,
    amount: int,
    *,
    target_player_name: str | None = None,
    target_character_id: str | None = None,
    source_ship_id: str | None = None,
    source_character_id: str | None = None,
) -> dict:
    """Transfer credits from a ship to a character's bank account with corp checks."""
    if amount <= 0:
        raise ValueError("Amount must be a positive integer")

    if target_character_id is None:
        if not target_player_name:
            raise HTTPException(
                status_code=400,
                detail="target_player_name is required when target_character_id is not provided",
            )
        target_character_id = resolve_character_id_by_name(world, target_player_name)

    knowledge_manager = getattr(world, "knowledge_manager", None)
    if knowledge_manager is None:
        raise RuntimeError("World is missing a knowledge manager")

    ship_record: Optional[dict] = None
    if source_ship_id:
        ship_record = ships_manager.get_ship(source_ship_id)
        if ship_record is None:
            raise KeyError(f"Ship not found: {source_ship_id}")
    if source_character_id:
        char_ship = knowledge_manager.get_ship(source_character_id)
        if char_ship is None:
            raise HTTPException(status_code=404, detail="Source character has no active ship")
        character_ship_id = char_ship.get("ship_id")
        if ship_record is None:
            ship_record = char_ship
            source_ship_id = character_ship_id
        elif character_ship_id != ship_record.get("ship_id"):
            raise HTTPException(
                status_code=400,
                detail="Character ship_id mismatch; provide either character_id or ship_id",
            )

    if ship_record is None or not source_ship_id:
        raise HTTPException(
            status_code=400,
            detail="Deposit requires source ship_id or character_id",
        )

    state = ship_record.get("state", {}) or {}
    ship_credits = int(state.get("credits", 0))
    if ship_credits < amount:
        raise ValueError(f"Insufficient credits: have {ship_credits}, need {amount}")

    owner_type = ship_record.get("owner_type")
    owner_id = ship_record.get("owner_id")

    if owner_type == "corporation":
        corporation_manager = getattr(world, "corporation_manager", None)
        if corporation_manager is None or owner_id is None:
            raise HTTPException(
                status_code=403,
                detail="Corporation ship data is missing; cannot perform bank deposit",
            )
        if not corporation_manager.is_member(owner_id, target_character_id):
            raise HTTPException(
                status_code=403,
                detail="Corporation ship may only deposit to members of the same corporation",
            )
    elif owner_type == "character":
        if owner_id is None:
            raise HTTPException(
                status_code=403,
                detail="Personal ship is missing owner information",
            )
        if source_character_id is None:
            source_character_id = owner_id
        if owner_id != source_character_id:
            raise HTTPException(
                status_code=403,
                detail="Character ship may only be controlled by its owner",
            )
        if owner_id == target_character_id:
            allowed = True
        else:
            source_corp = _resolve_character_corp_id(world, owner_id)
            target_corp = _resolve_character_corp_id(world, target_character_id)
            allowed = source_corp is not None and source_corp == target_corp
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail="Personal ships may only deposit to their owner or fellow corporation members",
            )
    else:
        raise HTTPException(
            status_code=403,
            detail="Only character or corporation owned ships may deposit credits",
        )

    new_ship_balance = ship_credits - amount
    if owner_type == "character" and owner_id:
        knowledge_manager.update_ship_credits(owner_id, new_ship_balance)
    else:
        ships_manager.update_ship_state(source_ship_id, credits=new_ship_balance)

    knowledge = knowledge_manager.load_knowledge(target_character_id)
    knowledge.credits_in_bank += amount
    knowledge_manager.save_knowledge(knowledge)

    return {
        "target_character_id": target_character_id,
        "source_character_id": source_character_id if owner_type == "character" else None,
        "source_ship_id": source_ship_id,
        "ship_credits_before": ship_credits,
        "ship_credits_after": new_ship_balance,
        "bank_credits_after": knowledge.credits_in_bank,
    }
