"""Unit tests for BYOA-presence-driven ship-lock cleanup on Orchestrator.

The DB-persistent ship-task lock was removed. ``Orchestrator._locked_ships``
is the only authority on "ship busy". When a BYOA process goes silent past
the presence stale window, the bot must release its in-memory lock locally
and emit a ``task.cancel`` event so downstream consumers see the task ended.

Covers ``ByoaCoordinator._release_lock_on_offline`` (the single-ship cleanup helper)
and ``ByoaCoordinator._mark_stale_offline`` (the sweep loop's check, which
calls into the helper).
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from pipecat.bus import BusEndWorkerMessage

from gradientbang.runtime.byoa_coordinator import (
    PRESENCE_STALE_SECONDS,
    ByoaPresence,
)
from gradientbang.runtime.orchestrator import Orchestrator
from .runtime_test_helpers import make_orchestrator


def _make_orchestrator(**overrides) -> Orchestrator:
    mock_game_client = MagicMock()
    mock_game_client.corporation_id = "corp-1"
    mock_game_client.set_event_polling_scope = MagicMock()
    mock_game_client.task_lifecycle = AsyncMock(return_value={"success": True})
    mock_game_client.task_cancel = AsyncMock(return_value={"success": True})

    character_id = overrides.pop("character_id", "char-player")
    rtvi = overrides.pop("rtvi", MagicMock(push_frame=AsyncMock()))
    game_client = overrides.pop("game_client", mock_game_client)
    assert not overrides, f"Unhandled overrides: {sorted(overrides)}"
    return make_orchestrator(
        game_client=game_client,
        character_id=character_id,
        rtvi=rtvi,
    )


def _set_presence(
    agent: Orchestrator,
    ship_id: str,
    *,
    online: bool,
    seconds_ago: float,
) -> None:
    agent._byoa._presence[ship_id] = ByoaPresence(
        ship_id=ship_id,
        online=online,
        status="online" if online else "offline",
        last_seen_at=None,
        last_seen_monotonic=time.monotonic() - seconds_ago,
    )


@pytest.mark.unit
class TestReleaseLockOnByoaOffline:
    async def test_pops_locked_ships_emits_cancel_and_end_agent(self):
        agent = _make_orchestrator()
        agent.send_bus_message = AsyncMock()
        ship_id = "ship-aaa"
        task_id = "task-bbb"
        agent._locked_ships[ship_id] = task_id

        await agent._byoa._release_lock_on_offline(ship_id)

        assert ship_id not in agent._locked_ships
        agent._game_client.task_cancel.assert_awaited_once_with(
            task_id=task_id,
            character_id=agent._character_id,
        )
        agent.send_bus_message.assert_awaited_once()
        sent = agent.send_bus_message.await_args.args[0]
        assert isinstance(sent, BusEndWorkerMessage)
        assert sent.target == agent._byoa.agent_name_for(ship_id)
        assert sent.reason == "byoa_offline"

    async def test_noop_when_ship_not_locked(self):
        agent = _make_orchestrator()
        agent.send_bus_message = AsyncMock()

        await agent._byoa._release_lock_on_offline("ship-not-locked")

        agent._game_client.task_cancel.assert_not_awaited()
        agent.send_bus_message.assert_not_awaited()

    async def test_swallows_task_cancel_errors(self):
        agent = _make_orchestrator()
        agent.send_bus_message = AsyncMock()
        agent._game_client.task_cancel = AsyncMock(side_effect=RuntimeError("boom"))
        ship_id = "ship-ccc"
        agent._locked_ships[ship_id] = "task-ddd"

        await agent._byoa._release_lock_on_offline(ship_id)

        # Lock still released locally even when the server emit fails;
        # the end-agent bus message is still attempted.
        assert ship_id not in agent._locked_ships
        agent.send_bus_message.assert_awaited_once()


@pytest.mark.unit
class TestMarkStaleByoaPresenceOffline:
    async def test_stale_online_ship_with_lock_is_released(self):
        agent = _make_orchestrator()
        agent.send_bus_message = AsyncMock()
        ship_id = "ship-eee"
        task_id = "task-fff"
        agent._locked_ships[ship_id] = task_id
        _set_presence(
            agent,
            ship_id,
            online=True,
            seconds_ago=PRESENCE_STALE_SECONDS + 5.0,
        )

        await agent._byoa._mark_stale_offline()

        assert agent._byoa._presence[ship_id].online is False
        assert ship_id not in agent._locked_ships
        agent._game_client.task_cancel.assert_awaited_once()

    async def test_fresh_presence_is_left_alone(self):
        agent = _make_orchestrator()
        agent.send_bus_message = AsyncMock()
        ship_id = "ship-ggg"
        agent._locked_ships[ship_id] = "task-hhh"
        _set_presence(agent, ship_id, online=True, seconds_ago=1.0)

        await agent._byoa._mark_stale_offline()

        assert agent._byoa._presence[ship_id].online is True
        assert agent._locked_ships[ship_id] == "task-hhh"
        agent._game_client.task_cancel.assert_not_awaited()
