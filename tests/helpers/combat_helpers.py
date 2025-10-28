"""Test utilities for combat scenarios.

Provides helpers to manipulate fighter counts, create test characters,
and set up specific combat scenarios with predictable outcomes.
"""

import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, Dict, Any


# Use test-world-data directory for test scenarios
TEST_WORLD_DATA_DIR = Path(__file__).parent.parent / "test-world-data"
KNOWLEDGE_DIR = TEST_WORLD_DATA_DIR / "character-map-knowledge"
UNIVERSE_FILE = TEST_WORLD_DATA_DIR / "universe_structure.json"
SECTOR_CONTENTS_FILE = TEST_WORLD_DATA_DIR / "sector_contents.json"

# Load universe data for adjacent sectors
_universe_data = None
_sector_contents_data = None


def _get_adjacent_sectors(sector_id: int) -> list[int]:
    """Get adjacent sectors for a given sector from universe data."""
    global _universe_data
    if _universe_data is None:
        with open(UNIVERSE_FILE, "r") as f:
            _universe_data = json.load(f)

    sector = next((s for s in _universe_data["sectors"] if s["id"] == sector_id), None)
    if sector:
        return [w["to"] for w in sector.get("warps", [])]
    return []


def _get_sector_details(sector_id: int) -> Dict[str, Any]:
    """Get sector details including port information from sector_contents.json.

    Args:
        sector_id: Sector ID to query

    Returns:
        Dict with sector details including port info (if present)
    """
    global _sector_contents_data
    if _sector_contents_data is None:
        with open(SECTOR_CONTENTS_FILE, "r") as f:
            _sector_contents_data = json.load(f)

    sector = next(
        (s for s in _sector_contents_data["sectors"] if s["id"] == sector_id),
        None
    )

    if not sector:
        return {"port": None, "planets": []}

    # Build port info if present
    port_info = None
    if sector.get("port"):
        port_data = sector["port"]
        port_info = {
            "class": port_data["class"],
            "code": port_data["code"],
            "buys": port_data["buys"],
            "sells": port_data["sells"],
        }

    return {
        "port": port_info,
        "planets": sector.get("planets", []),
    }


def create_test_character_knowledge(
    character_id: str,
    *,
    fighters: int = 300,
    max_fighters: int = 300,
    shields: int = 150,
    max_shields: int = 150,
    warp_power: int = 300,
    credits: int = 1000,
    credits_in_bank: int = 0,
    ship_type: str = "kestrel_courier",
    ship_name: Optional[str] = None,
    sector: int = 0,
    visited_sectors: Optional[list[int]] = None,
    cargo: Optional[Dict[str, int]] = None,
) -> Path:
    """Create a character knowledge file with specific stats.

    This allows setting exact fighter/shield counts for predictable combat tests.
    Optionally pre-populate map knowledge with visited sectors (including ports).

    Args:
        character_id: Unique character ID
        fighters: Current fighter count
        max_fighters: Maximum fighters (ship capacity)
        shields: Current shield strength
        max_shields: Maximum shields (ship capacity)
        warp_power: Current warp power
        credits: Starting credits (on hand)
        credits_in_bank: Bank balance (default: 0)
        ship_type: Ship type (e.g., "kestrel_courier")
        ship_name: Custom ship name (optional)
        sector: Starting sector
        visited_sectors: List of sector IDs to mark as visited (includes ports).
                        If None, only the starting sector is included.
        cargo: Cargo dict (default: empty)

    Returns:
        Path to created knowledge file
    """
    if cargo is None:
        cargo = {"quantum_foam": 0, "retro_organics": 0, "neuro_symbolics": 0}

    now = datetime.now(timezone.utc).isoformat()

    # Determine which sectors to include in knowledge
    if visited_sectors is None:
        sectors_to_visit = [sector]
    else:
        # Ensure starting sector is included
        sectors_to_visit = list(set(visited_sectors) | {sector})

    # Build sectors_visited dict for all sectors
    sectors_visited_dict = {}
    for sector_id in sectors_to_visit:
        adjacent_sectors = _get_adjacent_sectors(sector_id)
        sector_details = _get_sector_details(sector_id)

        sectors_visited_dict[str(sector_id)] = {
            "sector_id": sector_id,
            "last_visited": now,
            "port": sector_details["port"],
            "position": [0, 0],  # Placeholder position
            "planets": sector_details["planets"],
            "adjacent_sectors": adjacent_sectors,
        }

    knowledge = {
        "character_id": character_id,
        "sectors_visited": sectors_visited_dict,
        "total_sectors_visited": len(sectors_visited_dict),
        "first_visit": now,
        "last_update": now,
        "ship_config": {
            "ship_type": ship_type,
            "cargo": cargo,
            "current_warp_power": warp_power,
            "current_shields": shields,
            "current_fighters": fighters,
            "equipped_modules": [],
        },
        "credits": credits,
        "credits_in_bank": credits_in_bank,
        "current_sector": sector,
    }

    # Add ship_name if provided
    if ship_name:
        knowledge["ship_config"]["ship_name"] = ship_name

    # Ensure directory exists
    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)

    # Write knowledge file
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"
    with open(filepath, "w") as f:
        json.dump(knowledge, f, indent=2)

    return filepath


def modify_character_fighters(
    character_id: str,
    fighters: int,
    shields: Optional[int] = None,
) -> None:
    """Modify an existing character's fighter and shield counts.

    Args:
        character_id: Character ID to modify
        fighters: New fighter count
        shields: New shield count (optional, keep current if not provided)

    Raises:
        FileNotFoundError: If character knowledge file doesn't exist
    """
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"

    if not filepath.exists():
        raise FileNotFoundError(f"Character knowledge not found: {character_id}")

    with open(filepath, "r") as f:
        knowledge = json.load(f)

    knowledge["ship_config"]["current_fighters"] = fighters
    if shields is not None:
        knowledge["ship_config"]["current_shields"] = shields

    knowledge["last_update"] = datetime.now(timezone.utc).isoformat()

    with open(filepath, "w") as f:
        json.dump(knowledge, f, indent=2)


def delete_test_character(character_id: str) -> bool:
    """Delete a test character's knowledge file.

    Args:
        character_id: Character ID to delete

    Returns:
        True if file was deleted, False if it didn't exist
    """
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"

    if filepath.exists():
        filepath.unlink()
        return True
    return False


def cleanup_test_characters(prefix: str = "test_") -> int:
    """Delete all test character knowledge files matching a prefix.

    Args:
        prefix: Prefix to match (default: "test_")

    Returns:
        Number of files deleted
    """
    if not KNOWLEDGE_DIR.exists():
        return 0

    count = 0
    for filepath in KNOWLEDGE_DIR.glob(f"{prefix}*.json"):
        filepath.unlink()
        count += 1

    return count


def create_weak_character(
    character_id: str,
    sector: int = 0,
    fighters: int = 5,
) -> Path:
    """Create a character with very low fighters (will be destroyed quickly).

    Args:
        character_id: Character ID
        sector: Starting sector
        fighters: Fighter count (default: 5, enough for 1-2 rounds)

    Returns:
        Path to created knowledge file
    """
    return create_test_character_knowledge(
        character_id,
        fighters=fighters,
        max_fighters=300,
        shields=10,
        max_shields=150,
        sector=sector,
    )


def create_strong_character(
    character_id: str,
    sector: int = 0,
    fighters: int = 500,
) -> Path:
    """Create a character with high fighters (will dominate combat).

    Args:
        character_id: Character ID
        sector: Starting sector
        fighters: Fighter count (default: 500)

    Returns:
        Path to created knowledge file
    """
    return create_test_character_knowledge(
        character_id,
        fighters=fighters,
        max_fighters=500,
        shields=200,
        max_shields=200,
        ship_type="atlas_hauler",  # Stronger ship with more capacity
        sector=sector,
    )


def create_balanced_character(
    character_id: str,
    sector: int = 0,
) -> Path:
    """Create a character with standard stats.

    Args:
        character_id: Character ID
        sector: Starting sector

    Returns:
        Path to created knowledge file
    """
    return create_test_character_knowledge(
        character_id,
        fighters=300,
        max_fighters=300,
        shields=150,
        max_shields=150,
        sector=sector,
    )


def set_character_cargo(
    character_id: str,
    quantum_foam: int = 0,
    retro_organics: int = 0,
    neuro_symbolics: int = 0,
) -> None:
    """Set a character's cargo for salvage testing.

    Args:
        character_id: Character ID to modify
        quantum_foam: Quantum Foam quantity
        retro_organics: Retro-organics quantity
        neuro_symbolics: Neuro-symbolics quantity
    """
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"

    if not filepath.exists():
        raise FileNotFoundError(f"Character knowledge not found: {character_id}")

    with open(filepath, "r") as f:
        knowledge = json.load(f)

    knowledge["ship_config"]["cargo"] = {
        "quantum_foam": quantum_foam,
        "retro_organics": retro_organics,
        "neuro_symbolics": neuro_symbolics,
    }

    knowledge["last_update"] = datetime.now(timezone.utc).isoformat()

    with open(filepath, "w") as f:
        json.dump(knowledge, f, indent=2)


# Garrison helper functions for auto-combat tests


async def deploy_garrison(
    client,
    owner_id: str,
    sector: int,
    fighters: int,
    mode: str = "offensive",
    toll_amount: int = 0
) -> None:
    """Deploy a garrison in a sector.

    Args:
        client: AsyncGameClient instance
        owner_id: Character ID of garrison owner
        sector: Sector ID where garrison will be deployed
        fighters: Number of fighters to deploy
        mode: Garrison mode (offensive, defensive, toll)
        toll_amount: Toll amount if mode is toll
    """
    params = {
        "character_id": owner_id,
        "sector": sector,
        "quantity": fighters,
        "mode": mode,
    }

    if mode == "toll" and toll_amount > 0:
        params["toll_amount"] = toll_amount

    await client.combat_leave_fighters(**params)


async def verify_garrison_combat(
    events: list,
    expected_garrison_owner: str,
    expected_arrival_char: str
) -> dict:
    """Verify combat.round_waiting event contains garrison.

    Args:
        events: List of event dicts with "event" and "payload" keys
        expected_garrison_owner: Expected garrison owner character ID
        expected_arrival_char: Expected arriving character ID

    Returns:
        The unwrapped payload if found

    Raises:
        AssertionError: If validation fails
    """
    assert len(events) >= 1, "Should have combat.round_waiting event"

    waiting_event = events[0]["payload"]
    inner = waiting_event.get("payload", waiting_event)

    # Verify garrison (top-level field, not in participants)
    garrison = inner.get("garrison")
    assert garrison is not None, "Garrison should be present in combat"
    assert garrison.get("owner_name") == expected_garrison_owner, \
        f"Expected garrison owner {expected_garrison_owner}, got {garrison.get('owner_name')}"

    # Verify participants includes arriving character
    participants = inner.get("participants", [])
    assert len(participants) >= 1, "Should have at least the arriving character"

    # Find arriving character
    character = next((p for p in participants if p.get("name") == expected_arrival_char), None)
    assert character is not None, f"Arriving character {expected_arrival_char} should be participant"

    return inner
