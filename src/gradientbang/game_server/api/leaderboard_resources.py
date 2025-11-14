"""RPC handler for returning (and temporarily rebuilding) the leaderboard."""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

from fastapi import HTTPException

from core.config import get_world_data_path
from core.leaderboard import (
    LeaderboardSnapshotError,
    clear_leaderboard_cache,
    get_cached_leaderboard,
    leaderboard_snapshot_path,
)

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]
REBUILD_SCRIPT = REPO_ROOT / "scripts" / "rebuild_leaderboard.py"


async def handle(request: dict, world) -> dict:
    force_refresh = bool(request.get("force_refresh"))
    path = leaderboard_snapshot_path(get_world_data_path())

    if force_refresh:
        clear_leaderboard_cache()

    # NOTE: During testing we always rebuild synchronously so the endpoint reflects
    # the latest data. Once cron/backfill infrastructure is ready we can remove this
    # subprocess hop and rely on the scheduled worker instead.
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(REBUILD_SCRIPT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
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
