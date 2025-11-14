import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api import corporation_create
from character_knowledge import MapKnowledge
from core.corporation_manager import CorporationManager


class StubKnowledgeManager:
    def __init__(self, knowledge_map, ship_credits):
        self._knowledge_map = knowledge_map
        self._ship_credits = ship_credits

    def load_knowledge(self, character_id: str) -> MapKnowledge:
        knowledge = self._knowledge_map[character_id]
        if hasattr(knowledge, "credits"):
            knowledge.credits = self._ship_credits.get(character_id, 0)
        return knowledge

    def save_knowledge(self, knowledge: MapKnowledge) -> None:
        self._knowledge_map[knowledge.character_id] = knowledge

    def get_ship_credits(self, character_id: str) -> int:
        return self._ship_credits.get(character_id, 0)

    def update_ship_credits(self, character_id: str, credits: int) -> None:
        value = max(0, int(credits))
        self._ship_credits[character_id] = value
        knowledge = self._knowledge_map.get(character_id)
        if knowledge is not None and hasattr(knowledge, "credits"):
            knowledge.credits = value


@pytest.fixture
def make_world(tmp_path):
    def _factory(character_profiles):
        world_dir = tmp_path / f"world-{uuid.uuid4()}"
        world_dir.mkdir()
        corp_manager = CorporationManager(world_dir)

        knowledge_map = {}
        ship_credits = {}
        characters = {}
        for profile in character_profiles:
            char_id = profile["id"]
            knowledge_map[char_id] = MapKnowledge(
                character_id=char_id,
                credits=profile.get("credits", 0),
                credits_in_bank=profile.get("credits_in_bank", 0),
                current_sector=profile.get("sector", 0),
            )
            ship_credits[char_id] = profile.get("credits", 0)
            characters[char_id] = SimpleNamespace(sector=profile.get("sector", 0))

        world = SimpleNamespace(
            corporation_manager=corp_manager,
            knowledge_manager=StubKnowledgeManager(knowledge_map, ship_credits),
            characters=characters,
            character_to_corp={},
        )
        return world, knowledge_map

    return _factory


@pytest.mark.asyncio
async def test_corporation_create_success(make_world, monkeypatch):
    world, knowledge_map = make_world([{"id": "founder", "credits": 20000, "sector": 3}])
    emit_calls = []

    async def _emit(event, payload, **kwargs):
        emit_calls.append((event, payload, kwargs))

    monkeypatch.setattr(corporation_create.event_dispatcher, "emit", _emit)

    response = await corporation_create.handle(
        {"character_id": "founder", "name": "Star Dwellers"}, world
    )

    assert response["success"] is True
    corp_id = response["corp_id"]
    assert world.character_to_corp["founder"] == corp_id
    knowledge = knowledge_map["founder"]
    assert world.knowledge_manager.get_ship_credits("founder") == 10000
    corp_record = world.corporation_manager.load(corp_id)
    assert knowledge.corporation == {
        "corp_id": corp_id,
        "joined_at": corp_record["founded"],
    }

    assert corp_record["members"] == ["founder"]
    assert corp_record["name"] == "Star Dwellers"

    assert emit_calls
    event_name, payload, _ = emit_calls[0]
    assert event_name == "corporation.created"
    assert payload["corp_id"] == corp_id


@pytest.mark.asyncio
async def test_corporation_create_insufficient_credits(make_world, monkeypatch):
    world, _ = make_world([{"id": "poor_founder", "credits": 5000, "sector": 1}])

    async def _should_not_emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not be called")

    monkeypatch.setattr(corporation_create.event_dispatcher, "emit", _should_not_emit)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_create.handle(
            {"character_id": "poor_founder", "name": "Budget Corp"}, world
        )
    assert excinfo.value.status_code == 400
    assert "Insufficient credits" in excinfo.value.detail


@pytest.mark.asyncio
async def test_corporation_create_duplicate_name(make_world, monkeypatch):
    world, knowledge_map = make_world(
        [
            {"id": "alpha", "credits": 20000, "sector": 2},
            {"id": "beta", "credits": 20000, "sector": 5},
        ]
    )

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(corporation_create.event_dispatcher, "emit", _noop)
    await corporation_create.handle({"character_id": "alpha", "name": "Duplicate"}, world)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_create.handle({"character_id": "beta", "name": "Duplicate"}, world)
    assert excinfo.value.status_code == 400
    assert "already taken" in excinfo.value.detail
    assert world.knowledge_manager.get_ship_credits("beta") == 20000


@pytest.mark.asyncio
async def test_corporation_create_already_member(make_world, monkeypatch):
    world, knowledge_map = make_world([{"id": "member", "credits": 20000, "sector": 4}])
    knowledge_map["member"].corporation = {
        "corp_id": "existing",
        "joined_at": "2025-11-01T00:00:00Z",
    }

    async def _should_not_emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not be called")

    monkeypatch.setattr(corporation_create.event_dispatcher, "emit", _should_not_emit)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_create.handle({"character_id": "member", "name": "New Corp"}, world)
    assert excinfo.value.status_code == 400
    assert "Already in a corporation" in excinfo.value.detail
