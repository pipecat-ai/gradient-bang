from datetime import datetime, timedelta, timezone

import pytest

from fastapi import HTTPException

from api import event_query
from core.character_registry import CharacterRegistry
from server_logging.event_log import EventLogger, EventRecord


class DummyWorld:
    def __init__(self, registry):
        self.character_registry = registry


@pytest.mark.asyncio
async def test_event_query_filters_and_truncation(tmp_path, monkeypatch):
    world_path = tmp_path
    monkeypatch.setattr(event_query, "get_world_data_path", lambda: world_path)

    registry = CharacterRegistry(world_path / "characters.json")
    registry.load()
    registry.set_admin_password("secret")

    log_path = world_path / "event-log.jsonl"
    logger = EventLogger(log_path)
    now = datetime.now(timezone.utc)
    for i in range(3):
            logger.append(
                EventRecord(
                    timestamp=(now + timedelta(seconds=i)).isoformat(),
                    direction="sent",
                    event="status.update",
                    payload={"sector": {"id": 42 + i}},
                    sender="pilot-1",
                    receiver=None,
                    sector=42 + i,
                    corporation_id=None,
                    meta=None,
                )
            )

    payload = {
        "admin_password": "secret",
        "start": (now - timedelta(seconds=1)).isoformat(),
        "end": (now + timedelta(seconds=5)).isoformat(),
        "sector": 42,
    }

    result = await event_query.handle(payload, DummyWorld(registry))
    assert result["success"] is True
    assert result["count"] == 1
    assert result["events"][0]["sector"] == 42
    assert result["truncated"] is False

    # Overwrite query to force truncation flag
    result_all = await event_query.handle(
        {
            "admin_password": "secret",
            "start": (now - timedelta(seconds=1)).isoformat(),
            "end": (now + timedelta(seconds=5)).isoformat(),
        },
        DummyWorld(registry),
    )
    assert result_all["count"] == 3
    assert result_all["truncated"] is False


@pytest.mark.asyncio
async def test_event_query_rejects_bad_password(tmp_path, monkeypatch):
    world_path = tmp_path
    monkeypatch.setattr(event_query, "get_world_data_path", lambda: world_path)

    registry = CharacterRegistry(world_path / "characters.json")
    registry.load()
    registry.set_admin_password("secret")

    log_path = world_path / "event-log.jsonl"
    logger = EventLogger(log_path)
    now = datetime.now(timezone.utc)
    logger.append(
        EventRecord(
            timestamp=now.isoformat(),
            direction="sent",
            event="status.update",
            payload={},
            sender="pilot-1",
            receiver=None,
            sector=None,
            corporation_id=None,
            meta=None,
        )
    )

    payload = {
        "admin_password": "wrong",
        "start": (now - timedelta(seconds=1)).isoformat(),
        "end": (now + timedelta(seconds=1)).isoformat(),
    }

    with pytest.raises(HTTPException):
        await event_query.handle(payload, DummyWorld(registry))
