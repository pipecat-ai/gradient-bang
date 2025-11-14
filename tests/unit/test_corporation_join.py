import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from gradientbang.game_server.api import corporation_join
from gradientbang.game_server.character_knowledge import MapKnowledge
from gradientbang.game_server.core.corporation_manager import CorporationManager


class StubKnowledgeManager:
    def __init__(self, knowledge_map):
        self._knowledge_map = knowledge_map

    def load_knowledge(self, character_id: str) -> MapKnowledge:
        return self._knowledge_map[character_id]

    def save_knowledge(self, knowledge: MapKnowledge) -> None:
        self._knowledge_map[knowledge.character_id] = knowledge


@pytest.fixture
def build_world(tmp_path):
    def _factory(characters, corp_seed=None):
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

        corp = None
        if corp_seed:
            corp = corp_manager.create(corp_seed["name"], corp_seed["founder"])
        return world, knowledge_map, corp

    return _factory


@pytest.mark.asyncio
async def test_join_success(build_world, monkeypatch):
    world, knowledge_map, corp = build_world(
        [{"id": "founder", "credits": 20000, "sector": 2}, {"id": "joiner", "credits": 5000, "sector": 5}],
        corp_seed={"name": "Explorer League", "founder": "founder"},
    )
    invite_code = corp["invite_code"]

    emit_calls = []

    async def _emit(event, payload, **kwargs):
        emit_calls.append((event, payload, kwargs))

    monkeypatch.setattr(corporation_join.event_dispatcher, "emit", _emit)

    response = await corporation_join.handle(
        {"character_id": "joiner", "corp_id": corp["corp_id"], "invite_code": invite_code},
        world,
    )

    assert response["success"] is True
    assert response["corp_id"] == corp["corp_id"]
    assert response["member_count"] == 2
    assert world.character_to_corp["joiner"] == corp["corp_id"]

    knowledge = knowledge_map["joiner"]
    assert knowledge.corporation["corp_id"] == corp["corp_id"]
    assert knowledge.corporation["joined_at"]

    updated_corp = world.corporation_manager.load(corp["corp_id"])
    assert set(updated_corp["members"]) == {"founder", "joiner"}

    assert emit_calls
    event, payload, kwargs = emit_calls[0]
    assert event == "corporation.member_joined"
    assert payload["member_id"] == "joiner"
    assert "joiner" in kwargs["character_filter"]


@pytest.mark.asyncio
async def test_join_invalid_invite(build_world, monkeypatch):
    world, _, corp = build_world(
        [{"id": "founder", "credits": 20000, "sector": 2}, {"id": "joiner", "credits": 5000, "sector": 5}],
        corp_seed={"name": "Explorer League", "founder": "founder"},
    )

    async def _should_not_emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not be called")

    monkeypatch.setattr(corporation_join.event_dispatcher, "emit", _should_not_emit)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_join.handle(
            {"character_id": "joiner", "corp_id": corp["corp_id"], "invite_code": "bad-code"},
            world,
        )
    assert excinfo.value.status_code == 400
    assert "Invalid invite code" in excinfo.value.detail


@pytest.mark.asyncio
async def test_join_when_already_member(build_world, monkeypatch):
    world, knowledge_map, corp = build_world(
        [{"id": "founder", "credits": 20000, "sector": 2}, {"id": "joiner", "credits": 5000, "sector": 5}],
        corp_seed={"name": "Explorer League", "founder": "founder"},
    )
    knowledge_map["joiner"].corporation = {"corp_id": "existing", "joined_at": "2025-11-01T00:00:00Z"}

    async def _should_not_emit(*args, **kwargs):
        pytest.fail("event_dispatcher.emit should not be called")

    monkeypatch.setattr(corporation_join.event_dispatcher, "emit", _should_not_emit)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_join.handle(
            {"character_id": "joiner", "corp_id": corp["corp_id"], "invite_code": corp["invite_code"]},
            world,
        )
    assert excinfo.value.status_code == 400
    assert "Already in a corporation" in excinfo.value.detail
