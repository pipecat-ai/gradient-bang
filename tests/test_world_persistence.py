import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).parent.parent
GAME_SERVER_ROOT = REPO_ROOT / "game-server"

import sys

if str(GAME_SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(GAME_SERVER_ROOT))

from character_knowledge import (
    CharacterKnowledgeManager,
    MapKnowledge,
)
from fastapi import HTTPException
from combat.models import (
    CombatEncounter,
    CombatRoundOutcome,
    CombatantAction,
    CombatantState,
    RoundAction,
)
from core.world import GameWorld
from ships import ShipType
import server
from api.utils import sector_contents
from api.combat_initiate import handle as combat_initiate_handle
from api.combat_leave_fighters import handle as leave_fighters_handle
from api.join import handle as join_handle
from api.combat_action import handle as combat_action_handle


@pytest.fixture()
def hydrated_world(monkeypatch, tmp_path):
    """Provide an isolated GameWorld hydrated from persisted knowledge."""

    source_world_data = Path(__file__).parent / "test-world-data"
    temp_world_data = tmp_path / "world-data"
    shutil.copytree(source_world_data, temp_world_data)

    knowledge_dir = temp_world_data / "character-map-knowledge"
    knowledge_manager = CharacterKnowledgeManager(data_dir=knowledge_dir)

    timestamp = datetime.now(timezone.utc).isoformat()

    def seed_knowledge(character_id: str, sector: int, fighters: int, shields: int) -> None:
        knowledge = MapKnowledge(character_id=character_id)
        knowledge.ship_config.ship_type = ShipType.KESTREL_COURIER.value
        knowledge.ship_config.current_fighters = fighters
        knowledge.ship_config.current_shields = shields
        knowledge.ship_config.current_warp_power = 250
        knowledge.current_sector = sector
        knowledge.last_update = timestamp
        knowledge_manager.save_knowledge(knowledge)

    seed_knowledge("khk_aggressive", 5, fighters=123, shields=91)
    seed_knowledge("khk_passive", 5, fighters=150, shields=120)

    monkeypatch.setenv("WORLD_DATA_DIR", str(temp_world_data))

    test_world = GameWorld()
    test_world.load_data()

    # Ensure server-global world references point at the isolated world instance.
    import core.world as world_module

    monkeypatch.setattr(world_module, "world", test_world)
    monkeypatch.setattr(server, "world", test_world)

    yield test_world, temp_world_data


def test_preloaded_characters_visible_after_restart(hydrated_world):
    world, _ = hydrated_world

    assert "khk_aggressive" in world.characters
    assert "khk_passive" in world.characters

    aggressive = world.characters["khk_aggressive"]
    passive = world.characters["khk_passive"]

    assert aggressive.sector == 5
    assert passive.sector == 5
    assert aggressive.fighters == 123
    assert passive.fighters == 150

    contents = sector_contents(world, 5, current_character_id="khk_aggressive")
    other_names = {entry["name"] for entry in contents.get("other_players", [])}
    assert "khk_passive" in other_names


@pytest.mark.asyncio
async def test_combat_round_updates_persisted_ship_state(hydrated_world):
    world, temp_world_data = hydrated_world

    encounter = CombatEncounter(
        combat_id="test-combat",
        sector_id=5,
        participants={
            "attacker": CombatantState(
                combatant_id="khk_aggressive",
                combatant_type="character",
                name="khk_aggressive",
                fighters=80,
                shields=55,
                turns_per_warp=3,
                max_fighters=300,
                max_shields=150,
                owner_character_id="khk_aggressive",
            ),
            "defender": CombatantState(
                combatant_id="khk_passive",
                combatant_type="character",
                name="khk_passive",
                fighters=175,
                shields=120,
                turns_per_warp=3,
                max_fighters=300,
                max_shields=150,
                owner_character_id="khk_passive",
            ),
        },
    )

    outcome = CombatRoundOutcome(
        round_number=1,
        hits={"attacker": 10, "defender": 0},
        offensive_losses={"attacker": 40, "defender": 0},
        defensive_losses={"attacker": 0, "defender": 10},
        shield_loss={"attacker": 5, "defender": 25},
        fighters_remaining={"attacker": 80, "defender": 175},
        shields_remaining={"attacker": 55, "defender": 125},
        flee_results={"attacker": False, "defender": False},
        end_state=None,
        effective_actions={
            "attacker": RoundAction(
                action=CombatantAction.ATTACK,
                commit=200,
                target_id="khk_passive",
            ),
            "defender": RoundAction(action=CombatantAction.BRACE, commit=0, target_id=None),
        },
    )

    await server._combat_round_resolved(encounter, outcome)

    knowledge = world.knowledge_manager.load_knowledge("khk_aggressive")
    assert knowledge.ship_config.current_fighters == 80
    assert knowledge.ship_config.current_shields == 55

    character = world.characters["khk_aggressive"]
    assert character.fighters == 80
    assert character.shields == 55

    # Reload a fresh world instance from disk to confirm persistence.
    fresh_world = GameWorld()
    fresh_world.load_data()
    rehydrated = fresh_world.characters["khk_aggressive"]
    assert rehydrated.fighters == 80
    assert rehydrated.shields == 55


@pytest.mark.asyncio
async def test_sector_wide_combat_initiation(monkeypatch, hydrated_world):
    world, _ = hydrated_world

    async def _noop_emit(*args, **kwargs):  # pragma: no cover - test stub
        return None

    monkeypatch.setattr(server.event_dispatcher, "emit", _noop_emit)

    result = await combat_initiate_handle({"character_id": "khk_aggressive"}, world)
    participants = set(result.get("participants", {}).keys())
    assert "khk_aggressive" in participants
    assert "khk_passive" in participants

    # Second participant should join existing encounter without error.
    result_again = await combat_initiate_handle({"character_id": "khk_passive"}, world)
    assert result_again["combat_id"] == result["combat_id"]


@pytest.mark.asyncio
async def test_place_fighters_rejects_existing_garrison(hydrated_world):
    world, _ = hydrated_world

    if world.garrisons is None:
        pytest.skip("Garrison system unavailable")

    world.garrisons.deploy(
        sector_id=5,
        owner_id="khk_passive",
        fighters=25,
        mode="offensive",
    )

    with pytest.raises(HTTPException) as exc:
        await leave_fighters_handle(
            {
                "character_id": "khk_aggressive",
                "sector": 5,
                "quantity": 10,
                "mode": "offensive",
            },
            world,
        )

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_auto_engage_on_offensive_garrison(monkeypatch, hydrated_world):
    world, _ = hydrated_world

    if world.garrisons is None or world.combat_manager is None:
        pytest.skip("Required subsystems unavailable")

    async def noop_event(*args, **kwargs):  # pragma: no cover - test stub
        return None

    monkeypatch.setattr(server.event_dispatcher, "emit", noop_event)

    world.garrisons.deploy(
        sector_id=5,
        owner_id="khk_passive",
        fighters=40,
        mode="offensive",
    )

    newcomer = "khk_third"
    world.knowledge_manager.initialize_ship(newcomer, ShipType.KESTREL_COURIER)
    knowledge = world.knowledge_manager.load_knowledge(newcomer)
    knowledge.current_sector = 5
    world.knowledge_manager.save_knowledge(knowledge)
    world.characters.pop(newcomer, None)

    await join_handle({"character_id": newcomer, "sector": 5}, world)

    encounter = await world.combat_manager.find_encounter_in_sector(5)
    assert encounter is not None
    participants = set(encounter.participants.keys())
    assert newcomer in participants
    assert any(pid.startswith("garrison:") for pid in participants)


@pytest.mark.asyncio
async def test_combat_flee_requires_destination(hydrated_world):
    world, _ = hydrated_world

    if world.combat_manager is None:
        pytest.skip("Combat manager unavailable")

    encounter = CombatEncounter(
        combat_id="test-flee-missing-destination",
        sector_id=5,
        participants={
            "khk_aggressive": CombatantState(
                combatant_id="khk_aggressive",
                combatant_type="character",
                name="khk_aggressive",
                fighters=80,
                shields=55,
                turns_per_warp=3,
                max_fighters=300,
                max_shields=150,
                owner_character_id="khk_aggressive",
            ),
            "khk_passive": CombatantState(
                combatant_id="khk_passive",
                combatant_type="character",
                name="khk_passive",
                fighters=175,
                shields=120,
                turns_per_warp=3,
                max_fighters=300,
                max_shields=150,
                owner_character_id="khk_passive",
            ),
        },
    )

    await world.combat_manager.start_encounter(encounter, emit_waiting=False)

    with pytest.raises(HTTPException) as exc:
        await combat_action_handle(
            {
                "character_id": "khk_aggressive",
                "combat_id": encounter.combat_id,
                "action": "flee",
            },
            world,
        )
    assert exc.value.status_code == 400
    assert "destination" in exc.value.detail.lower()

    await world.combat_manager.cancel_encounter(encounter.combat_id)


@pytest.mark.asyncio
async def test_successful_flee_moves_character(monkeypatch, hydrated_world):
    world, _ = hydrated_world

    async def _noop_emit(*_args, **_kwargs):  # pragma: no cover - stub
        return None

    monkeypatch.setattr(server.event_dispatcher, "emit", _noop_emit)

    knowledge = world.knowledge_manager.load_knowledge("khk_aggressive")
    initial_warp = knowledge.ship_config.current_warp_power

    encounter = CombatEncounter(
        combat_id="test-flee-success",
        sector_id=5,
        participants={
            "khk_passive": CombatantState(
                combatant_id="khk_passive",
                combatant_type="character",
                name="khk_passive",
                fighters=170,
                shields=115,
                turns_per_warp=3,
                max_fighters=300,
                max_shields=150,
                owner_character_id="khk_passive",
            )
        },
    )

    outcome = CombatRoundOutcome(
        round_number=1,
        hits={"khk_aggressive": 0, "khk_passive": 0},
        offensive_losses={"khk_aggressive": 0, "khk_passive": 0},
        defensive_losses={"khk_aggressive": 0, "khk_passive": 0},
        shield_loss={"khk_aggressive": 0, "khk_passive": 5},
        fighters_remaining={"khk_aggressive": 75, "khk_passive": 170},
        shields_remaining={"khk_aggressive": 50, "khk_passive": 115},
        flee_results={"khk_aggressive": True, "khk_passive": False},
        end_state=None,
        effective_actions={
            "khk_aggressive": RoundAction(
                action=CombatantAction.FLEE,
                commit=0,
                destination_sector=6,
            ),
            "khk_passive": RoundAction(
                action=CombatantAction.ATTACK,
                commit=10,
                target_id="khk_aggressive",
            ),
        },
    )

    await server._combat_round_resolved(encounter, outcome)

    updated_knowledge = world.knowledge_manager.load_knowledge("khk_aggressive")
    assert updated_knowledge.current_sector == 6
    assert updated_knowledge.ship_config.current_warp_power == initial_warp - 3
    assert updated_knowledge.ship_config.current_fighters == 75
    assert updated_knowledge.ship_config.current_shields == 50

    character = world.characters["khk_aggressive"]
    assert character.sector == 6
    assert character.fighters == 75
    assert character.shields == 50
