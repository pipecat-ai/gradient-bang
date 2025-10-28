import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from core.world import Character
from api import join


def _make_knowledge():
    return SimpleNamespace(
        ship_config=SimpleNamespace(
            ship_type="kestrel_courier",
            current_fighters=50,
            current_shields=75,
            current_warp_power=20,
            ship_name="Test Ship",
            cargo={},
        ),
        sectors_visited={},
    )


def _build_world(character_id: str, sector: int, encounter):
    character = Character(character_id, sector=sector)
    characters = {character_id: character}
    knowledge_manager = SimpleNamespace(
        has_knowledge=MagicMock(return_value=True),
        load_knowledge=MagicMock(return_value=_make_knowledge()),
        update_sector_visit=MagicMock(),
        update_credits=MagicMock(),
    )
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
    knowledge = _make_knowledge()
    knowledge_manager = SimpleNamespace(
        has_knowledge=MagicMock(return_value=False),
        initialize_ship=MagicMock(),
        load_knowledge=MagicMock(return_value=knowledge),
        update_sector_visit=MagicMock(),
        update_credits=MagicMock(),
        get_current_sector=MagicMock(return_value=None),
    )
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
