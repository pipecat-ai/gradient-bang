"""Admin RPC handler for querying event logs."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from server_logging.event_log import EventLogger, MAX_QUERY_RESULTS
from core.config import get_world_data_path


def _parse_timestamp(value: str | None, label: str) -> datetime:
    if not value:
        raise HTTPException(status_code=400, detail=f"Missing {label}")
    try:
        timestamp = datetime.fromisoformat(value)
    except ValueError as exc:  # noqa: F841
        raise HTTPException(status_code=400, detail=f"Invalid {label} format")
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp


async def handle(payload: dict, world) -> dict:
    registry = getattr(world, "character_registry", None)
    if registry is None:
        raise HTTPException(status_code=500, detail="Character registry unavailable")

    admin_password = payload.get("admin_password")
    if not registry.validate_admin_password(admin_password):
        raise HTTPException(status_code=403, detail="Invalid admin password")

    start = _parse_timestamp(payload.get("start"), "start")
    end = _parse_timestamp(payload.get("end"), "end")
    if start > end:
        raise HTTPException(status_code=400, detail="start must be before end")

    character_id = payload.get("character_id")
    if character_id is not None and not isinstance(character_id, str):
        raise HTTPException(status_code=400, detail="character_id must be a string")

    sector_value = payload.get("sector")
    sector = None
    if sector_value is not None:
        try:
            sector = int(sector_value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="sector must be an integer")

    log_path = get_world_data_path() / "event-log.jsonl"
    logger = EventLogger(log_path)
    events = logger.query(start, end, character_id=character_id, sector=sector)
    truncated = len(events) >= MAX_QUERY_RESULTS

    return {
        "success": True,
        "events": events,
        "truncated": truncated,
        "count": len(events),
    }
