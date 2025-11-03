from datetime import datetime, timedelta, timezone

import pytest

from fastapi import HTTPException

from api import event_query
from core.character_registry import CharacterRegistry
from server_logging.event_log import EventLogger, EventRecord


class DummyWorld:
    def __init__(self, registry, *, character_to_corp=None, garrisons=None):
        self.character_registry = registry
        self.character_to_corp = character_to_corp or {}
        self.garrisons = garrisons


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


@pytest.mark.asyncio
async def test_event_query_corporation_scope_requires_membership(tmp_path, monkeypatch):
    world_path = tmp_path
    monkeypatch.setattr(event_query, "get_world_data_path", lambda: world_path)

    registry = CharacterRegistry(world_path / "characters.json")
    registry.load()

    corp_map = {
        "corp-member-a": "corp-123",
        "corp-member-b": "corp-123",
    }

    log_path = world_path / "event-log.jsonl"
    logger = EventLogger(log_path)
    now = datetime.now(timezone.utc)
    # Event emitted by another corp member
    logger.append(
        EventRecord(
            timestamp=now.isoformat(),
            direction="sent",
            event="status.update",
            payload={"note": "corp member moved"},
            sender="corp-member-b",
            receiver=None,
            sector=10,
            corporation_id="corp-123",
            meta=None,
        )
    )
    # Event from a different corporation should be excluded
    logger.append(
        EventRecord(
            timestamp=(now + timedelta(seconds=1)).isoformat(),
            direction="sent",
            event="trade.executed",
            payload={},
            sender="outsider",
            receiver=None,
            sector=11,
            corporation_id="corp-999",
            meta=None,
        )
    )

    payload = {
        "character_id": "corp-member-a",
        "corporation_id": "corp-123",
        "start": (now - timedelta(seconds=1)).isoformat(),
        "end": (now + timedelta(seconds=5)).isoformat(),
    }

    result = await event_query.handle(payload, DummyWorld(registry, character_to_corp=corp_map))
    assert result["success"] is True
    assert result["count"] == 1
    assert result["events"][0]["corporation_id"] == "corp-123"
    assert result["events"][0]["sender"] == "corp-member-b"

    # Actor outside the corporation must be rejected
    unauthorized_payload = {
        "character_id": "not-in-corp",
        "corporation_id": "corp-123",
        "start": (now - timedelta(seconds=1)).isoformat(),
        "end": (now + timedelta(seconds=5)).isoformat(),
    }

    with pytest.raises(HTTPException) as exc:
        await event_query.handle(unauthorized_payload, DummyWorld(registry, character_to_corp=corp_map))

    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_event_query_includes_garrison_sector_movements(tmp_path, monkeypatch):
    world_path = tmp_path
    monkeypatch.setattr(event_query, "get_world_data_path", lambda: world_path)

    registry = CharacterRegistry(world_path / "characters.json")
    registry.load()

    corp_id = "corp-123"
    corp_members = {
        "corp-member": corp_id,
        "garrison-owner": corp_id,
    }

    log_path = world_path / "event-log.jsonl"
    logger = EventLogger(log_path)
    now = datetime.now(timezone.utc)

    garrison_payload = {
        "movement": "arrive",
        "player": {"id": "attacker-1", "name": "Raid Leader"},
        "ship": {"ship_name": "Corsair"},
        "garrison": {
            "owner_id": "garrison-owner",
            "owner_name": "Captain G",
            "corporation_id": corp_id,
            "mode": "offensive",
            "fighters": 12,
            "toll_amount": 0,
            "deployed_at": now.isoformat(),
        },
    }

    logger.append(
        EventRecord(
            timestamp=now.isoformat(),
            direction="sent",
            event="garrison.character_moved",
            payload=garrison_payload,
            sender="garrison-owner",
            receiver=None,
            sector=512,
            corporation_id=corp_id,
            meta=None,
        )
    )

    # Unrelated event in another sector that should be ignored.
    logger.append(
        EventRecord(
            timestamp=(now + timedelta(seconds=1)).isoformat(),
            direction="sent",
            event="garrison.character_moved",
            payload={
                "movement": "arrive",
                "player": {"id": "bystander"},
                "ship": {"ship_name": "Wanderer"},
                "garrison": {
                    "owner_id": "other-owner",
                    "owner_name": "Other Owner",
                    "corporation_id": "corp-999",
                    "mode": "defensive",
                    "fighters": 5,
                    "toll_amount": 2,
                    "deployed_at": now.isoformat(),
                },
            },
            sender="other-owner",
            receiver=None,
            sector=999,
            corporation_id="corp-999",
            meta=None,
        )
    )

    payload = {
        "actor_character_id": "corp-member",
        "corporation_id": corp_id,
        "start": (now - timedelta(seconds=5)).isoformat(),
        "end": (now + timedelta(seconds=5)).isoformat(),
    }

    result = await event_query.handle(
        payload,
        DummyWorld(registry, character_to_corp=corp_members),
    )

    assert result["success"] is True
    assert result["count"] == 1
    record = result["events"][0]
    assert record["event"] == "garrison.character_moved"
    assert record["sector"] == 512
    assert record["corporation_id"] == corp_id
    assert record["payload"]["garrison"]["owner_id"] == "garrison-owner"
