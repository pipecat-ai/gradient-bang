"""End-to-end PGMQ bus smoke test against a real Postgres instance.

Opt-in via ``pytest.mark.integration``; skipped unless ``POSTGRES_URL`` is set
(the integration harness in ``scripts/run-integration-tests.sh`` exports it).
Two ``PgmqBus`` instances share a unique channel, one subscribes, the other
publishes a Phase-1 typed message, and we assert it arrives intact through the
real wire. This is the acceptance gate for the Phase 2 transport choice — if
the JSON serializer or our ``_OwnedPgmqBus`` cleanup ever regresses, this is
where it fails.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from pipecat.utils.asyncio.task_manager import TaskManager, TaskManagerParams
from pipecat.bus import BusSubscriber

from gradientbang.adapters.bus.pgmq import build_pgmq_bus
from gradientbang.pipecat_server.subagents.bus_messages import BusGameToolCallRequest

pytestmark = pytest.mark.integration


def _pgmq_dsn() -> str | None:
    return os.environ.get("POSTGRES_URL") or os.environ.get("SUBAGENT_BUS_DATABASE_URL")


class _Collector(BusSubscriber):
    def __init__(self, sub_name: str) -> None:
        self._name = sub_name
        self.received: list = []

    @property
    def name(self) -> str:
        return self._name

    async def on_bus_message(self, message) -> None:
        self.received.append(message)


async def _wire_task_manager(bus) -> None:
    tm = TaskManager()
    tm.setup(TaskManagerParams(loop=asyncio.get_running_loop()))
    bus.set_task_manager(tm)


async def test_pgmq_bus_round_trip_custom_message():
    dsn = _pgmq_dsn()
    if not dsn:
        pytest.skip(
            "PGMQ integration test requires POSTGRES_URL "
            "(set by scripts/run-integration-tests.sh)"
        )

    # Unique channel so concurrent test runs and stray dev queues don't
    # cross-talk through the shared DB.
    channel = f"gb_test_{uuid.uuid4().hex[:10]}"

    publisher = await build_pgmq_bus(database_url=dsn, channel=channel)
    subscriber_bus = await build_pgmq_bus(database_url=dsn, channel=channel)
    await _wire_task_manager(publisher)
    await _wire_task_manager(subscriber_bus)

    collector = _Collector(f"collector_{uuid.uuid4().hex[:6]}")

    try:
        await publisher.start()
        await subscriber_bus.start()
        await subscriber_bus.subscribe(collector)

        # Give the peer-discovery list a moment to populate (upstream caches
        # the queue list with a 1s TTL).
        await asyncio.sleep(1.5)

        sent = BusGameToolCallRequest(
            source="pub",
            target=collector.name,
            correlation_id="corr-1",
            tool_name="move",
            args={"x": 3, "y": 4},
            character_id="char-1",
            actor_character_id="actor-1",
            task_id="task-1",
        )
        await publisher.send(sent)

        # Poll for receipt — long-poll's max_poll_seconds defaults to 5,
        # so 10s ceiling absorbs scheduler variance comfortably.
        deadline = asyncio.get_running_loop().time() + 10.0
        while not collector.received and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)

        assert collector.received, "PgmqBus did not deliver the published message"
        got = collector.received[-1]
        assert isinstance(got, BusGameToolCallRequest)
        assert got.correlation_id == "corr-1"
        assert got.tool_name == "move"
        assert got.args == {"x": 3, "y": 4}
        assert got.character_id == "char-1"
        assert got.actor_character_id == "actor-1"
        assert got.task_id == "task-1"
        assert got.source == "pub"
        assert got.target == collector.name
    finally:
        # _OwnedPgmqBus.stop() drops the per-instance queue and closes the
        # asyncpg pool. Skipping cleanup leaves dangling queues in the DB.
        await subscriber_bus.stop()
        await publisher.stop()
