"""RPC handler for returning (and temporarily rebuilding) the leaderboard."""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from fastapi import HTTPException

from gradientbang.utils.config import get_world_data_path
from gradientbang.game_server.core.leaderboard import (
    LeaderboardSnapshotError,
    clear_leaderboard_cache,
    get_cached_leaderboard,
    leaderboard_snapshot_path,
)

logger = logging.getLogger(__name__)

REBUILD_MODULE = "gradientbang.scripts.rebuild_leaderboard"


async def handle(request: dict, world) -> dict:
    force_refresh = bool(request.get("force_refresh"))
    world_data_path = get_world_data_path()
    path = leaderboard_snapshot_path(world_data_path)

    if force_refresh:
        clear_leaderboard_cache()

    # NOTE: During testing we always rebuild synchronously so the endpoint reflects
    # the latest data. Once cron/backfill infrastructure is ready we can remove this
    # subprocess hop and rely on the scheduled worker instead.
    env = os.environ.copy()
    env.setdefault("WORLD_DATA_DIR", str(world_data_path))
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            REBUILD_MODULE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await process.communicate()
    except FileNotFoundError as exc:  # pragma: no cover - defensive guard
        raise HTTPException(status_code=500, detail="Leaderboard rebuild script missing") from exc

    if process.returncode != 0:
        logger.error(
            "leaderboard rebuild failed: returncode=%s stdout=%s stderr=%s",
            process.returncode,
            stdout.decode().strip(),
            stderr.decode().strip(),
        )
        raise HTTPException(status_code=500, detail="Failed to rebuild leaderboard")

    clear_leaderboard_cache()

    try:
        snapshot = get_cached_leaderboard(path)
    except LeaderboardSnapshotError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return snapshot
