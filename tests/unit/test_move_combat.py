import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, call

from gradientbang.game_server.core.world import Character
from gradientbang.game_server.api import move


def _make_ship_record(character_id: str):
    return {
        "ship_id": f"{character_id}-ship",
        "ship_type": "kestrel_courier",
        "name": "Test Ship",
        "sector": 0,
        "owner_type": "character",
        "owner_id": character_id,
        "state": {
            "warp_power": 10,
            "warp_power_capacity": 300,
            "fighters": 40,
            "shields": 80,
            "cargo": {
                "quantum_foam": 0,
                "retro_organics": 0,
                "neuro_symbolics": 0,
            },
        },
    }


def _build_world(character_id: str, *, encounter=None):
    character = Character(character_id, sector=0)
    world = SimpleNamespace()
    world.characters = {character_id: character}
    world.universe_graph = SimpleNamespace(
        adjacency={0: [1], 1: [0]},
        sector_count=100,
    )

    ship_record = _make_ship_record(character_id)
    knowledge = SimpleNamespace(current_ship_id=ship_record["ship_id"])

    def get_ship(_character_id: str):
        return {
            "ship_id": ship_record["ship_id"],
            "ship_type": ship_record["ship_type"],
            "name": ship_record["name"],
            "state": dict(ship_record["state"]),
        }

    knowledge_manager = SimpleNamespace(
        load_knowledge=MagicMock(return_value=knowledge),
        save_knowledge=MagicMock(),
        update_sector_visit=MagicMock(return_value=False),
        get_credits=MagicMock(return_value=0),
        get_ship=MagicMock(side_effect=lambda cid: get_ship(cid)),
    )
    world.knowledge_manager = knowledge_manager
    world.ships_manager = SimpleNamespace(
        get_ship=lambda ship_id: get_ship(character_id) if ship_id == ship_record["ship_id"] else None,
        update_ship_state=lambda ship_id, **updates: ship_record["state"].update(updates),
        move_ship=lambda ship_id, to_sector: ship_record.__setitem__("sector", to_sector),
    )
    world.garrisons = None

    if encounter is not None:
        async def add_participant(combat_id, state):
            encounter.participants[character_id] = state
            return encounter

        world.combat_manager = SimpleNamespace(
            find_encounter_for=AsyncMock(return_value=None),
            find_encounter_in_sector=AsyncMock(return_value=encounter),
            add_participant=AsyncMock(side_effect=add_participant),
        )
    else:
        world.combat_manager = SimpleNamespace(
            find_encounter_for=AsyncMock(return_value=None),
            find_encounter_in_sector=AsyncMock(return_value=None),
            add_participant=AsyncMock(),
        )

    return world


@pytest.mark.asyncio
async def test_move_emits_combat_round_waiting(monkeypatch):
    character_id = "pilot"
    encounter = SimpleNamespace(
        combat_id="combat-456",
        sector_id=1,
        participants={},
        ended=False,
    )
    world = _build_world(character_id, encounter=encounter)

    monkeypatch.setattr(move, "ensure_not_in_combat", AsyncMock())
    monkeypatch.setattr(
        move, "sector_contents", AsyncMock(side_effect=[{"port": None}, {"port": None}])
    )
    monkeypatch.setattr(
        move, "player_self", lambda _world, cid: {"player_id": cid}
    )
    monkeypatch.setattr(
        move, "ship_self", lambda _world, cid: {"ship_id": cid}
    )
    monkeypatch.setattr(
        move, "build_local_map_region", AsyncMock(return_value={"map": True})
    )
    monkeypatch.setattr(
        move, "build_character_combatant", MagicMock(return_value={"combatant": character_id})
    )
    serialize_mock = AsyncMock(return_value={"combat_id": "combat-456"})
    monkeypatch.setattr(move, "serialize_round_waiting_event", serialize_mock)

    emit_mock = AsyncMock()
    monkeypatch.setattr(move.event_dispatcher, "emit", emit_mock)
    monkeypatch.setattr(move.asyncio, "sleep", AsyncMock())

    # Ensure status payload builder doesn't exercise real dependencies
    import gradientbang.game_server.api.utils as api_utils

    monkeypatch.setattr(
        api_utils,
        "build_status_payload",
        AsyncMock(side_effect=AssertionError("build_status_payload should not be called")),
    )

    request = {
        "character_id": character_id,
        "to_sector": 1,
        "request_id": "req-move",
    }

    result = await move.handle(request, world)

    assert result == {"success": True}

    serialize_mock.assert_awaited_once_with(world, encounter, viewer_id=character_id)

    combat_calls = [
        call for call in emit_mock.await_args_list if call.args[0] == "combat.round_waiting"
    ]
    assert combat_calls, "Expected combat.round_waiting emission"
    payload = combat_calls[0].args[1]
    assert payload["source"]["method"] == "move"
    assert payload["source"]["request_id"] == "req-move"
    assert combat_calls[0].kwargs["character_filter"] == [character_id]


@pytest.mark.asyncio
async def test_move_without_combat_does_not_emit(monkeypatch):
    character_id = "explorer"
    world = _build_world(character_id, encounter=None)

    monkeypatch.setattr(move, "ensure_not_in_combat", AsyncMock())
    monkeypatch.setattr(
        move, "sector_contents", AsyncMock(side_effect=[{"port": None}, {"port": None}])
    )
    monkeypatch.setattr(
        move, "player_self", lambda _world, cid: {"player_id": cid}
    )
    monkeypatch.setattr(
        move, "ship_self", lambda _world, cid: {"ship_id": cid}
    )
    monkeypatch.setattr(
        move, "build_local_map_region", AsyncMock(return_value={"map": True})
    )
    monkeypatch.setattr(move, "build_character_combatant", MagicMock())
    serialize_mock = AsyncMock(return_value={"combat_id": "combat-789"})
    monkeypatch.setattr(move, "serialize_round_waiting_event", serialize_mock)

    emit_mock = AsyncMock()
    monkeypatch.setattr(move.event_dispatcher, "emit", emit_mock)
    monkeypatch.setattr(move.asyncio, "sleep", AsyncMock())

    import gradientbang.game_server.api.utils as api_utils

    monkeypatch.setattr(
        api_utils,
        "build_status_payload",
        AsyncMock(side_effect=AssertionError("build_status_payload should not be called")),
    )

    request = {
        "character_id": character_id,
        "to_sector": 1,
        "request_id": "req-move",
    }

    result = await move.handle(request, world)

    assert result == {"success": True}
    serialize_mock.assert_not_awaited()
    combat_calls = [
        call for call in emit_mock.await_args_list if call.args[0] == "combat.round_waiting"
    ]
    assert not combat_calls


@pytest.mark.asyncio
async def test_move_emits_garrison_character_moved_event(monkeypatch):
    character_id = "pilot"
    world = _build_world(character_id, encounter=None)

    world.character_to_corp = {
        "garrison-owner": "corp-123",
        "corp-mate": "corp-123",
    }

    owner = Character("garrison-owner", sector=1, name="Corsair Pilot", connected=True)
    corp_mate = Character("corp-mate", sector=3, name="Fleet Wing", connected=True)
    world.characters.update({
        owner.id: owner,
        corp_mate.id: corp_mate,
    })

    class DummyGarrison:
        def __init__(self):
            self.owner_id = "garrison-owner"
            self.mode = "defensive"
            self.fighters = 18
            self.toll_amount = 0
            self.deployed_at = "2025-11-03T00:00:00Z"

    garrison = DummyGarrison()

    class DummyGarrisonStore:
        async def list_sector(self, sector_id: int):
            return [garrison] if sector_id == 1 else []

    world.garrisons = DummyGarrisonStore()

    monkeypatch.setattr(move, "ensure_not_in_combat", AsyncMock())
    monkeypatch.setattr(
        move,
        "sector_contents",
        AsyncMock(side_effect=[{"port": None}, {"port": None}]),
    )
    monkeypatch.setattr(move, "player_self", lambda _world, cid: {"player_id": cid})
    monkeypatch.setattr(move, "ship_self", lambda _world, cid: {"ship_id": cid})
    monkeypatch.setattr(move, "build_local_map_region", AsyncMock(return_value={"map": True}))
    monkeypatch.setattr(move, "build_character_combatant", MagicMock())
    monkeypatch.setattr(move, "serialize_round_waiting_event", AsyncMock())
    monkeypatch.setattr(move, "start_sector_combat", AsyncMock())

    def fake_build_character_moved_payload(
        _world,
        cid,
        *,
        move_type,
        movement=None,
        timestamp=None,
        knowledge=None,
        extra_fields=None,
    ):
        payload = {
            "player": {"id": cid},
            "ship": {"ship_name": "Test Ship"},
        }
        if movement is not None:
            payload["movement"] = movement
        if extra_fields:
            payload.update(extra_fields)
        return payload

    monkeypatch.setattr(move, "build_character_moved_payload", fake_build_character_moved_payload)

    emit_mock = AsyncMock()
    monkeypatch.setattr(move.event_dispatcher, "emit", emit_mock)
    monkeypatch.setattr(move.asyncio, "sleep", AsyncMock())

    request = {
        "character_id": character_id,
        "to_sector": 1,
    }

    result = await move.handle(request, world)

    assert result == {"success": True}

    garrison_calls = [
        recorded_call
        for recorded_call in emit_mock.await_args_list
        if recorded_call.args and recorded_call.args[0] == "garrison.character_moved"
    ]
    assert len(garrison_calls) == 1, "Expected garrison.character_moved emission"

    event_name, payload = garrison_calls[0].args
    assert event_name == "garrison.character_moved"
    recipients = garrison_calls[0].kwargs.get("character_filter")
    assert recipients == ["garrison-owner", "corp-mate"]
    assert payload["movement"] == "arrive"
    assert payload["player"]["id"] == character_id
    assert payload["garrison"] == {
        "owner_id": "garrison-owner",
        "owner_name": "Corsair Pilot",
        "corporation_id": "corp-123",
        "fighters": 18,
        "mode": "defensive",
        "toll_amount": 0,
        "deployed_at": "2025-11-03T00:00:00Z",
    }


@pytest.mark.asyncio
async def test_move_updates_sector_before_movement_complete(monkeypatch):
    character_id = "scout"
    world = _build_world(character_id, encounter=None)

    call_order: list[str] = []

    def _record_update(**kwargs):
        call_order.append("update")
        return True

    world.knowledge_manager.update_sector_visit = MagicMock(side_effect=_record_update)

    monkeypatch.setattr(move, "ensure_not_in_combat", AsyncMock())
    monkeypatch.setattr(
        move,
        "sector_contents",
        AsyncMock(
            side_effect=[
                {"port": None, "adjacent_sectors": [], "planets": []},
                {"port": None, "adjacent_sectors": [], "planets": []},
            ]
        ),
    )

    def _player_self(_world, cid):
        call_order.append("player_self")
        return {"player_id": cid}

    def _ship_self(_world, cid):
        call_order.append("ship_self")
        return {"ship_id": cid}

    monkeypatch.setattr(move, "player_self", _player_self)
    monkeypatch.setattr(move, "ship_self", _ship_self)
    monkeypatch.setattr(move, "build_local_map_region", AsyncMock(return_value={"map": True}))
    monkeypatch.setattr(move, "build_character_combatant", MagicMock())
    emit_mock = AsyncMock()
    monkeypatch.setattr(move.event_dispatcher, "emit", emit_mock)
    monkeypatch.setattr(move.asyncio, "sleep", AsyncMock())

    request = {
        "character_id": character_id,
        "to_sector": 1,
        "request_id": "req-first-visit",
    }

    await move.handle(request, world)

    movement_calls = [
        recorded_call
        for recorded_call in emit_mock.await_args_list
        if recorded_call.args and recorded_call.args[0] == "movement.complete"
    ]
    assert movement_calls, "Expected movement.complete emission"
    payload = movement_calls[0].args[1]
    assert payload["first_visit"] is True
    assert call_order[:3] == ["update", "player_self", "ship_self"]
