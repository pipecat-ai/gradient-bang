"""Test utilities for combat scenarios.

Provides helpers to manipulate fighter counts, create test characters,
and set up specific combat scenarios with predictable outcomes.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any

from ships import ShipType, get_ship_stats

# Use test-world-data directory for test scenarios
TEST_WORLD_DATA_DIR = Path(__file__).parent.parent / "test-world-data"
KNOWLEDGE_DIR = TEST_WORLD_DATA_DIR / "character-map-knowledge"
SHIPS_FILE = TEST_WORLD_DATA_DIR / "ships.json"
UNIVERSE_FILE = TEST_WORLD_DATA_DIR / "universe_structure.json"
SECTOR_CONTENTS_FILE = TEST_WORLD_DATA_DIR / "sector_contents.json"

# Load universe data for adjacent sectors
_universe_data = None
_sector_contents_data = None


def _load_universe() -> dict:
    global _universe_data
    if _universe_data is None:
        with open(UNIVERSE_FILE, "r", encoding="utf-8") as handle:
            _universe_data = json.load(handle)
    return _universe_data


def _get_adjacent_sectors(sector_id: int) -> list[int]:
    universe = _load_universe()
    sector = next((s for s in universe["sectors"] if s["id"] == sector_id), None)
    if sector:
        return [w["to"] for w in sector.get("warps", [])]
    return []


def _get_sector_details(sector_id: int) -> Dict[str, Any]:
    global _sector_contents_data
    if _sector_contents_data is None:
        with open(SECTOR_CONTENTS_FILE, "r", encoding="utf-8") as handle:
            _sector_contents_data = json.load(handle)

    sector = next((s for s in _sector_contents_data.get("sectors", []) if s["id"] == sector_id), None)
    if not sector:
        return {"port": None, "planets": []}

    port_info = None
    port_data = sector.get("port")
    if port_data:
        port_info = {
            "class": port_data.get("class"),
            "code": port_data.get("code"),
            "buys": port_data.get("buys", []),
            "sells": port_data.get("sells", []),
        }

    return {
        "port": port_info,
        "planets": sector.get("planets", []),
    }


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


def _ensure_ship_record(
    character_id: str,
    *,
    ship_type: str,
    sector: int,
    fighters: Optional[int] = None,
    shields: Optional[int] = None,
    warp_power: Optional[int] = None,
    cargo: Optional[Dict[str, int]] = None,
    ship_name: Optional[str] = None,
    modules: Optional[list[str]] = None,
    credits: Optional[int] = None,
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
        record = json.loads(json.dumps(record))  # deep copy to avoid mutation issues
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
        state["cargo"][key] = int(base_cargo[key])

    if modules is not None:
        state["modules"] = list(modules)

    if credits is not None:
        state["credits"] = max(0, int(credits))
    else:
        state.setdefault("credits", state.get("credits", 0))

    ships[ship_id] = record
    _save_ships(ships)
    return ship_id


def _write_knowledge_file(character_id: str, data: dict) -> Path:
    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"
    with open(filepath, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    return filepath


def _update_last_seen(character_id: str) -> None:
    filepath = KNOWLEDGE_DIR / f"{character_id}.json"
    if filepath.exists():
        data = json.loads(filepath.read_text())
        data["last_update"] = datetime.now(timezone.utc).isoformat()
        filepath.write_text(json.dumps(data, indent=2))


def create_test_character_knowledge(
    character_id: str,
    *,
    fighters: int = 300,
    max_fighters: int = 300,  # kept for API compatibility, ignored in ship data
    shields: int = 150,
    max_shields: int = 150,  # kept for API compatibility, ignored
    warp_power: int = 300,
    credits: int = 1000,
    credits_in_bank: int = 0,
    ship_type: str = "kestrel_courier",
    ship_name: Optional[str] = None,
    sector: int = 0,
    visited_sectors: Optional[list[int]] = None,
    cargo: Optional[Dict[str, int]] = None,
    modules: Optional[list[str]] = None,
) -> Path:
    if cargo is None:
        cargo = {
            "quantum_foam": 0,
            "retro_organics": 0,
            "neuro_symbolics": 0,
        }

    now = datetime.now(timezone.utc).isoformat()

    if visited_sectors is None:
        sectors_to_visit = [sector]
    else:
        sectors_to_visit = sorted(set(visited_sectors) | {sector})

    sectors_visited_dict: Dict[str, Any] = {}
    for sector_id in sectors_to_visit:
        sector_details = _get_sector_details(sector_id)
        sectors_visited_dict[str(sector_id)] = {
            "sector_id": sector_id,
            "last_visited": now,
            "port": sector_details["port"],
            "position": [0, 0],
            "planets": sector_details["planets"],
            "adjacent_sectors": _get_adjacent_sectors(sector_id),
        }

    ship_id = _ensure_ship_record(
        character_id,
        ship_type=ship_type,
        sector=sector,
        fighters=fighters,
        shields=shields,
        warp_power=warp_power,
        cargo=cargo,
        ship_name=ship_name,
        modules=modules,
        credits=credits,
    )

    knowledge = {
        "character_id": character_id,
        "sectors_visited": sectors_visited_dict,
        "total_sectors_visited": len(sectors_visited_dict),
        "first_visit": now,
        "last_update": now,
        "current_ship_id": ship_id,
        "credits": credits,
        "credits_in_bank": credits_in_bank,
        "current_sector": sector,
    }

    knowledge_path = _write_knowledge_file(character_id, knowledge)

    if os.environ.get("USE_SUPABASE_TESTS", "").strip().lower() in {"1", "true", "on", "yes"}:
        try:
            from tests.edge.support.state import reset_character_state as supabase_reset_character_state  # type: ignore
        except Exception:  # noqa: BLE001
            pass
        else:
            ship_updates = {
                'cargo_qf': cargo.get('quantum_foam', 0),
                'cargo_ro': cargo.get('retro_organics', 0),
                'cargo_ns': cargo.get('neuro_symbolics', 0),
                'current_warp_power': warp_power,
                'current_shields': shields,
                'current_fighters': fighters,
            }
            if ship_name is not None:
                ship_updates['ship_name'] = ship_name
            supabase_reset_character_state(
                character_id,
                sector=sector,
                credits=credits,
                ship_updates=ship_updates,
                map_knowledge=knowledge,
                bank_credits=credits_in_bank,
            )

    return knowledge_path


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
    _update_last_seen(character_id)


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

    deleted = 0
    ships = _load_ships()

    for filepath in KNOWLEDGE_DIR.glob(f"{prefix}*.json"):
        character_id = filepath.stem
        filepath.unlink()
        deleted += 1
        ship_id = _ship_id(character_id)
        ships.pop(ship_id, None)

    _save_ships(ships)
    return deleted


def create_weak_character(
    character_id: str,
    sector: int = 0,
    fighters: int = 5,
) -> Path:
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
    return create_test_character_knowledge(
        character_id,
        fighters=fighters,
        max_fighters=500,
        shields=200,
        max_shields=200,
        ship_type="atlas_hauler",
        sector=sector,
    )


def create_balanced_character(
    character_id: str,
    sector: int = 0,
) -> Path:
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
    ships = _load_ships()
    ship_id = _ship_id(character_id)
    if ship_id not in ships:
        raise FileNotFoundError(f"Ship not found for character: {character_id}")
    cargo = {
        "quantum_foam": int(quantum_foam),
        "retro_organics": int(retro_organics),
        "neuro_symbolics": int(neuro_symbolics),
    }
    ships[ship_id].setdefault("state", {})["cargo"] = cargo
    _save_ships(ships)
    _update_last_seen(character_id)

    if os.environ.get("USE_SUPABASE_TESTS", "").strip().lower() in {"1", "true", "on", "yes"}:
        try:
            from tests.edge.support.state import update_ship_state  # type: ignore
        except Exception:  # noqa: BLE001
            pass
        else:
            update_ship_state(character_id, cargo=cargo)


def deploy_garrison_payload(
    owner_id: str,
    sector: int,
    fighters: int,
    mode: str = "offensive",
    toll_amount: int = 0,
) -> Dict[str, Any]:
    payload = {
        "character_id": owner_id,
        "sector": sector,
        "quantity": fighters,
        "mode": mode,
    }
    if mode == "toll" and toll_amount > 0:
        payload["toll_amount"] = toll_amount
    return payload


async def deploy_garrison(
    client,
    owner_id: str,
    sector: int,
    fighters: int,
    mode: str = "offensive",
    toll_amount: int = 0,
) -> None:
    params = deploy_garrison_payload(owner_id, sector, fighters, mode, toll_amount)
    await client.combat_leave_fighters(**params)


async def verify_garrison_combat(
    events: list,
    expected_garrison_owner: str,
    expected_arrival_char: str,
) -> dict:
    assert len(events) >= 1, "Should have combat.round_waiting event"

    waiting_event = events[0]["payload"]
    inner = waiting_event.get("payload", waiting_event)

    garrison = inner.get("garrison")
    assert garrison is not None, "Garrison should be present in combat"
    assert garrison.get("owner_name") == expected_garrison_owner, (
        f"Expected garrison owner {expected_garrison_owner}, got {garrison.get('owner_name')}"
    )

    participants = inner.get("participants", [])
    assert len(participants) >= 1, "Should have at least the arriving character"

    character = next((p for p in participants if p.get("name") == expected_arrival_char), None)
    assert character is not None, f"Arriving character {expected_arrival_char} should be participant"

    return inner
