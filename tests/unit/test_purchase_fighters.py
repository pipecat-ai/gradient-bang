import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from gradientbang.game_server.api import purchase_fighters
from gradientbang.game_server.character_knowledge import CharacterKnowledgeManager
from gradientbang.game_server.core.world import Character
from gradientbang.game_server.core.locks.credit_locks import CreditLockManager
from gradientbang.game_server.core.ships_manager import ShipsManager
from gradientbang.game_server.ships import ShipType, get_ship_stats


def _create_world(
    tmp_path,
    *,
    character_id: str = "pilot",
    sector: int = 0,
    fighters: int = 150,
    ship_type: str = "kestrel_courier",
    credits: int = 20_000,
    in_hyperspace: bool = False,
):
    world_dir = tmp_path / f"world-{uuid.uuid4()}"
    world_dir.mkdir()

    ships_manager = ShipsManager(world_dir)
    knowledge_manager = CharacterKnowledgeManager(world_dir / "knowledge")
    knowledge_manager.set_ships_manager(ships_manager)

    ship_id = ships_manager.create_ship(
        ship_type=ship_type,
        sector=sector,
        owner_type="character",
        owner_id=character_id,
        name=None,
    )

    ships_manager.update_ship_state(ship_id, fighters=fighters, credits=credits)
    knowledge = knowledge_manager.load_knowledge(character_id)
    knowledge.current_sector = sector
    knowledge.current_ship_id = ship_id
    knowledge.last_update = datetime.now(timezone.utc).isoformat()
    knowledge_manager.save_knowledge(knowledge)
    knowledge_manager.update_ship_credits(character_id, credits)

    stats = get_ship_stats(ShipType(ship_type))
    character = Character(
        character_id,
        sector=sector,
        name=character_id,
        fighters=fighters,
        shields=stats.shields,
        max_fighters=stats.fighters,
        max_shields=stats.shields,
        in_hyperspace=in_hyperspace,
    )

    world = SimpleNamespace(
        knowledge_manager=knowledge_manager,
        ships_manager=ships_manager,
        characters={character_id: character},
        character_to_corp={},
    )

    return world, ship_id


@pytest.fixture(autouse=True)
def _stub_status_payload(monkeypatch):
    async def _status(world, character_id):
        knowledge = world.knowledge_manager.load_knowledge(character_id)
        ship = world.ships_manager.get_ship(knowledge.current_ship_id)
        return {
            "ship": {
                "id": knowledge.current_ship_id,
                "ship_type": ship["ship_type"],
                "fighters": ship.get("state", {}).get("fighters", 0),
            },
            "player": {"id": character_id},
            "sector": {"id": world.characters[character_id].sector},
        }

    monkeypatch.setattr(purchase_fighters, "build_status_payload", _status)


@pytest.mark.asyncio
async def test_purchase_fighters_success(tmp_path, monkeypatch):
    world, ship_id = _create_world(tmp_path, fighters=200, credits=10_000)
    events = []

    async def _emit(event, payload, **kwargs):
        events.append((event, payload, kwargs))

    monkeypatch.setattr(purchase_fighters.event_dispatcher, "emit", _emit)

    credit_locks = CreditLockManager()
    response = await purchase_fighters.handle(
        {"character_id": "pilot", "units": 150}, world, credit_locks
    )

    assert response["success"] is True

    ship = world.ships_manager.get_ship(ship_id)
    fighters_final = ship["state"]["fighters"]
    assert fighters_final == 300
    credits_after = ship["state"]["credits"]
    assert credits_after == 5_000  # 10,000 - (100 * 50)

    fighter_event = next((payload for event, payload, _ in events if event == "fighter.purchase"), None)
    assert fighter_event is not None
    assert fighter_event["units"] == 100  # capped at available capacity
    assert fighter_event["total_cost"] == 5_000
    assert fighter_event["fighters_after"] == 300
    assert fighter_event["credits_after"] == 5_000

    status_event = next((event for event, _, _ in events if event == "status.update"), None)
    assert status_event == "status.update"


@pytest.mark.asyncio
async def test_purchase_fighters_requires_sector_zero(tmp_path, monkeypatch):
    world, _ = _create_world(tmp_path, sector=42)

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(purchase_fighters.event_dispatcher, "emit", _noop)

    with pytest.raises(HTTPException) as excinfo:
        await purchase_fighters.handle({"character_id": "pilot", "units": 10}, world)

    assert "sector 42" in excinfo.value.detail


@pytest.mark.asyncio
async def test_purchase_fighters_insufficient_credits(tmp_path, monkeypatch):
    world, _ = _create_world(tmp_path, fighters=50, credits=1_000)

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(purchase_fighters.event_dispatcher, "emit", _noop)

    with pytest.raises(HTTPException) as excinfo:
        await purchase_fighters.handle({"character_id": "pilot", "units": 100}, world)

    assert "Insufficient credits" in excinfo.value.detail


@pytest.mark.asyncio
async def test_purchase_fighters_capacity_guard(tmp_path, monkeypatch):
    stats = get_ship_stats(ShipType("kestrel_courier"))
    world, _ = _create_world(tmp_path, fighters=stats.fighters)

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(purchase_fighters.event_dispatcher, "emit", _noop)

    with pytest.raises(HTTPException) as excinfo:
        await purchase_fighters.handle({"character_id": "pilot", "units": 1}, world)

    assert "capacity" in excinfo.value.detail.lower()


@pytest.mark.asyncio
async def test_purchase_fighters_in_hyperspace(tmp_path, monkeypatch):
    world, _ = _create_world(tmp_path, in_hyperspace=True)

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(purchase_fighters.event_dispatcher, "emit", _noop)

    with pytest.raises(HTTPException) as excinfo:
        await purchase_fighters.handle({"character_id": "pilot", "units": 5}, world)

    assert "hyperspace" in excinfo.value.detail.lower()
