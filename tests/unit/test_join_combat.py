import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from gradientbang.game_server.core.world import Character
from gradientbang.game_server.api import join


def _make_ship_record(character_id: str):
    return {
        "ship_id": f"{character_id}-ship",
        "ship_type": "kestrel_courier",
        "name": "Test Ship",
        "sector": 0,
        "owner_type": "character",
        "owner_id": character_id,
        "acquired": "2025-01-01T00:00:00Z",
        "state": {
            "fighters": 50,
            "shields": 75,
            "cargo": {},
            "cargo_holds": 30,
            "warp_power": 20,
            "warp_power_capacity": 20,
            "modules": [],
        },
        "became_unowned": None,
        "former_owner_name": None,
    }


def _make_knowledge(character_id: str):
    ship = _make_ship_record(character_id)
    return SimpleNamespace(
        current_ship_id=ship["ship_id"],
        sectors_visited={},
        current_sector=None,
        credits=0,
        credits_in_bank=0,
        _ship_record=ship,
    )


class MockKnowledgeManager:
    def __init__(self, character_id: str, has_saved: bool = True):
        self.knowledge = _make_knowledge(character_id)
        self.has_knowledge = MagicMock(return_value=has_saved)
        self.update_sector_visit = MagicMock()
        self.update_credits = MagicMock()
        self.get_current_sector = MagicMock(return_value=self.knowledge.current_sector)
        self.create_ship_for_character = MagicMock(side_effect=self._create_ship)

    def load_knowledge(self, character_id: str):
        return self.knowledge

    def _create_ship(self, character_id: str, ship_type: join.ShipType, sector: int, **kwargs):
        ship = _make_ship_record(character_id)
        ship["ship_type"] = ship_type.value if hasattr(ship_type, "value") else ship_type
        ship["sector"] = sector
        ship["name"] = kwargs.get("name") or ship["name"]
        self.knowledge.current_ship_id = ship["ship_id"]
        self.knowledge.current_sector = sector
        self.knowledge._ship_record = ship

    def get_ship(self, character_id: str):
        return self.knowledge._ship_record


def _build_world(character_id: str, sector: int, encounter):
    character = Character(character_id, sector=sector)
    characters = {character_id: character}
    knowledge_manager = MockKnowledgeManager(character_id, has_saved=True)
    knowledge_manager.knowledge.current_sector = sector
    knowledge_manager.knowledge._ship_record["sector"] = sector
    knowledge_manager.get_current_sector.return_value = sector
    combat_manager = SimpleNamespace(
        find_encounter_for=AsyncMock(return_value=encounter),
        find_encounter_in_sector=AsyncMock(return_value=encounter),
        add_participant=AsyncMock(return_value=encounter),
    )
    character_registry = SimpleNamespace(
        get_profile=MagicMock(return_value=SimpleNamespace(name="Test Character"))
    )
    world = SimpleNamespace(
        characters=characters,
        knowledge_manager=knowledge_manager,
        universe_graph=SimpleNamespace(sector_count=2048),
        garrisons=None,
        combat_manager=combat_manager,
        character_registry=character_registry,
    )
    return world


@pytest.mark.asyncio
async def test_join_new_character_emits_status_snapshot(monkeypatch):
    character_id = "rookie"
    knowledge_manager = MockKnowledgeManager(character_id, has_saved=False)
    knowledge_manager.knowledge.current_ship_id = None
    knowledge_manager.knowledge.current_sector = None
    knowledge_manager.get_current_sector.return_value = None
    character_registry = SimpleNamespace(
        get_profile=MagicMock(return_value=SimpleNamespace(name="Test Character"))
    )
    world = SimpleNamespace(
        characters={},
        knowledge_manager=knowledge_manager,
        universe_graph=SimpleNamespace(sector_count=2048),
        garrisons=None,
        combat_manager=None,
        character_registry=character_registry,
    )

    monkeypatch.setattr(
        join, "sector_contents", AsyncMock(return_value={"port": None, "position": (0, 0)})
    )
    monkeypatch.setattr(
        join, "build_status_payload", AsyncMock(return_value={"ok": True})
    )
    monkeypatch.setattr(
        join, "build_local_map_region", AsyncMock(return_value={"sectors": []})
    )
    emit_mock = AsyncMock()
    monkeypatch.setattr(join.event_dispatcher, "emit", emit_mock)

    request = {"character_id": character_id, "request_id": "req-join"}

    result = await join.handle(request, world)

    assert result == {"success": True}
    assert character_id in world.characters
    knowledge_manager.create_ship_for_character.assert_called_once()
    emit_calls = emit_mock.await_args_list
    assert len(emit_calls) == 2  # status.snapshot + map.local

    # Check status.snapshot event
    status_call = next(call for call in emit_calls if call.args[0] == "status.snapshot")
    payload = status_call.args[1]
    assert payload["ok"] is True
    assert payload["source"]["method"] == "join"
    assert payload["source"]["request_id"] == "req-join"
    assert status_call.kwargs["character_filter"] == [character_id]

    # Check map.local event
    map_call = next(call for call in emit_calls if call.args[0] == "map.local")
    assert map_call.kwargs["character_filter"] == [character_id]

    assert all(call.args[0] != "character.joined" for call in emit_calls)


@pytest.mark.asyncio
async def test_join_emits_combat_round_waiting(monkeypatch):
    character_id = "newbie"
    encounter = SimpleNamespace(
        combat_id="combat-123",
        sector_id=10,
        participants={character_id: object()},
        ended=False,
    )
    world = _build_world(character_id, sector=10, encounter=encounter)

    monkeypatch.setattr(
        join, "sector_contents", AsyncMock(return_value={"port": None, "position": (0, 0)})
    )
    monkeypatch.setattr(
        join, "build_status_payload", AsyncMock(return_value={"ok": True})
    )
    monkeypatch.setattr(
        join, "build_local_map_region", AsyncMock(return_value={"sectors": []})
    )
    round_waiting_payload = {"combat_id": "combat-123", "participants": []}
    serialize_mock = AsyncMock(return_value=round_waiting_payload)
    monkeypatch.setattr(join, "serialize_round_waiting_event", serialize_mock)

    emit_mock = AsyncMock()
    monkeypatch.setattr(join.event_dispatcher, "emit", emit_mock)

    request = {"character_id": character_id, "request_id": "req-join"}

    result = await join.handle(request, world)

    assert result == {"success": True}

    serialize_mock.assert_awaited_once_with(
        world, encounter, viewer_id=character_id
    )

    await_calls = emit_mock.await_args_list
    assert len(await_calls) == 3  # combat.round_waiting + status.snapshot + map.local

    round_call = next(call for call in await_calls if call.args[0] == "combat.round_waiting")
    round_payload = round_call.args[1]
    assert round_payload["combat_id"] == "combat-123"
    assert round_payload["source"]["method"] == "join"
    assert round_payload["source"]["request_id"] == "req-join"
    assert round_call.kwargs["character_filter"] == [character_id]

    status_call = next(call for call in await_calls if call.args[0] == "status.snapshot")
    status_payload = status_call.args[1]
    assert status_payload["ok"] is True
    assert status_payload["source"]["method"] == "join"
    assert status_payload["source"]["request_id"] == "req-join"
    assert status_call.kwargs["character_filter"] == [character_id]

    # Check map.local event
    map_call = next(call for call in await_calls if call.args[0] == "map.local")
    assert map_call.kwargs["character_filter"] == [character_id]

    assert all(call.args[0] != "character.joined" for call in await_calls)


@pytest.mark.asyncio
async def test_join_no_combat_does_not_emit(monkeypatch):
    character_id = "loner"
    world = _build_world(character_id, sector=5, encounter=None)
    world.combat_manager.find_encounter_for = AsyncMock(return_value=None)
    world.combat_manager.find_encounter_in_sector = AsyncMock(return_value=None)

    monkeypatch.setattr(
        join, "sector_contents", AsyncMock(return_value={"port": None, "position": (0, 0)})
    )
    monkeypatch.setattr(
        join, "build_status_payload", AsyncMock(return_value={"ok": True})
    )
    monkeypatch.setattr(
        join, "build_local_map_region", AsyncMock(return_value={"sectors": []})
    )
    monkeypatch.setattr(
        join, "serialize_round_waiting_event", AsyncMock(return_value={})
    )

    emit_mock = AsyncMock()
    monkeypatch.setattr(join.event_dispatcher, "emit", emit_mock)

    request = {"character_id": character_id, "request_id": "req-join"}

    result = await join.handle(request, world)

    assert result == {"success": True}

    await_calls = emit_mock.await_args_list
    assert len(await_calls) == 2  # status.snapshot + map.local

    status_call = next(call for call in await_calls if call.args[0] == "status.snapshot")
    status_payload = status_call.args[1]
    assert status_payload["ok"] is True
    assert status_payload["source"]["method"] == "join"
    assert status_payload["source"]["request_id"] == "req-join"
    assert status_call.kwargs["character_filter"] == [character_id]

    # Check map.local event
    map_call = next(call for call in await_calls if call.args[0] == "map.local")
    assert map_call.kwargs["character_filter"] == [character_id]
