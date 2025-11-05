import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api import corporation_leave
from character_knowledge import MapKnowledge
from core.corporation_manager import CorporationManager


class StubShipsManager:
    def __init__(self, ships):
        self.ships = ships
        self.marked = []

    def get_ship(self, ship_id: str):
        if ship_id not in self.ships:
            raise KeyError(ship_id)
        return self.ships[ship_id]

    def mark_as_unowned(self, ship_id: str, former_owner_name: str):
        self.marked.append((ship_id, former_owner_name))
        if ship_id in self.ships:
            self.ships[ship_id]["owner_type"] = "unowned"
            self.ships[ship_id]["owner_id"] = None


class StubKnowledgeManager:
    def __init__(self, knowledge_map):
        self._knowledge_map = knowledge_map

    def load_knowledge(self, character_id: str) -> MapKnowledge:
        return self._knowledge_map[character_id]

    def save_knowledge(self, knowledge: MapKnowledge) -> None:
        self._knowledge_map[knowledge.character_id] = knowledge


@pytest.fixture
def build_world(tmp_path):
    def _factory(characters, corp_members=None, corp_name="Nebula Guild", corp_ships=None):
        world_dir = tmp_path / f"world-{uuid.uuid4()}"
        world_dir.mkdir()
        corp_manager = CorporationManager(world_dir)

        knowledge_map = {}
        characters_map = {}
        for char in characters:
            char_id = char["id"]
            knowledge_map[char_id] = MapKnowledge(
                character_id=char_id,
                credits=char.get("credits", 0),
                current_sector=char.get("sector", 0),
                corporation=char.get("corporation"),
            )
            characters_map[char_id] = SimpleNamespace(
                sector=char.get("sector", 0),
                name=char.get("name", char_id),
            )

        world = SimpleNamespace(
            corporation_manager=corp_manager,
            knowledge_manager=StubKnowledgeManager(knowledge_map),
            characters=characters_map,
            character_to_corp={},
            ships_manager=None,
        )

        corp = None
        if corp_members:
            founder = corp_members[0]
            corp = corp_manager.create(corp_name, founder)
            corp["members"] = list(corp_members)
            corp["ships"] = list(corp_ships or [])
            corp_manager.save(corp["corp_id"], corp)

        if corp:
            for member_id in corp_members:
                world.character_to_corp[member_id] = corp["corp_id"]
                if member_id in knowledge_map:
                    knowledge_map[member_id].corporation = {
                        "corp_id": corp["corp_id"],
                        "joined_at": "2025-11-01T00:00:00Z",
                    }

        return world, knowledge_map, corp

    return _factory


@pytest.mark.asyncio
async def test_leave_last_member_disbands_and_marks_ships(build_world, monkeypatch):
    world, knowledge_map, corp = build_world(
        [{"id": "solo", "credits": 5000, "sector": 6}],
        corp_members=["solo"],
        corp_ships=["ship-1", "ship-2"],
    )

    ships_data = {
        "ship-1": {"ship_id": "ship-1", "ship_type": "atlas_hauler", "sector": 3},
        "ship-2": {"ship_id": "ship-2", "ship_type": "kestrel_courier", "sector": 5},
    }
    ships_manager = StubShipsManager(ships_data)
    world.ships_manager = ships_manager

    emit_calls = []

    async def _emit(event, payload, **kwargs):
        emit_calls.append((event, payload, kwargs))

    monkeypatch.setattr(corporation_leave.event_dispatcher, "emit", _emit)

    response = await corporation_leave.handle({"character_id": "solo"}, world)

    assert response["success"] is True
    assert knowledge_map["solo"].corporation is None
    assert "solo" not in world.character_to_corp
    assert ships_manager.marked == [("ship-1", corp["name"]), ("ship-2", corp["name"])]
    assert world.corporation_manager.get_by_name(corp["name"]) is None

    events = {call[0] for call in emit_calls}
    assert "corporation.disbanded" in events
    assert "corporation.ships_abandoned" in events


@pytest.mark.asyncio
async def test_leave_non_last_member_emits_member_left(build_world, monkeypatch):
    world, knowledge_map, corp = build_world(
        [
            {"id": "leader", "credits": 10000, "sector": 4},
            {"id": "member", "credits": 3000, "sector": 7},
        ],
        corp_members=["leader", "member"],
    )
    world.ships_manager = StubShipsManager({})

    events = []

    async def _emit(event, payload, **kwargs):
        events.append((event, payload, kwargs))

    monkeypatch.setattr(corporation_leave.event_dispatcher, "emit", _emit)

    response = await corporation_leave.handle({"character_id": "member"}, world)

    assert response["success"] is True
    assert knowledge_map["member"].corporation is None
    assert "member" not in world.character_to_corp

    updated = world.corporation_manager.load(corp["corp_id"])
    assert updated["members"] == ["leader"]

    assert any(event == "corporation.member_left" for event, _, _ in events)


@pytest.mark.asyncio
async def test_leave_not_in_corp_raises(build_world, monkeypatch):
    world, knowledge_map, _ = build_world(
        [{"id": "loner", "credits": 2000, "sector": 2}]
    )
    world.ships_manager = StubShipsManager({})
    monkeypatch.setattr(corporation_leave.event_dispatcher, "emit", pytest.fail)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_leave.handle({"character_id": "loner"}, world)
    assert excinfo.value.status_code == 400
    assert "Not in a corporation" in excinfo.value.detail
