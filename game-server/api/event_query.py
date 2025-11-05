"""RPC handler for querying event logs (admin and character modes)."""

from __future__ import annotations

import json
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

    # Determine if this is an admin query or character query
    # Treat as admin only if admin_password was explicitly provided AND it validates
    admin_password_provided = "admin_password" in payload
    admin_password = payload.get("admin_password")
    is_admin = admin_password_provided and registry.validate_admin_password(admin_password)

    # Parse required time range
    start = _parse_timestamp(payload.get("start"), "start")
    end = _parse_timestamp(payload.get("end"), "end")
    if start > end:
        raise HTTPException(status_code=400, detail="start must be before end")

    # Parse optional character_id field. In character mode it identifies the actor
    # issuing the query (still required for permission checks).
    character_id = payload.get("character_id")
    if character_id is not None and not isinstance(character_id, str):
        raise HTTPException(status_code=400, detail="character_id must be a string")

    actor_character_id = payload.get("actor_character_id")
    if actor_character_id is not None and not isinstance(actor_character_id, str):
        raise HTTPException(status_code=400, detail="actor_character_id must be a string")

    # Parse optional corporation filter before we enforce actor requirements.
    corporation_id = payload.get("corporation_id")
    if corporation_id is not None and not isinstance(corporation_id, str):
        raise HTTPException(status_code=400, detail="corporation_id must be a string")

    # In character mode we always require an actor so we can validate permissions.
    if not is_admin and not (character_id or actor_character_id):
        raise HTTPException(
            status_code=403,
            detail="character_id or actor_character_id required for non-admin queries",
        )

    if corporation_id and not is_admin:
        # Ensure the actor is part of the requested corporation before exposing
        # potentially sensitive fleet activity.
        character_to_corp = getattr(world, "character_to_corp", None)
        actor_corp_id = None
        if isinstance(character_to_corp, dict):
            membership_candidate = actor_character_id or character_id
            actor_corp_id = character_to_corp.get(membership_candidate)
        if actor_corp_id != corporation_id:
            raise HTTPException(
                status_code=403,
                detail="Actor is not authorized to view this corporation's events",
            )

    # Parse optional sector filter
    sector_value = payload.get("sector")
    sector = None
    if sector_value is not None:
        try:
            sector = int(sector_value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="sector must be an integer")

    # Character-scoped queries should still only surface events for that actor.
    # Corporation-scoped queries ignore the per-character filter so the caller can
    # review fleet-wide activity while remaining in non-admin mode.
    resolved_character_id = character_id or actor_character_id
    query_character_id = resolved_character_id if corporation_id is None else None

    # Query the event log with filters
    # If character_id provided: returns events where sender=character_id OR receiver=character_id
    # If sector provided: additionally filters to events in that sector
    log_path = get_world_data_path() / "event-log.jsonl"
    logger = EventLogger(log_path)
    events = logger.query(
        start,
        end,
        character_id=query_character_id,
        sector=sector,
        corporation_id=corporation_id,
    )
    truncated = len(events) >= MAX_QUERY_RESULTS

    return {
        "success": True,
        "events": events,
        "truncated": truncated,
        "count": len(events),
    }
