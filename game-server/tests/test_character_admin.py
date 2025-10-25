from types import SimpleNamespace

import pytest

from core.character_registry import CharacterRegistry
from core.world import Character
from character_knowledge import CharacterKnowledgeManager
from api import character_create, character_modify, character_delete


@pytest.fixture
def world(tmp_path):
    registry = CharacterRegistry(tmp_path / "characters.json")
    registry.load()
    registry.set_admin_password("secret")
    knowledge_manager = CharacterKnowledgeManager(data_dir=tmp_path / "character-map-knowledge")
    return SimpleNamespace(
        knowledge_manager=knowledge_manager,
        character_registry=registry,
        characters={},
    )


@pytest.mark.asyncio
async def test_character_create_and_modify(world):
    create_result = await character_create.handle(
        {
            "admin_password": "secret",
            "name": "Test Pilot",
            "player": {"credits": 2500},
            "ship": {"ship_name": "Voyager"},
        },
        world,
    )

    assert create_result["success"] is True
    character_id = create_result["character_id"]
    profile = world.character_registry.get_profile(character_id)
    assert profile is not None
    assert profile.name == "Test Pilot"

    # Simulate active character to verify name update during modify
    world.characters[character_id] = Character(character_id, name="Test Pilot")

    modify_result = await character_modify.handle(
        {
            "admin_password": "secret",
            "character_id": character_id,
            "name": "Captain Nova",
            "player": {"credits": 3000},
            "ship": {"ship_name": "Explorer"},
        },
        world,
    )

    assert modify_result["success"] is True
    assert modify_result["name"] == "Captain Nova"
    assert world.characters[character_id].name == "Captain Nova"


@pytest.mark.asyncio
async def test_character_delete(world):
    create_result = await character_create.handle(
        {
            "admin_password": "secret",
            "name": "Delete Me",
        },
        world,
    )
    character_id = create_result["character_id"]

    delete_result = await character_delete.handle(
        {
            "admin_password": "secret",
            "character_id": character_id,
        },
        world,
    )

    assert delete_result["success"] is True
    assert world.character_registry.get_profile(character_id) is None
