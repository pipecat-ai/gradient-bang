"""RPC handler for querying event logs (admin and character modes)."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from gradientbang.game_server.server_logging.event_log import EventLogger, MAX_QUERY_RESULTS
from gradientbang.utils.config import get_world_data_path
from gradientbang.game_server.rpc.events import event_dispatcher
from gradientbang.game_server.api.utils import build_event_source, build_log_context


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

    request_id = payload.get("request_id") or "missing-request-id"

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

    event_scope = payload.get("event_scope", "personal")
    if not isinstance(event_scope, str):
        raise HTTPException(status_code=400, detail="event_scope must be a string")
    normalized_scope = event_scope.lower()
    if normalized_scope not in {"personal", "corporation"}:
        raise HTTPException(
            status_code=400,
            detail="event_scope must be 'personal' or 'corporation'",
        )

    # Parse optional corporation filter before we enforce actor requirements.
    corporation_id = payload.get("corporation_id")
    if corporation_id is not None and not isinstance(corporation_id, str):
        raise HTTPException(status_code=400, detail="corporation_id must be a string")

    resolved_actor_for_scope = actor_character_id or character_id
    if (
        normalized_scope == "corporation"
        and corporation_id is None
        and resolved_actor_for_scope is not None
    ):
        character_to_corp = getattr(world, "character_to_corp", None)
        if isinstance(character_to_corp, dict):
            derived_corp_id = character_to_corp.get(resolved_actor_for_scope)
        else:
            derived_corp_id = None
        if derived_corp_id:
            corporation_id = derived_corp_id
        else:
            normalized_scope = "personal"

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

    string_match = payload.get("string_match")
    if string_match is not None:
        if not isinstance(string_match, str):
            raise HTTPException(status_code=400, detail="string_match must be a string")
        if not string_match:
            raise HTTPException(status_code=400, detail="string_match cannot be empty")

    max_rows_value = payload.get("max_rows")
    if max_rows_value is None:
        max_rows = 1000
    else:
        try:
            max_rows = int(max_rows_value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="max_rows must be an integer")
        if max_rows <= 0:
            raise HTTPException(status_code=400, detail="max_rows must be positive")

    if max_rows > MAX_QUERY_RESULTS:
        raise HTTPException(
            status_code=400,
            detail=f"max_rows cannot exceed {MAX_QUERY_RESULTS}",
        )

    sort_direction = payload.get("sort_direction", "forward")
    if not isinstance(sort_direction, str):
        raise HTTPException(status_code=400, detail="sort_direction must be a string")
    sort_direction_normalized = sort_direction.lower()
    if sort_direction_normalized not in {"forward", "reverse"}:
        raise HTTPException(
            status_code=400,
            detail="sort_direction must be 'forward' or 'reverse'",
        )

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
    events, truncated = logger.query(
        start,
        end,
        character_id=query_character_id,
        sector=sector,
        corporation_id=corporation_id,
        string_match=string_match,
        limit=max_rows,
        sort_direction=sort_direction_normalized,
    )

    effective_scope = "corporation" if corporation_id else "personal"

    event_filters = {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "max_rows": max_rows,
        "sort_direction": sort_direction_normalized,
        "scope": effective_scope,
    }
    if query_character_id:
        event_filters["character_id"] = query_character_id
    if sector is not None:
        event_filters["sector"] = sector
    if corporation_id is not None:
        event_filters["corporation_id"] = corporation_id
    if string_match is not None:
        event_filters["string_match"] = string_match

    event_payload = {
        "events": events,
        "count": len(events),
        "truncated": truncated,
        "filters": event_filters,
        "source": build_event_source("event_query", request_id),
        "scope": effective_scope,
    }

    recipient_character_id = resolved_character_id or character_id or actor_character_id
    if recipient_character_id:
        await event_dispatcher.emit(
            "event.query",
            event_payload,
            character_filter=[recipient_character_id],
            log_context=build_log_context(
                character_id=recipient_character_id,
                world=world,
                corporation_id=corporation_id,
            ),
            log_event=False,
        )

    return {
        "success": True,
        "events": events,
        "truncated": truncated,
        "count": len(events),
        "scope": effective_scope,
    }
