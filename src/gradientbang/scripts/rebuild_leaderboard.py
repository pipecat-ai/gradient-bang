#!/usr/bin/env python3
"""Rebuild the wealth leaderboard snapshot from world data files."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from gradientbang.game_server.core.leaderboard import (
    compute_leaderboard_snapshot,
    leaderboard_snapshot_path,
    write_leaderboard_snapshot,
)
from gradientbang.game_server.core.world import GameWorld
from gradientbang.utils.config import get_world_data_path


async def _rebuild(world_data_dir: Path) -> Path:
    world = GameWorld()
    world.world_data_dir = world_data_dir
    world.load_data()
    snapshot = await compute_leaderboard_snapshot(world)
    output_path = leaderboard_snapshot_path(world_data_dir)
    write_leaderboard_snapshot(output_path, snapshot)
    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recompute the wealth leaderboard snapshot and write it to disk.",
    )
    parser.add_argument(
        "--world-data",
        dest="world_data",
        type=Path,
        help="Override world-data directory (defaults to core.config path)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    world_data_dir = (args.world_data or get_world_data_path()).resolve()

    output_path = asyncio.run(_rebuild(world_data_dir))
    print(f"Leaderboard snapshot written to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
