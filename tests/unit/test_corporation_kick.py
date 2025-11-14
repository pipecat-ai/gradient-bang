import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from gradientbang.game_server.api import corporation_kick
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
    def _factory(characters, corp_members):
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

        founder = corp_members[0]
        corp = corp_manager.create("Nova Assembly", founder)
        corp["members"] = list(corp_members)
        corp_manager.save(corp["corp_id"], corp)

        for member in corp_members:
            world.character_to_corp[member] = corp["corp_id"]
            if member in knowledge_map:
                knowledge_map[member].corporation = {
                    "corp_id": corp["corp_id"],
                    "joined_at": "2025-11-01T00:00:00Z",
                }

        return world, knowledge_map, corp

    return _factory


@pytest.mark.asyncio
async def test_kick_success(build_world, monkeypatch):
    world, knowledge_map, corp = build_world(
        [
            {"id": "leader", "credits": 8000, "sector": 4},
            {"id": "member", "credits": 3000, "sector": 6},
        ],
        corp_members=["leader", "member"],
    )
    events = []

    async def _emit(event, payload, kwargs):
        events.append((event, payload, kwargs))

    async def _emit_wrapper(event, payload, **kwargs):
        events.append((event, payload, kwargs))

    monkeypatch.setattr(corporation_kick.event_dispatcher, "emit", _emit_wrapper)

    response = await corporation_kick.handle(
        {"character_id": "leader", "target_id": "member"}, world
    )

    assert response["success"] is True
    assert knowledge_map["member"].corporation is None
    assert "member" not in world.character_to_corp

    updated = world.corporation_manager.load(corp["corp_id"])
    assert updated["members"] == ["leader"]

    assert any(event == "corporation.member_kicked" for event, _, _ in events)


@pytest.mark.asyncio
async def test_kick_non_member_target(build_world, monkeypatch):
    world, knowledge_map, corp = build_world(
        [
            {"id": "leader", "credits": 8000, "sector": 4},
            {"id": "member", "credits": 3000, "sector": 6},
            {"id": "outsider", "credits": 1000, "sector": 1},
        ],
        corp_members=["leader", "member"],
    )
    knowledge_map["outsider"].corporation = None
    monkeypatch.setattr(corporation_kick.event_dispatcher, "emit", pytest.fail)

    with pytest.raises(HTTPException) as excinfo:
        await corporation_kick.handle(
            {"character_id": "leader", "target_id": "outsider"}, world
        )
    assert excinfo.value.status_code == 400
    assert "Target is not in your corporation" in excinfo.value.detail
