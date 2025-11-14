from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from gradientbang.game_server.character_knowledge import CharacterKnowledgeManager, MapKnowledge
from gradientbang.game_server.core.credits import transfer_credits_to_bank
from gradientbang.game_server.core.ships_manager import ShipsManager


@dataclass
class DummyCharacter:
    character_id: str
    name: str
    sector: int = 0
    in_hyperspace: bool = False


class DummyCorporationManager:
    def __init__(self, members_by_corp: dict[str, set[str]]) -> None:
        self._members_by_corp = members_by_corp

    def is_member(self, corp_id: str, character_id: str) -> bool:
        return character_id in self._members_by_corp.get(corp_id, set())


def _build_world(tmp_path, *, characters: dict[str, DummyCharacter], corp_members: dict[str, set[str]] | None = None):
    world_dir = tmp_path / "world"
    world_dir.mkdir()
    ships_manager = ShipsManager(world_dir)
    knowledge_manager = CharacterKnowledgeManager(world_dir / "character-map-knowledge")
    knowledge_manager.set_ships_manager(ships_manager)

    corp_lookup: dict[str, str] = {}
    if corp_members:
        for corp_id, members in corp_members.items():
            for member_id in members:
                corp_lookup[member_id] = corp_id

    for character_id in characters:
        knowledge = knowledge_manager.load_knowledge(character_id)
        knowledge.credits_in_bank = 0
        if character_id in corp_lookup:
            knowledge.corporation = {"corp_id": corp_lookup[character_id]}
        else:
            knowledge.corporation = None
        knowledge_manager.save_knowledge(knowledge)

    world = SimpleNamespace(
        characters={cid: char for cid, char in characters.items()},
        character_registry=None,
        knowledge_manager=knowledge_manager,
        ships_manager=ships_manager,
        corporation_manager=DummyCorporationManager(corp_members or {}),
        character_to_corp=corp_lookup.copy(),
    )
    return world, ships_manager, knowledge_manager


def _personal_ship(world, ships_manager, knowledge_manager, character_id: str, *, sector: int = 0, credits: int = 0) -> str:
    knowledge = knowledge_manager.load_knowledge(character_id)
    knowledge.current_sector = sector
    knowledge_manager.save_knowledge(knowledge)
    ship_id = ships_manager.create_ship(
        ship_type="sparrow_scout",
        sector=sector,
        owner_type="character",
        owner_id=character_id,
        name=None,
    )
    knowledge.current_ship_id = ship_id
    knowledge_manager.save_knowledge(knowledge)
    ships_manager.update_ship_state(ship_id, credits=credits)
    return ship_id


def _corp_ship(world, ships_manager, *, corp_id: str, sector: int = 0, credits: int = 0) -> str:
    ship_id = ships_manager.create_ship(
        ship_type="sparrow_scout",
        sector=sector,
        owner_type="corporation",
        owner_id=corp_id,
        name=None,
    )
    ships_manager.update_ship_state(ship_id, credits=credits)
    return ship_id


def _bank_balance(knowledge_manager, character_id: str) -> int:
    knowledge = knowledge_manager.load_knowledge(character_id)
    return knowledge.credits_in_bank


def _ship_credits(ships_manager, ship_id: str) -> int:
    ship = ships_manager.get_ship(ship_id)
    return int(ship["state"]["credits"])


def test_personal_ship_deposit_to_owner(tmp_path):
    """Depositing from a personal ship should reduce hull credits and raise bank balance."""
    characters = {"trader": DummyCharacter("trader", name="Trader")}
    world, ships_manager, knowledge_manager = _build_world(tmp_path, characters=characters)
    ship_id = _personal_ship(world, ships_manager, knowledge_manager, "trader", credits=600)

    result = transfer_credits_to_bank(
        world,
        ships_manager,
        amount=250,
        source_ship_id=ship_id,
        target_player_name="Trader",
    )

    assert _ship_credits(ships_manager, ship_id) == 350
    assert _bank_balance(knowledge_manager, "trader") == 250
    assert result["source_ship_id"] == ship_id
    assert result["target_character_id"] == "trader"


def test_personal_ship_cannot_deposit_to_other_player(tmp_path):
    characters = {
        "giver": DummyCharacter("giver", name="Giver"),
        "receiver": DummyCharacter("receiver", name="Receiver"),
    }
    world, ships_manager, knowledge_manager = _build_world(tmp_path, characters=characters)
    ship_id = _personal_ship(world, ships_manager, knowledge_manager, "giver", credits=400)

    with pytest.raises(HTTPException) as excinfo:
        transfer_credits_to_bank(
            world,
            ships_manager,
            amount=100,
            source_ship_id=ship_id,
            target_player_name="Receiver",
        )

    assert excinfo.value.status_code == 403
    assert _ship_credits(ships_manager, ship_id) == 400
    assert _bank_balance(knowledge_manager, "receiver") == 0


def test_personal_ship_can_deposit_to_corp_member(tmp_path):
    characters = {
        "giver": DummyCharacter("giver", name="Giver"),
        "ally": DummyCharacter("ally", name="Ally"),
    }
    corp_members = {"corp-1": {"giver", "ally"}}
    world, ships_manager, knowledge_manager = _build_world(
        tmp_path,
        characters=characters,
        corp_members=corp_members,
    )
    ship_id = _personal_ship(world, ships_manager, knowledge_manager, "giver", credits=900)

    result = transfer_credits_to_bank(
        world,
        ships_manager,
        amount=300,
        source_ship_id=ship_id,
        target_player_name="Ally",
    )

    assert _ship_credits(ships_manager, ship_id) == 600
    assert _bank_balance(knowledge_manager, "ally") == 300
    assert result["source_character_id"] == "giver"

def test_character_id_deposit_uses_active_ship(tmp_path):
    characters = {"pilot": DummyCharacter("pilot", name="Pilot")}
    world, ships_manager, knowledge_manager = _build_world(tmp_path, characters=characters)
    ship_id = _personal_ship(world, ships_manager, knowledge_manager, "pilot", credits=800)

    result = transfer_credits_to_bank(
        world,
        ships_manager,
        amount=200,
        source_character_id="pilot",
        target_player_name="Pilot",
    )

    assert result["source_ship_id"] == ship_id
    assert _ship_credits(ships_manager, ship_id) == 600
    assert _bank_balance(knowledge_manager, "pilot") == 200


def test_deposit_rejects_insufficient_ship_credits(tmp_path):
    characters = {"pilot": DummyCharacter("pilot", name="Pilot")}
    world, ships_manager, knowledge_manager = _build_world(tmp_path, characters=characters)
    ship_id = _personal_ship(world, ships_manager, knowledge_manager, "pilot", credits=50)

    with pytest.raises(ValueError, match="Insufficient credits"):
        transfer_credits_to_bank(
            world,
            ships_manager,
            amount=75,
            source_ship_id=ship_id,
            target_player_name="Pilot",
        )

    assert _ship_credits(ships_manager, ship_id) == 50
    assert _bank_balance(knowledge_manager, "pilot") == 0


def test_corporation_ship_deposit_to_member(tmp_path):
    characters = {
        "member": DummyCharacter("member", name="Member"),
    }
    corp_members = {"corp-1": {"member"}}
    world, ships_manager, knowledge_manager = _build_world(tmp_path, characters=characters, corp_members=corp_members)
    ship_id = _corp_ship(world, ships_manager, corp_id="corp-1", credits=1_000)

    transfer_credits_to_bank(
        world,
        ships_manager,
        amount=400,
        source_ship_id=ship_id,
        target_player_name="Member",
    )

    assert _ship_credits(ships_manager, ship_id) == 600
    assert _bank_balance(knowledge_manager, "member") == 400


def test_corporation_ship_cannot_deposit_to_non_member(tmp_path):
    characters = {
        "outsider": DummyCharacter("outsider", name="Outsider"),
    }
    corp_members = {"corp-1": set()}  # outsider not a member
    world, ships_manager, knowledge_manager = _build_world(tmp_path, characters=characters, corp_members=corp_members)
    ship_id = _corp_ship(world, ships_manager, corp_id="corp-1", credits=500)

    with pytest.raises(HTTPException) as excinfo:
        transfer_credits_to_bank(
            world,
            ships_manager,
            amount=100,
            source_ship_id=ship_id,
            target_player_name="Outsider",
        )

    assert excinfo.value.status_code == 403
    assert _ship_credits(ships_manager, ship_id) == 500
    assert _bank_balance(knowledge_manager, "outsider") == 0


def test_deposit_fails_if_display_name_ambiguous(tmp_path):
    characters = {
        "dup_a": DummyCharacter("dup_a", name="Dup"),
        "dup_b": DummyCharacter("dup_b", name="Dup"),
    }
    world, ships_manager, knowledge_manager = _build_world(tmp_path, characters=characters)
    ship_id = _personal_ship(world, ships_manager, knowledge_manager, "dup_a", credits=300)

    with pytest.raises(HTTPException) as excinfo:
        transfer_credits_to_bank(
            world,
            ships_manager,
            amount=100,
            source_ship_id=ship_id,
            target_player_name="Dup",
        )

    assert excinfo.value.status_code == 400
    assert "Multiple players named" in excinfo.value.detail
    assert _ship_credits(ships_manager, ship_id) == 300
    assert _bank_balance(knowledge_manager, "dup_a") == 0
    assert _bank_balance(knowledge_manager, "dup_b") == 0
