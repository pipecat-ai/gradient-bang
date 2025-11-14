import json
from pathlib import Path

import pytest

from gradientbang.game_server.core.corporation_manager import CorporationManager


@pytest.fixture(scope="session", autouse=True)
async def test_server():
    """Override integration server autouse fixture for unit tests."""
    yield


@pytest.fixture(autouse=True)
async def reset_test_state():
    """Override global reset fixture to keep tests local."""
    yield


@pytest.fixture
def manager(tmp_path):
    world_dir = tmp_path / "world"
    world_dir.mkdir()
    # seed registry file to ensure deterministic structure
    (world_dir / "corporations").mkdir()
    registry = world_dir / "corporation_registry.json"
    registry.write_text(json.dumps({"by_name": {}}), encoding="utf-8")
    return CorporationManager(world_dir)


def test_create_and_load(manager):
    corp = manager.create("Galactic Traders", "founder-1")
    assert corp["corp_id"]
    loaded = manager.load(corp["corp_id"])
    assert loaded["name"] == "Galactic Traders"
    assert loaded["members"] == ["founder-1"]
    assert manager.get_by_name("galactic traders") == corp["corp_id"]


def test_add_and_remove_member(manager):
    corp = manager.create("Void Runners", "captain")
    manager.add_member(corp["corp_id"], "pilot-2")
    assert manager.is_member(corp["corp_id"], "pilot-2")
    became_empty = manager.remove_member(corp["corp_id"], "pilot-2")
    assert became_empty is False
    became_empty = manager.remove_member(corp["corp_id"], "captain")
    assert became_empty is True
    assert manager.get_members(corp["corp_id"]) == []


def test_invite_code_regeneration(manager):
    corp = manager.create("Asteroid Guild", "admin")
    original = corp["invite_code"]
    new_code = manager.regenerate_invite_code(corp["corp_id"], "admin")
    assert new_code != original
    assert manager.verify_invite_code(corp["corp_id"], new_code)
    assert manager.verify_invite_code(corp["corp_id"], new_code.upper())


def test_ship_management(manager):
    corp = manager.create("Fleet Ops", "commander")
    manager.add_ship(corp["corp_id"], "ship-1")
    manager.add_ship(corp["corp_id"], "ship-1")  # idempotent
    manager.add_ship(corp["corp_id"], "ship-2")
    assert set(manager.get_ships(corp["corp_id"])) == {"ship-1", "ship-2"}
    manager.remove_ship(corp["corp_id"], "ship-1")
    assert manager.get_ships(corp["corp_id"]) == ["ship-2"]


def test_list_all_and_delete(manager):
    corp1 = manager.create("Alpha Corp", "founder-a")
    corp2 = manager.create("Beta Corp", "founder-b")
    summaries = manager.list_all()
    summary_names = {entry["name"] for entry in summaries}
    assert {"Alpha Corp", "Beta Corp"} <= summary_names
    manager.delete(corp1["corp_id"])
    with pytest.raises(FileNotFoundError):
        manager.load(corp1["corp_id"])
    assert manager.get_by_name("alpha corp") is None
    remaining = {entry["name"] for entry in manager.list_all()}
    assert "Beta Corp" in remaining and "Alpha Corp" not in remaining
