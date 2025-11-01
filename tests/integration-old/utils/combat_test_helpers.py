"""Test utilities for combat scenarios in integration-old suite."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any

from ships import ShipType, get_ship_stats

WORLD_DATA_DIR = Path(__file__).parent.parent.parent / "world-data"
KNOWLEDGE_DIR = WORLD_DATA_DIR / "character-map-knowledge"
SHIPS_FILE = WORLD_DATA_DIR / "ships.json"
UNIVERSE_FILE = WORLD_DATA_DIR / "universe_structure.json"

_universe_data = None


def _load_universe() -> dict:
    global _universe_data
    if _universe_data is None:
        with open(UNIVERSE_FILE, "r", encoding="utf-8") as handle:
            _universe_data = json.load(handle)
    return _universe_data


def _adjacent_sectors(sector_id: int) -> list[int]:
    universe = _load_universe()
    sector = next((s for s in universe["sectors"] if s["id"] == sector_id), None)
    if sector:
        return [w["to"] for w in sector.get("warps", [])]
    return []


def _load_ships() -> Dict[str, dict]:
    if SHIPS_FILE.exists():
        with open(SHIPS_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return {}


def _save_ships(ships: Dict[str, dict]) -> None:
    SHIPS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SHIPS_FILE, "w", encoding="utf-8") as handle:
        json.dump(ships, handle, indent=2)


def _ship_id(character_id: str) -> str:
    return f"{character_id}-ship"


def _ensure_ship(
    character_id: str,
    *,
    ship_type: str,
    sector: int,
    fighters: Optional[int] = None,
    shields: Optional[int] = None,
    warp_power: Optional[int] = None,
    cargo: Optional[Dict[str, int]] = None,
    ship_name: Optional[str] = None,
) -> str:
    ships = _load_ships()
    ship_id = _ship_id(character_id)
    ship_type_enum = ShipType(ship_type)
    stats = get_ship_stats(ship_type_enum)

    record = ships.get(ship_id)
    if record is None:
        record = {
            "ship_id": ship_id,
            "ship_type": ship_type_enum.value,
            "name": ship_name,
            "sector": sector,
            "owner_type": "character",
            "owner_id": character_id,
            "acquired": datetime.now(timezone.utc).isoformat(),
            "state": {
                "fighters": stats.fighters,
                "shields": stats.shields,
                "cargo": {
                    "quantum_foam": 0,
                    "retro_organics": 0,
                    "neuro_symbolics": 0,
                },
                "cargo_holds": stats.cargo_holds,
                "warp_power": stats.warp_power_capacity,
                "warp_power_capacity": stats.warp_power_capacity,
                "modules": [],
            },
            "became_unowned": None,
            "former_owner_name": None,
        }
    else:
        record = json.loads(json.dumps(record))
        record["ship_type"] = ship_type_enum.value
        record["owner_type"] = "character"
        record["owner_id"] = character_id
        record["sector"] = sector
        if ship_name is not None:
            record["name"] = ship_name

    state = record.setdefault("state", {})
    state.setdefault("cargo", {})
    state.setdefault("modules", [])
    state.setdefault("cargo_holds", stats.cargo_holds)
    state.setdefault("warp_power_capacity", stats.warp_power_capacity)

    if fighters is not None:
        state["fighters"] = int(fighters)
    else:
        state.setdefault("fighters", stats.fighters)

    if shields is not None:
        state["shields"] = int(shields)
    else:
        state.setdefault("shields", stats.shields)

    if warp_power is not None:
        state["warp_power"] = int(warp_power)
    else:
        state.setdefault("warp_power", stats.warp_power_capacity)

    base_cargo = {
        "quantum_foam": 0,
        "retro_organics": 0,
        "neuro_symbolics": 0,
    }
    if cargo:
        for key, value in cargo.items():
            base_cargo[key] = int(value)
    for key in base_cargo:
        state.setdefault("cargo", {})
        state["cargo"][key] = base_cargo[key]

    ships[ship_id] = record
    _save_ships(ships)
    return ship_id


def create_test_character_knowledge(
    character_id: str,
    *,
    fighters: int = 300,
    max_fighters: int = 300,  # legacy compatibility
    shields: int = 150,
    max_shields: int = 150,
    warp_power: int = 300,
    credits: int = 1000,
    ship_type: str = "kestrel_courier",
    ship_name: Optional[str] = None,
    sector: int = 0,
    cargo: Optional[Dict[str, int]] = None,
) -> Path:
    if cargo is None:
        cargo = {
            "quantum_foam": 0,
            "retro_organics": 0,
            "neuro_symbolics": 0,
        }

    now = datetime.now(timezone.utc).isoformat()

    ship_id = _ensure_ship(
        character_id,
        ship_type=ship_type,
        sector=sector,
        fighters=fighters,
        shields=shields,
        warp_power=warp_power,
        cargo=cargo,
        ship_name=ship_name,
    )

    knowledge = {
        "character_id": character_id,
        "sectors_visited": {
            str(sector): {
                "sector_id": sector,
                "last_visited": now,
                "port": None,
                "position": [0, 0],
                "planets": [],
                "adjacent_sectors": _adjacent_sectors(sector),
            }
        },
        "total_sectors_visited": 1,
        "first_visit": now,
        "last_update": now,
        "current_ship_id": ship_id,
        "credits": credits,
        "credits_in_bank": 0,
        "current_sector": sector,
    }

    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"
    with open(filepath, "w", encoding="utf-8") as handle:
        json.dump(knowledge, handle, indent=2)

    return filepath


def modify_character_fighters(
    character_id: str,
    fighters: int,
    shields: Optional[int] = None,
) -> None:
    ships = _load_ships()
    ship_id = _ship_id(character_id)
    if ship_id not in ships:
        raise FileNotFoundError(f"Ship not found for character: {character_id}")
    record = ships[ship_id]
    record.setdefault("state", {})
    record["state"]["fighters"] = int(fighters)
    if shields is not None:
        record["state"]["shields"] = int(shields)
    ships[ship_id] = record
    _save_ships(ships)

    filepath = KNOWLEDGE_DIR / f"{character_id}.json"
    if filepath.exists():
        data = json.loads(filepath.read_text())
        data["last_update"] = datetime.now(timezone.utc).isoformat()
        filepath.write_text(json.dumps(data, indent=2))


def delete_test_character(character_id: str) -> bool:
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"
    ship_id = _ship_id(character_id)
    ships = _load_ships()

    deleted = False
    if filepath.exists():
        filepath.unlink()
        deleted = True
    if ship_id in ships:
        ships.pop(ship_id)
        _save_ships(ships)
    return deleted


def cleanup_test_characters(prefix: str = "test_") -> int:
    if not KNOWLEDGE_DIR.exists():
        return 0

    count = 0
    ships = _load_ships()
    for filepath in KNOWLEDGE_DIR.glob(f"{prefix}*.json"):
        character_id = filepath.stem
        filepath.unlink()
        count += 1
        ships.pop(_ship_id(character_id), None)
    _save_ships(ships)
    return count
