from types import SimpleNamespace
from datetime import datetime, timezone

import pytest

from gradientbang.game_server.core.character_registry import CharacterRegistry, CharacterProfile
from gradientbang.game_server.core.world import Character
from gradientbang.game_server.core.ships_manager import ShipsManager
from gradientbang.game_server.core.corporation_manager import CorporationManager
from gradientbang.game_server.character_knowledge import CharacterKnowledgeManager
from gradientbang.game_server.api import character_create, character_modify, character_delete, character_info


@pytest.fixture
def world(tmp_path):
    world_data_dir = tmp_path / "world-data"
    ships_manager = ShipsManager(world_data_dir)

    registry = CharacterRegistry(tmp_path / "characters.json")
    registry.load()
    registry.set_admin_password("secret")
    knowledge_manager = CharacterKnowledgeManager(data_dir=world_data_dir / "character-map-knowledge")
    knowledge_manager.set_ships_manager(ships_manager)
    corporation_manager = CorporationManager(world_data_dir)
    return SimpleNamespace(
        knowledge_manager=knowledge_manager,
        ships_manager=ships_manager,
        character_registry=registry,
        corporation_manager=corporation_manager,
        character_to_corp={},
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


@pytest.mark.asyncio
async def test_character_delete_cleans_corporation_membership(world):
    character_id = "test-delete-member"

    world.character_registry.add_or_update(
        CharacterProfile(character_id=character_id, name="Corp Member", player={}, ship={})
    )

    world.characters[character_id] = Character(character_id, name="Corp Member")
    knowledge = world.knowledge_manager.load_knowledge(character_id)

    corp = world.corporation_manager.create("Unit Test Corp", character_id)
    knowledge.corporation = {
        "corp_id": corp["corp_id"],
        "joined_at": datetime.now(timezone.utc).isoformat(),
    }
    world.knowledge_manager.save_knowledge(knowledge)
    world.character_to_corp[character_id] = corp["corp_id"]

    corp_ship_id = world.ships_manager.create_ship(
        ship_type="kestrel_courier",
        sector=0,
        owner_type="corporation",
        owner_id=corp["corp_id"],
        name="Corp Ship",
    )
    world.corporation_manager.add_ship(corp["corp_id"], corp_ship_id)

    delete_result = await character_delete.handle(
        {
            "admin_password": "secret",
            "character_id": character_id,
        },
        world,
    )

    assert delete_result["success"] is True
    assert world.character_registry.get_profile(character_id) is None
    assert character_id not in world.character_to_corp
    with pytest.raises(FileNotFoundError):
        world.corporation_manager.load(corp["corp_id"])

    ship_record = world.ships_manager.get_ship(corp_ship_id)
    assert ship_record.get("owner_type") == "unowned"
    assert ship_record.get("former_owner_name") == "Unit Test Corp"

    assert not world.knowledge_manager.get_file_path(character_id).exists()


@pytest.mark.asyncio
async def test_character_info(world):
    """Test character_info endpoint returns character information without requiring admin password."""
    # Create a character first
    create_result = await character_create.handle(
        {
            "admin_password": "secret",
            "name": "Info Test Pilot",
            "player": {"credits": 5000},
            "ship": {"ship_name": "Test Ship"},
        },
        world,
    )

    assert create_result["success"] is True
    character_id = create_result["character_id"]

    # Now test character_info (should NOT require admin password)
    info_result = await character_info.handle(
        {
            "character_id": character_id,
        },
        world,
    )

    assert info_result["success"] is True
    assert info_result["character_id"] == character_id
    assert info_result["name"] == "Info Test Pilot"
    assert "created_at" in info_result
    assert "updated_at" in info_result


@pytest.mark.asyncio
async def test_character_info_not_found(world):
    """Test character_info returns 404 for non-existent character."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await character_info.handle(
            {
                "character_id": "non-existent-id",
            },
            world,
        )

    assert exc_info.value.status_code == 404
    assert "not found" in exc_info.value.detail.lower()
