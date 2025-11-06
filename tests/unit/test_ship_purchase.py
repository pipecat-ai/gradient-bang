import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api import ship_purchase
from api.utils import _build_corp_ship_summaries
from character_knowledge import CharacterKnowledgeManager
from core.corporation_manager import CorporationManager
from core.locks.credit_locks import CreditLockManager
from core.ships_manager import ShipsManager
from core.world import Character
from ships import ShipType, get_ship_stats


def _create_world(tmp_path, *, character_id: str, credits: int, bank: int = 0, sector: int = 1, ship_type: str = "kestrel_courier"):
    world_dir = tmp_path / f"world-{uuid.uuid4()}"
    world_dir.mkdir()

    ships_manager = ShipsManager(world_dir)
    knowledge_manager = CharacterKnowledgeManager(world_dir / "character-map-knowledge")
    knowledge_manager.set_ships_manager(ships_manager)
    corporation_manager = CorporationManager(world_dir)

    stats = get_ship_stats(ShipType(ship_type))
    ship_id = ships_manager.create_ship(
        ship_type=ship_type,
        sector=sector,
        owner_type="character",
        owner_id=character_id,
        name=None,
    )

    knowledge = knowledge_manager.load_knowledge(character_id)
    knowledge.current_sector = sector
    knowledge.current_ship_id = ship_id
    knowledge.last_update = datetime.now(timezone.utc).isoformat()
    knowledge_manager.save_knowledge(knowledge)
    knowledge_manager.update_ship_credits(character_id, credits)
    knowledge_manager.update_bank_credits(character_id, bank)

    character = Character(
        character_id,
        sector=sector,
        name=character_id,
        fighters=stats.fighters,
        shields=stats.shields,
        max_fighters=stats.fighters,
        max_shields=stats.shields,
    )

    world = SimpleNamespace(
        knowledge_manager=knowledge_manager,
        ships_manager=ships_manager,
        corporation_manager=corporation_manager,
        characters={character_id: character},
        character_to_corp={},
        universe_graph=None,
        port_manager=None,
        combat_manager=None,
        salvage_manager=None,
        garrisons=None,
        character_registry=None,
    )

    return world, ship_id


@pytest.fixture(autouse=True)
def _stub_status_payload(monkeypatch):
    async def _status(world, character_id):
        return {"character_id": character_id}

    monkeypatch.setattr(ship_purchase, "build_status_payload", _status)


@pytest.mark.asyncio
async def test_personal_trade_in_creates_new_ship_and_marks_old_unowned(tmp_path, monkeypatch):
    world, old_ship_id = _create_world(
        tmp_path,
        character_id="pilot",
        credits=50_000,
        sector=3,
        ship_type="kestrel_courier",
    )

    events = []

    async def _emit(event, payload, **kwargs):
        events.append((event, payload, kwargs))

    monkeypatch.setattr(ship_purchase.event_dispatcher, "emit", _emit)

    credit_locks = CreditLockManager()

    response = await ship_purchase.handle(
        {"character_id": "pilot", "ship_type": "sparrow_scout"},
        world,
        credit_locks,
    )

    assert response["success"] is True
    new_ship_id = response["ship_id"]
    assert new_ship_id != old_ship_id

    knowledge = world.knowledge_manager.load_knowledge("pilot")
    assert knowledge.current_ship_id == new_ship_id
    assert world.knowledge_manager.get_ship_credits("pilot") == 40_000  # 50k - (35k - 25k)

    old_ship = world.ships_manager.get_ship(old_ship_id)
    assert old_ship["owner_type"] == "unowned"
    assert old_ship["former_owner_name"] == "pilot"

    new_ship = world.ships_manager.get_ship(new_ship_id)
    assert new_ship["owner_type"] == "character"
    assert new_ship["owner_id"] == "pilot"

    event_names = [event for event, _, _ in events]
    assert "ship.traded_in" in event_names
    assert "status.update" in event_names

    traded_event = next(payload for event, payload, _ in events if event == "ship.traded_in")
    assert traded_event["old_ship_id"] == old_ship_id
    assert traded_event["new_ship_id"] == new_ship_id
    assert traded_event["net_cost"] == 10_000


@pytest.mark.asyncio
async def test_personal_trade_in_insufficient_funds(tmp_path, monkeypatch):
    world, _ = _create_world(
        tmp_path,
        character_id="cashlight",
        credits=10_000,
        sector=4,
        ship_type="kestrel_courier",
    )

    async def _emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not be called")

    monkeypatch.setattr(ship_purchase.event_dispatcher, "emit", _emit)

    credit_locks = CreditLockManager()

    with pytest.raises(HTTPException) as excinfo:
        await ship_purchase.handle(
            {"character_id": "cashlight", "ship_type": "wayfarer_freighter"},
            world,
            credit_locks,
        )
    assert "Insufficient credits" in excinfo.value.detail

    knowledge = world.knowledge_manager.load_knowledge("cashlight")
    assert knowledge.current_ship_id is not None
    assert world.knowledge_manager.get_ship_credits("cashlight") == 10_000


@pytest.mark.asyncio
async def test_corporation_purchase_succeeds(tmp_path, monkeypatch):
    world, _ = _create_world(
        tmp_path,
        character_id="founder",
        credits=5_000,
        bank=500_000,
        sector=2,
        ship_type="sparrow_scout",
    )

    corp = world.corporation_manager.create("Nebula", "founder")
    world.character_to_corp["founder"] = corp["corp_id"]

    knowledge = world.knowledge_manager.load_knowledge("founder")
    knowledge.corporation = {"corp_id": corp["corp_id"], "joined_at": datetime.now(timezone.utc).isoformat()}
    world.knowledge_manager.save_knowledge(knowledge)

    events = []

    async def _emit(event, payload, **kwargs):
        events.append((event, payload, kwargs))

    monkeypatch.setattr(ship_purchase.event_dispatcher, "emit", _emit)

    credit_locks = CreditLockManager()

    response = await ship_purchase.handle(
        {
            "character_id": "founder",
            "ship_type": "pike_frigate",
            "purchase_type": "corporation",
        },
        world,
        credit_locks,
    )

    assert response["success"] is True
    corp_ship_id = response["ship_id"]
    assert response["initial_ship_credits"] == 0

    updated_bank = world.knowledge_manager.get_bank_credits("founder")
    assert updated_bank == 500_000 - get_ship_stats(ShipType.PIKE_FRIGATE).price

    corp_record = world.corporation_manager.load(corp["corp_id"])
    assert corp_ship_id in corp_record["ships"]

    assert world.knowledge_manager.has_knowledge(corp_ship_id)
    corp_knowledge = world.knowledge_manager.load_knowledge(corp_ship_id)
    assert corp_knowledge.current_ship_id == corp_ship_id
    assert corp_knowledge.corporation["corp_id"] == corp["corp_id"]
    assert world.character_to_corp[corp_ship_id] == corp["corp_id"]

    corp_ship = world.ships_manager.get_ship(corp_ship_id)
    assert corp_ship["owner_type"] == "corporation"
    assert corp_ship["owner_id"] == corp["corp_id"]

    event_names = [event for event, _, _ in events]
    assert "corporation.ship_purchased" in event_names
    assert "status.update" in event_names


@pytest.mark.asyncio
async def test_corporation_purchase_insufficient_bank(tmp_path, monkeypatch):
    world, _ = _create_world(
        tmp_path,
        character_id="bankless",
        credits=5_000,
        bank=10_000,
        sector=5,
        ship_type="sparrow_scout",
    )

    corp = world.corporation_manager.create("Skyfarers", "bankless")
    world.character_to_corp["bankless"] = corp["corp_id"]
    knowledge = world.knowledge_manager.load_knowledge("bankless")
    knowledge.corporation = {"corp_id": corp["corp_id"], "joined_at": datetime.now(timezone.utc).isoformat()}
    world.knowledge_manager.save_knowledge(knowledge)

    async def _emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not fire on failure")

    monkeypatch.setattr(ship_purchase.event_dispatcher, "emit", _emit)

    credit_locks = CreditLockManager()

    with pytest.raises(HTTPException) as excinfo:
        await ship_purchase.handle(
            {
                "character_id": "bankless",
                "ship_type": "pike_frigate",
                "purchase_type": "corporation",
            },
            world,
            credit_locks,
        )
    assert "Insufficient bank balance" in excinfo.value.detail

    updated_corp = world.corporation_manager.load(corp["corp_id"])
    assert updated_corp["ships"] == []


def test_corporation_ship_summary_includes_control_ready(tmp_path):
    world, _ = _create_world(
        tmp_path,
        character_id="founder",
        credits=200_000,
        bank=400_000,
        sector=2,
        ship_type="kestrel_courier",
    )

    corp = world.corporation_manager.create("Control Ready Inc", "founder")
    world.character_to_corp["founder"] = corp["corp_id"]
    knowledge = world.knowledge_manager.load_knowledge("founder")
    knowledge.corporation = {
        "corp_id": corp["corp_id"],
        "joined_at": datetime.now(timezone.utc).isoformat(),
    }
    world.knowledge_manager.save_knowledge(knowledge)

    ship_id = world.ships_manager.create_ship(
        ship_type=ShipType.ATLAS_HAULER.value,
        sector=2,
        owner_type="corporation",
        owner_id=corp["corp_id"],
        name="Control Ship",
    )
    world.corporation_manager.add_ship(corp["corp_id"], ship_id)

    corp_record = world.corporation_manager.load(corp["corp_id"])
    summaries = _build_corp_ship_summaries(world, corp_record)
    assert summaries
    assert summaries[0]["control_ready"] is False

    world.knowledge_manager.create_corp_ship_character(
        ship_id=ship_id,
        corp_id=corp["corp_id"],
        sector=2,
    )

    corp_record = world.corporation_manager.load(corp["corp_id"])
    summaries = _build_corp_ship_summaries(world, corp_record)
    assert summaries[0]["control_ready"] is True


@pytest.mark.asyncio
async def test_corporation_purchase_with_initial_ship_credits(tmp_path, monkeypatch):
    world, _ = _create_world(
        tmp_path,
        character_id="treasurer",
        credits=2_000,
        bank=100_000,
        sector=5,
        ship_type="sparrow_scout",
    )

    corp = world.corporation_manager.create("Astro", "treasurer")
    world.character_to_corp["treasurer"] = corp["corp_id"]

    knowledge = world.knowledge_manager.load_knowledge("treasurer")
    knowledge.corporation = {
        "corp_id": corp["corp_id"],
        "joined_at": datetime.now(timezone.utc).isoformat(),
    }
    world.knowledge_manager.save_knowledge(knowledge)

    credit_locks = CreditLockManager()

    response = await ship_purchase.handle(
        {
            "character_id": "treasurer",
            "ship_type": "autonomous_light_hauler",
            "purchase_type": "corporation",
            "initial_ship_credits": 5_000,
        },
        world,
        credit_locks,
    )

    assert response["success"] is True
    corp_ship_id = response["ship_id"]
    assert response["initial_ship_credits"] == 5_000

    stats = get_ship_stats(ShipType.AUTONOMOUS_LIGHT_HAULER)
    expected_bank = 100_000 - (stats.price + 5_000)
    assert world.knowledge_manager.get_bank_credits("treasurer") == expected_bank

    corp_ship = world.ships_manager.get_ship(corp_ship_id)
    assert corp_ship["owner_type"] == "corporation"
    assert corp_ship["owner_id"] == corp["corp_id"]
    assert corp_ship["state"]["credits"] == 5_000

    ship_knowledge = world.knowledge_manager.load_knowledge(corp_ship_id)
    assert ship_knowledge.credits == 5_000


@pytest.mark.asyncio
async def test_trade_in_rejects_corporation_owned_ship(tmp_path, monkeypatch):
    world, _ = _create_world(
        tmp_path,
        character_id="pilot",
        credits=100_000,
        sector=6,
        ship_type="sparrow_scout",
    )

    corp = world.corporation_manager.create("Solaris", "pilot")
    world.character_to_corp["pilot"] = corp["corp_id"]
    knowledge = world.knowledge_manager.load_knowledge("pilot")
    knowledge.corporation = {"corp_id": corp["corp_id"], "joined_at": datetime.now(timezone.utc).isoformat()}

    corp_ship_id = world.ships_manager.create_ship(
        ship_type="atlas_hauler",
        sector=6,
        owner_type="corporation",
        owner_id=corp["corp_id"],
        name=None,
    )
    knowledge.current_ship_id = corp_ship_id
    world.knowledge_manager.save_knowledge(knowledge)

    async def _emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not be called")

    monkeypatch.setattr(ship_purchase.event_dispatcher, "emit", _emit)

    credit_locks = CreditLockManager()

    with pytest.raises(HTTPException) as excinfo:
        await ship_purchase.handle(
            {
                "character_id": "pilot",
                "ship_type": "pioneer_lifter",
                "trade_in_ship_id": corp_ship_id,
            },
            world,
            credit_locks,
        )
    assert "Cannot trade in a corporation-owned ship" in excinfo.value.detail
