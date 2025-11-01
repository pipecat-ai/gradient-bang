import uuid
from types import SimpleNamespace

import pytest

from api import corporation_info, corporation_list, my_corporation
from character_knowledge import MapKnowledge
from core.corporation_manager import CorporationManager
from core.ships_manager import ShipsManager


class StubKnowledgeManager:
    def __init__(self, knowledge_map):
        self._knowledge_map = knowledge_map

    def load_knowledge(self, character_id: str) -> MapKnowledge:
        return self._knowledge_map[character_id]

    def save_knowledge(self, knowledge: MapKnowledge) -> None:  # pragma: no cover - not used
        self._knowledge_map[knowledge.character_id] = knowledge


@pytest.fixture
def make_world(tmp_path):
    def _factory(character_profiles):
        world_dir = tmp_path / f"world-{uuid.uuid4()}"
        world_dir.mkdir()
        corp_manager = CorporationManager(world_dir)
        ships_manager = ShipsManager(world_dir)

        knowledge_map: dict[str, MapKnowledge] = {}
        characters: dict[str, SimpleNamespace] = {}
        for profile in character_profiles:
            char_id = profile["id"]
            knowledge_map[char_id] = MapKnowledge(
                character_id=char_id,
                current_sector=profile.get("sector", 0),
            )
            characters[char_id] = SimpleNamespace(
                sector=profile.get("sector", 0),
                name=profile.get("name", char_id),
            )

        world = SimpleNamespace(
            corporation_manager=corp_manager,
            knowledge_manager=StubKnowledgeManager(knowledge_map),
            characters=characters,
            character_to_corp={},
            ships_manager=ships_manager,
        )
        return world, knowledge_map

    return _factory


@pytest.mark.asyncio
async def test_corporation_info_as_member_includes_private_fields(make_world):
    world, knowledge_map = make_world(
        [
            {"id": "founder", "name": "Founder"},
            {"id": "member", "name": "Member"},
            {"id": "viewer", "name": "Viewer"},
        ]
    )

    corp = world.corporation_manager.create("Star Syndicate", "founder")
    corp_id = corp["corp_id"]
    world.character_to_corp["founder"] = corp_id

    knowledge_map["founder"].corporation = {
        "corp_id": corp_id,
        "joined_at": "2025-10-31T00:00:00Z",
    }

    world.corporation_manager.add_member(corp_id, "member")
    world.character_to_corp["member"] = corp_id
    knowledge_map["member"].corporation = {
        "corp_id": corp_id,
        "joined_at": "2025-10-31T00:05:00Z",
    }

    ship_id = world.ships_manager.create_ship(
        ship_type="kestrel_courier",
        sector=7,
        owner_type="corporation",
        owner_id=corp_id,
        name="Syndicate Scout",
    )
    world.corporation_manager.add_ship(corp_id, ship_id)

    response = await corporation_info.handle(
        {"character_id": "founder", "corp_id": corp_id},
        world,
    )

    assert response["success"] is True
    assert response["corp_id"] == corp_id
    assert response["founder_id"] == "founder"
    assert response["invite_code"] == corp["invite_code"]
    assert any(member["character_id"] == "member" for member in response["members"])
    assert response["member_count"] == 2
    assert response["ships"][0]["ship_id"] == ship_id
    assert response["ships"][0]["sector"] == 7


@pytest.mark.asyncio
async def test_corporation_info_as_non_member_returns_public_summary(make_world):
    world, _ = make_world(
        [
            {"id": "founder", "name": "Founder"},
            {"id": "viewer", "name": "Viewer"},
        ]
    )

    corp = world.corporation_manager.create("Public Corp", "founder")
    corp_id = corp["corp_id"]
    world.character_to_corp["founder"] = corp_id

    response = await corporation_info.handle(
        {"character_id": "viewer", "corp_id": corp_id},
        world,
    )

    assert response["success"] is True
    assert response["corp_id"] == corp_id
    assert "invite_code" not in response
    assert "members" not in response
    assert response["member_count"] == 1


@pytest.mark.asyncio
async def test_corporation_list_sorted_by_member_count(make_world):
    world, _ = make_world(
        [
            {"id": "alpha", "name": "Alpha"},
            {"id": "beta", "name": "Beta"},
            {"id": "gamma", "name": "Gamma"},
        ]
    )

    corp_a = world.corporation_manager.create("Corp A", "alpha")
    corp_b = world.corporation_manager.create("Corp B", "gamma")
    world.corporation_manager.add_member(corp_a["corp_id"], "beta")

    response = await corporation_list.handle({}, world)

    assert response["success"] is True
    corp_ids = [corp["corp_id"] for corp in response["corporations"]]
    assert corp_ids[0] == corp_a["corp_id"]
    assert response["corporations"][0]["member_count"] == 2
    assert response["corporations"][1]["member_count"] == 1


@pytest.mark.asyncio
async def test_my_corporation_returns_membership_details(make_world):
    world, knowledge_map = make_world(
        [
            {"id": "member", "name": "Member"},
            {"id": "outsider", "name": "Outsider"},
        ]
    )

    corp = world.corporation_manager.create("Inner Circle", "member")
    corp_id = corp["corp_id"]
    world.character_to_corp["member"] = corp_id
    knowledge_map["member"].corporation = {
        "corp_id": corp_id,
        "joined_at": "2025-10-31T00:00:00Z",
    }

    response = await my_corporation.handle({"character_id": "member"}, world)

    assert response["success"] is True
    corp_payload = response["corporation"]
    assert corp_payload["corp_id"] == corp_id
    assert corp_payload["joined_at"] == "2025-10-31T00:00:00Z"
    assert corp_payload["member_count"] == 1
    assert corp_payload["members"][0]["name"] == "Member"


@pytest.mark.asyncio
async def test_my_corporation_returns_none_for_non_member(make_world):
    world, _ = make_world(
        [
            {"id": "loner", "name": "Loner"},
        ]
    )

    response = await my_corporation.handle({"character_id": "loner"}, world)

    assert response["success"] is True
    assert response["corporation"] is None
