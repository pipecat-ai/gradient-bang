from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from gradientbang.game_server.api.utils import (
    COMBAT_ACTION_REQUIRED,
    apply_port_observation,
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


def test_apply_port_observation_skips_remote_updates():
    calls: list[tuple[str, int, dict]] = []

    class DummyKnowledgeManager:
        def update_port_observation(self, *args):
            calls.append(args)

    world = SimpleNamespace(knowledge_manager=DummyKnowledgeManager())
    port_data = {"code": "SSS", "prices": {"quantum_foam": 20}, "stock": {}}

    event_port, observed_at = apply_port_observation(
        world,
        observer_id="char-1",
        sector_id=1449,
        port_data=port_data,
        in_sector=False,
    )

    assert event_port["observed_at"] == observed_at
    assert calls == []


def test_apply_port_observation_persists_in_sector():
    calls: list[tuple[str, int, dict]] = []

    class DummyKnowledgeManager:
        def update_port_observation(self, *args):
            calls.append(args)

    world = SimpleNamespace(knowledge_manager=DummyKnowledgeManager())
    port_data = {"code": "BSB", "prices": {"retro_organics": 12}, "stock": {}}
    observation_time = datetime(2025, 11, 9, 21, 31, tzinfo=timezone.utc)

    event_port, observed_at = apply_port_observation(
        world,
        observer_id="char-1",
        sector_id=319,
        port_data=port_data,
        in_sector=True,
        observation_time=observation_time,
    )

    assert event_port["observed_at"] is None
    assert observed_at == observation_time.isoformat()
    assert len(calls) == 1
    _, sector_id, stored_port = calls[0]
    assert sector_id == 319
    assert stored_port["observed_at"] == observation_time.isoformat()
