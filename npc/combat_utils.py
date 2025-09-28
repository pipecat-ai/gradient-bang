"""Shared helpers for combat CLIs."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from utils.api_client import AsyncGameClient


async def ensure_position(
    client: AsyncGameClient,
    status: Dict[str, Any],
    *,
    target_sector: int,
    logger,
) -> Dict[str, Any]:
    """Move the controlled character to the target sector if needed."""

    current_sector = int(status.get("sector", -1))
    if current_sector == target_sector:
        return status

    logger.info("Plotting course from %s to %s", current_sector, target_sector)
    course = await client.plot_course(current_sector, target_sector)
    path = course.get("path") or []
    if not path or int(path[-1]) != target_sector:
        raise RuntimeError(
            f"Unable to plot course to sector {target_sector}: received path {path}"
        )

    for step in map(int, path[1:]):
        logger.info("Warp jump to sector %s", step)
        await client.move(step)
        status = await client.my_status(force_refresh=True)
        logger.info("Arrived in sector %s", status.get("sector"))

    return status


def compute_timeout(deadline: Optional[str], override: Optional[float]) -> Optional[float]:
    """Return seconds remaining before the combat deadline, honoring overrides."""

    if override is not None:
        return max(0.0, override)
    if not deadline:
        return None
    try:
        timestamp = datetime.fromisoformat(deadline)
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        remaining = (timestamp - datetime.now(timezone.utc)).total_seconds()
        return max(0.0, remaining)
    except ValueError:
        return None


__all__ = ["ensure_position", "compute_timeout"]
