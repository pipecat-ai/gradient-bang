import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api import corporation_regenerate_invite_code
from character_knowledge import MapKnowledge
from core.corporation_manager import CorporationManager


class StubKnowledgeManager:
    def __init__(self, knowledge_map):
        self._knowledge_map = knowledge_map

    def load_knowledge(self, character_id: str) -> MapKnowledge:
        return self._knowledge_map[character_id]

    def save_knowledge(self, knowledge: MapKnowledge) -> None:
        self._knowledge_map[knowledge.character_id] = knowledge


@pytest.fixture
def build_world(tmp_path):
    def _factory(characters):
        world_dir = tmp_path / f"world-{uuid.uuid4()}"
        world_dir.mkdir()
        corp_manager = CorporationManager(world_dir)

        knowledge_map = {}
        character_objs = {}
        for char in characters:
            char_id = char["id"]
            knowledge_map[char_id] = MapKnowledge(
                character_id=char_id,
                credits=char.get("credits", 0),
                current_sector=char.get("sector", 0),
                corporation=char.get("corporation"),
            )
            character_objs[char_id] = SimpleNamespace(
                sector=char.get("sector", 0),
                name=char.get("name", char_id),
            )

        world = SimpleNamespace(
            corporation_manager=corp_manager,
            knowledge_manager=StubKnowledgeManager(knowledge_map),
            characters=character_objs,
            character_to_corp={},
        )
        return world, knowledge_map

    return _factory


@pytest.mark.asyncio
async def test_regenerate_invite_success(build_world, monkeypatch):
    world, knowledge_map = build_world(
        [
            {
                "id": "founder",
                "credits": 20000,
                "sector": 4,
                "corporation": {"corp_id": "temp", "joined_at": "2025-11-01T00:00:00Z"},
            }
        ]
    )
    corp = world.corporation_manager.create("Delta Fleet", "founder")
    knowledge_map["founder"].corporation["corp_id"] = corp["corp_id"]
    world.character_to_corp["founder"] = corp["corp_id"]

    emit_calls = []

    async def _emit(event, payload, **kwargs):
        emit_calls.append((event, payload, kwargs))

    monkeypatch.setattr(corporation_regenerate_invite_code.event_dispatcher, "emit", _emit)

    response = await corporation_regenerate_invite_code.handle(
        {"character_id": "founder"}, world
    )

    assert response["success"] is True
    new_code = response["new_invite_code"]
    assert new_code and new_code != corp["invite_code"]

    updated = world.corporation_manager.load(corp["corp_id"])
    assert updated["invite_code"] == new_code
    assert emit_calls
    event, payload, kwargs = emit_calls[0]
    assert event == "corporation.invite_code_regenerated"
    assert payload["new_invite_code"] == new_code
    assert "founder" in kwargs["character_filter"]


@pytest.mark.asyncio
async def test_regenerate_invite_non_member(build_world, monkeypatch):
    world, knowledge_map = build_world(
        [
            {
                "id": "outsider",
                "credits": 5000,
                "sector": 1,
                "corporation": None,
            }
        ]
    )

    async def _should_not_emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not be called")

    monkeypatch.setattr(corporation_regenerate_invite_code.event_dispatcher, "emit", _should_not_emit)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_regenerate_invite_code.handle({"character_id": "outsider"}, world)
    assert excinfo.value.status_code == 400
    assert "Not in a corporation" in excinfo.value.detail
