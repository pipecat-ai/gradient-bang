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
        )
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
    world = SimpleNamespace(
        characters=characters,
        knowledge_manager=knowledge_manager,
        universe_graph=SimpleNamespace(sector_count=2048),
        garrisons=None,
        combat_manager=combat_manager,
    )
    return world


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
    round_waiting_payload = {"combat_id": "combat-123", "participants": []}
    serialize_mock = AsyncMock(return_value=round_waiting_payload)
    monkeypatch.setattr(join, "serialize_round_waiting_event", serialize_mock)

    emit_mock = AsyncMock()
    monkeypatch.setattr(join.event_dispatcher, "emit", emit_mock)

    request = {"character_id": character_id, "request_id": "req-join"}

    result = await join.handle(request, world)

    assert result == {"ok": True}

    serialize_mock.assert_awaited_once_with(
        world, encounter, viewer_id=character_id
    )

    emit_mock.assert_awaited_once()
    event_args = emit_mock.await_args
    assert event_args.args[0] == "combat.round_waiting"
    payload = event_args.args[1]
    assert payload["combat_id"] == "combat-123"
    assert payload["source"]["method"] == "join"
    assert payload["source"]["request_id"] == "req-join"
    assert event_args.kwargs["character_filter"] == [character_id]


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
        join, "serialize_round_waiting_event", AsyncMock(return_value={})
    )

    emit_mock = AsyncMock()
    monkeypatch.setattr(join.event_dispatcher, "emit", emit_mock)

    request = {"character_id": character_id, "request_id": "req-join"}

    result = await join.handle(request, world)

    assert result == {"ok": True}
    emit_mock.assert_not_awaited()
