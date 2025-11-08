from __future__ import annotations

import json
import time
from pathlib import Path
import sys

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
GAME_SERVER_DIR = REPO_ROOT / "game-server"
sys.path.insert(0, str(GAME_SERVER_DIR))

from core.leaderboard import (
    LeaderboardSnapshotError,
    clear_leaderboard_cache,
    get_cached_leaderboard,
    load_leaderboard_snapshot,
    write_leaderboard_snapshot,
)


def _write_snapshot(path: Path, value: dict) -> None:
    write_leaderboard_snapshot(path, value)


def test_load_leaderboard_snapshot_missing(tmp_path: Path) -> None:
    missing = tmp_path / "leaderboard.json"
    with pytest.raises(LeaderboardSnapshotError):
        load_leaderboard_snapshot(missing)


def test_cached_leaderboard_invalidation(tmp_path: Path) -> None:
    snapshot_path = tmp_path / "leaderboard.json"
    first_payload = {"schema_version": 1, "players": [], "corporations": []}
    second_payload = {
        "schema_version": 1,
        "players": [{"character_id": "one", "total_resources": 10}],
        "corporations": [],
    }

    clear_leaderboard_cache()
    _write_snapshot(snapshot_path, first_payload)
    loaded_first = get_cached_leaderboard(snapshot_path)
    assert loaded_first == first_payload

    # Ensure the filesystem timestamp advances so the cache notices the change.
    time.sleep(0.01)
    _write_snapshot(snapshot_path, second_payload)

    clear_leaderboard_cache()
    loaded_second = get_cached_leaderboard(snapshot_path)
    assert loaded_second == second_payload
