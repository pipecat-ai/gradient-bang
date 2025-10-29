from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.utils import (
    COMBAT_ACTION_REQUIRED,
    build_event_source,
    ensure_not_in_combat,
    rpc_success,
)


def test_rpc_success_minimal():
    result = rpc_success()
    assert result == {"success": True}


def test_rpc_success_with_data():
    result = rpc_success({"combat_id": "test-123"})
    assert result == {"success": True, "combat_id": "test-123"}


def test_build_event_source_with_timestamp():
    timestamp = datetime(2025, 10, 15, 12, 30, tzinfo=timezone.utc)
    result = build_event_source(
        "move",
        "abc123",
        source_type="rpc",
        timestamp=timestamp,
    )
    assert result == {
        "type": "rpc",
        "method": "move",
        "request_id": "abc123",
        "timestamp": timestamp.isoformat(),
    }


@pytest.mark.asyncio
async def test_ensure_not_in_combat_handles_iterable_inputs():
    observed_ids: list[str] = []

    class DummyManager:
        async def find_encounter_for(self, cid: str):
            observed_ids.append(cid)
            if cid == "pilot-in-combat":
                return SimpleNamespace(ended=False)
            return None

    world = SimpleNamespace(combat_manager=DummyManager())

    with pytest.raises(HTTPException) as exc:
        await ensure_not_in_combat(world, ["pilot-free", "pilot-in-combat"])

    assert exc.value.detail == COMBAT_ACTION_REQUIRED
    assert observed_ids == ["pilot-free", "pilot-in-combat"]
