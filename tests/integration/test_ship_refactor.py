import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import pytest

from api import join, move, trade, utils
from character_knowledge import CharacterKnowledgeManager
from combat.callbacks import on_round_resolved
from combat.models import CombatEncounter, CombatantState, CombatRoundOutcome
from core.ships_manager import ShipsManager
from core.world import GameWorld
from rpc.events import event_dispatcher


TEST_WORLD_SOURCE = Path(__file__).parent.parent / "test-world-data"


def _register_characters(world_dir: Path, character_ids: Iterable[str]) -> None:
    registry_path = world_dir / "characters.json"
    with registry_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    characters = data.setdefault("characters", {})
    now = datetime.now(timezone.utc).isoformat()
    for character_id in character_ids:
        characters[character_id] = {
            "name": character_id,
            "player": {},
            "ship": {},
            "created_at": now,
            "updated_at": now,
        }

    tmp_path = registry_path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    tmp_path.replace(registry_path)


@pytest.fixture
def world_factory(tmp_path_factory, monkeypatch):
    def _factory(*character_ids: str) -> tuple[GameWorld, Path]:
        world_dir = tmp_path_factory.mktemp("ship-refactor-world")
        shutil.copytree(TEST_WORLD_SOURCE, world_dir, dirs_exist_ok=True)
        if character_ids:
            _register_characters(world_dir, character_ids)
        monkeypatch.setenv("WORLD_DATA_DIR", str(world_dir))
        world = GameWorld()
        world.load_data()
        return world, world_dir

    return _factory


async def _join(world: GameWorld, character_id: str, *, sector: Optional[int] = None) -> None:
    request = {"character_id": character_id}
    if sector is not None:
        request["sector"] = sector
    response = await join.handle(request, world)
    assert response["success"] is True


def _available_neighbor(world: GameWorld, sector: int) -> int:
    neighbors = sorted(world.universe_graph.neighbors(sector))
    if not neighbors:
        raise AssertionError(f"No neighboring sectors available from {sector}")
    return neighbors[0]


@pytest.mark.asyncio
async def test_ship_created_on_character_join(world_factory):
    character_id = "test_ship_join"
    world, _ = world_factory(character_id)

    await _join(world, character_id)

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    assert knowledge.current_ship_id, "Join should assign a ship ID"

    ship = world.ships_manager.get_ship(knowledge.current_ship_id)
    assert ship is not None
    assert ship["owner_type"] == "character"
    assert ship["owner_id"] == character_id
    assert ship["ship_type"] == "kestrel_courier"


@pytest.mark.asyncio
async def test_ship_and_character_positions_sync(world_factory):
    character_id = "test_ship_move"
    world, _ = world_factory(character_id)

    await _join(world, character_id)
    start_sector = world.characters[character_id].sector
    target_sector = _available_neighbor(world, start_sector)

    await move.handle(
        {
            "character_id": character_id,
            "to_sector": target_sector,
        },
        world,
    )

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship = world.knowledge_manager.get_ship(character_id)
    assert world.characters[character_id].sector == target_sector
    assert knowledge.current_sector == target_sector
    assert ship["sector"] == target_sector


@pytest.mark.asyncio
async def test_ship_state_persists(world_factory):
    character_id = "test_ship_persist"
    world, world_dir = world_factory(character_id)

    await _join(world, character_id)
    ship = world.knowledge_manager.get_ship(character_id)
    ship_id = ship["ship_id"]

    target_warp = ship["state"]["warp_power_capacity"] // 2
    world.ships_manager.update_ship_state(
        ship_id,
        fighters=123,
        shields=45,
        warp_power=target_warp,
    )

    reloaded_manager = ShipsManager(world_dir)
    reloaded_manager.load_all_ships()
    persisted = reloaded_manager.get_ship(ship_id)
    assert persisted is not None
    assert persisted["state"]["fighters"] == 123
    assert persisted["state"]["shields"] == 45
    assert persisted["state"]["warp_power"] == target_warp

    reloaded_knowledge = CharacterKnowledgeManager(world_dir / "character-map-knowledge")
    reloaded_knowledge.set_ships_manager(reloaded_manager)
    knowledge = reloaded_knowledge.load_knowledge(character_id)
    assert knowledge.current_ship_id == ship_id


@pytest.mark.asyncio
async def test_credits_stay_with_character(world_factory):
    character_id = "test_ship_credits"
    world, _ = world_factory(character_id)

    await _join(world, character_id)
    world.knowledge_manager.update_ship_credits(character_id, 2500)

    knowledge = world.knowledge_manager.load_knowledge(character_id)
    ship = world.knowledge_manager.get_ship(character_id)

    assert world.knowledge_manager.get_ship_credits(character_id) == 2500
    assert ship.get("state", {}).get("credits") == 2500
    if hasattr(knowledge, "credits"):
        assert knowledge.credits == 2500


@pytest.mark.asyncio
async def test_api_responses_include_ship_data(world_factory):
    character_id = "test_ship_status"
    world, _ = world_factory(character_id)

    await _join(world, character_id)
    status_payload = await utils.build_status_payload(world, character_id)

    ship_status = status_payload["ship"]
    ship = world.knowledge_manager.get_ship(character_id)
    ship_stats = ship["state"]

    assert ship_status["ship_type"] == ship["ship_type"]
    assert ship_status["warp_power"] == ship_stats["warp_power"]
    assert ship_status["fighters"] == ship_stats["fighters"]
    assert set(ship_status["cargo"].keys()) == {"quantum_foam", "retro_organics", "neuro_symbolics"}


@pytest.mark.asyncio
async def test_multiple_characters_multiple_ships(world_factory):
    char_one = "test_ship_multi_one"
    char_two = "test_ship_multi_two"
    world, _ = world_factory(char_one, char_two)

    await _join(world, char_one)
    await _join(world, char_two)

    ship_one = world.knowledge_manager.get_ship(char_one)
    ship_two = world.knowledge_manager.get_ship(char_two)

    assert ship_one["ship_id"] != ship_two["ship_id"]
    assert ship_one["owner_id"] == char_one
    assert ship_two["owner_id"] == char_two


@pytest.mark.asyncio
async def test_ship_cargo_updates(world_factory):
    character_id = "test_ship_trade"
    world, _ = world_factory(character_id)

    await _join(world, character_id, sector=1)

    ship_before = world.knowledge_manager.get_ship(character_id)
    previous_cargo = dict(ship_before["state"]["cargo"])

    await trade.handle(
        {
            "character_id": character_id,
            "commodity": "neuro_symbolics",
            "quantity": 5,
            "trade_type": "buy",
        },
        world,
    )

    ship_after = world.knowledge_manager.get_ship(character_id)
    assert ship_after["state"]["cargo"]["neuro_symbolics"] == previous_cargo["neuro_symbolics"] + 5


@pytest.mark.asyncio
async def test_ship_combat_updates(world_factory, monkeypatch):
    character_id = "test_ship_combat"
    world, _ = world_factory(character_id)

    await _join(world, character_id)
    initial_ship = world.knowledge_manager.get_ship(character_id)
    initial_fighters = initial_ship["state"]["fighters"]
    initial_shields = initial_ship["state"]["shields"]

    encounter = CombatEncounter(
        combat_id="encounter-test",
        sector_id=world.characters[character_id].sector,
        participants={
            character_id: CombatantState(
                combatant_id=character_id,
                combatant_type="character",
                name=character_id,
                fighters=initial_fighters - 75,
                shields=initial_shields - 30,
                turns_per_warp=2,
                max_fighters=initial_fighters,
                max_shields=initial_shields,
                owner_character_id=character_id,
                ship_type=initial_ship["ship_type"],
            )
        },
    )

    outcome = CombatRoundOutcome(
        round_number=1,
        hits={},
        offensive_losses={},
        defensive_losses={},
        shield_loss={},
        fighters_remaining={character_id: initial_fighters - 75},
        shields_remaining={character_id: initial_shields - 30},
        flee_results={},
        end_state="ongoing",
        effective_actions={},
    )

    async def _empty_garrisons(*_args, **_kwargs):
        return []

    async def _noop_emit(*_args, **_kwargs):
        return None

    monkeypatch.setattr("combat.utils._list_sector_garrisons", _empty_garrisons)
    monkeypatch.setattr(event_dispatcher, "emit", _noop_emit)

    await on_round_resolved(encounter, outcome, world, event_dispatcher)

    ship_after = world.knowledge_manager.get_ship(character_id)
    assert ship_after["state"]["fighters"] == initial_fighters - 75
    assert ship_after["state"]["shields"] == initial_shields - 30
