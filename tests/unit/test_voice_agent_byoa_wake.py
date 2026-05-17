"""Unit tests for the BYOA wake flow on VoiceAgent.

Covers:

- ``ByoaCoordinator.lookup_owner`` extracts the BYOA owner prefix from the
  ``my_corporation`` payload, returning None on any miss.
- ``ByoaCoordinator.agent_name_for`` is the documented convention used by both sides.
- ``_resolve_hello_response`` treats ``correlation_id=""`` as an unsolicited
  online signal — no crash, no resolution of unrelated pending requests.
- ``_watch_wake_timeout`` releases the server lock + clears local state when
  the timer expires, and is a no-op when cancelled (the happy path on
  ``on_agent_ready``).
- The wake-flow branch in ``_handle_start_task``:
  - returns ``status="waking"`` immediately
  - registers a watchdog + pending-task entry keyed by the BYOA agent name
  - calls ``watch_agent`` for the remote agent
  - does NOT spawn an in-process TaskAgent
  - calls ``wake_agent`` with the derived session channel and task_id
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gradientbang.pipecat_server.subagents.bus_messages import (
    BusAgentHelloResponse,
    BusByoaPresenceMessage,
)
from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent
from gradientbang.utils.api_client import RPCError


def _make_voice_agent(**overrides) -> VoiceAgent:
    mock_game_client = MagicMock()
    mock_game_client.corporation_id = "corp-1"
    mock_game_client.set_event_polling_scope = MagicMock()
    mock_game_client.task_lifecycle = AsyncMock(return_value={"success": True})
    mock_game_client.task_cancel = AsyncMock(return_value={"success": True})
    mock_game_client.wake_agent = AsyncMock(
        return_value={"spawn_target": "http", "spawn_status": "accepted"}
    )
    mock_game_client._request = AsyncMock(return_value={})

    kwargs = {
        "bus": MagicMock(),
        "game_client": mock_game_client,
        "character_id": "char-player",
        "rtvi_processor": MagicMock(push_frame=AsyncMock()),
    }
    kwargs.update(overrides)
    return VoiceAgent("player", **kwargs)


@pytest.mark.unit
class TestByoaAgentName:
    def test_documented_format(self):
        agent = _make_voice_agent()
        assert agent._byoa.agent_name_for("ship-uuid-123") == "byoa_ship-uuid-123"


@pytest.mark.unit
class TestLookupByoaOwner:
    async def test_returns_owner_prefix_when_byoa_claimed(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={
                "corporation": {
                    "ships": [
                        {"ship_id": "other-ship", "byoa": None},
                        {
                            "ship_id": "ship-1",
                            "byoa": {
                                "mode": "private",
                                "owner_character_id_prefix": "abc123def456",
                            },
                        },
                    ]
                }
            }
        )
        assert await agent._byoa.lookup_owner("ship-1") == "abc123def456"

    async def test_returns_none_for_non_byoa_ship(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={
                "corporation": {"ships": [{"ship_id": "ship-1", "byoa": None}]}
            }
        )
        assert await agent._byoa.lookup_owner("ship-1") is None

    async def test_returns_none_when_my_corporation_fails(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(side_effect=RuntimeError("network"))
        assert await agent._byoa.lookup_owner("ship-1") is None

    async def test_returns_none_when_ship_not_in_corp_response(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={"corporation": {"ships": []}}
        )
        assert await agent._byoa.lookup_owner("ship-1") is None


@pytest.mark.unit
class TestUnsolicitedHello:
    async def test_correlation_id_empty_is_no_op_on_pending_requests(self):
        agent = _make_voice_agent()
        future_task = asyncio.create_task(
            agent._hello_pending.issue("corr-xyz", timeout=0.1)
        )
        agent._resolve_hello_response(
            BusAgentHelloResponse(source="byoa_ship-1", target=agent.name, ready=True)
        )
        with pytest.raises(asyncio.TimeoutError):
            await future_task

    async def test_correlation_id_set_resolves_matching_pending(self):
        agent = _make_voice_agent()
        future_task = asyncio.create_task(
            agent._hello_pending.issue("corr-abc", timeout=1.0)
        )
        await asyncio.sleep(0)
        agent._resolve_hello_response(
            BusAgentHelloResponse(
                source="byoa_ship-1",
                target=agent.name,
                correlation_id="corr-abc",
                ready=True,
            )
        )
        result = await future_task
        assert result.ready is True


@pytest.mark.unit
class TestByoaPresence:
    async def test_presence_online_updates_map_and_pushes_rtvi(self):
        agent = _make_voice_agent()
        agent._byoa.lookup_owner = AsyncMock(return_value="ownerprefix12")

        await agent._byoa.on_presence(
            BusByoaPresenceMessage(
                source="byoa_ship-1",
                ship_id="ship-1",
                online=True,
                status="online",
                last_seen_at="2026-05-12T12:00:00+00:00",
            )
        )

        assert agent._byoa._presence["ship-1"].online is True
        pushed = agent._rtvi.push_frame.await_args.args[0]
        assert pushed.data["event"] == "byoa.presence"
        assert pushed.data["payload"]["ship_id"] == "ship-1"
        assert pushed.data["payload"]["online"] is True
        if agent._byoa._sweep_task:
            agent._byoa._sweep_task.cancel()

    async def test_presence_ignores_non_byoa_ship(self):
        agent = _make_voice_agent()
        agent._byoa.lookup_owner = AsyncMock(return_value=None)

        await agent._byoa.on_presence(
            BusByoaPresenceMessage(
                source="byoa_ship-1",
                ship_id="ship-1",
                online=True,
                status="online",
            )
        )

        assert agent._byoa._presence == {}
        agent._rtvi.push_frame.assert_not_awaited()

    async def test_stale_presence_marks_offline(self):
        agent = _make_voice_agent()
        agent._byoa.lookup_owner = AsyncMock(return_value="ownerprefix12")
        await agent._byoa.on_presence(
            BusByoaPresenceMessage(source="byoa_ship-1", ship_id="ship-1", online=True)
        )
        agent._rtvi.push_frame.reset_mock()
        agent._byoa._presence["ship-1"].last_seen_monotonic -= 999

        await agent._byoa._mark_stale_offline()

        assert agent._byoa._presence["ship-1"].online is False
        pushed = agent._rtvi.push_frame.await_args.args[0]
        assert pushed.data["payload"]["online"] is False
        if agent._byoa._sweep_task:
            agent._byoa._sweep_task.cancel()


@pytest.mark.unit
class TestWatchWakeTimeout:
    async def test_cancellation_is_happy_path(self):
        agent = _make_voice_agent()
        agent._byoa._config = MagicMock(agent_wake_timeout_seconds=10.0)
        agent._locked_ships["ship-1"] = "task-1"

        watchdog = asyncio.create_task(
            agent._byoa._watch_wake_timeout(
                target_character_id="ship-1",
                framework_task_id="task-1",
                agent_name="byoa_ship-1",
            )
        )
        await asyncio.sleep(0)
        watchdog.cancel()
        await asyncio.sleep(0)

        agent._game_client.task_cancel.assert_not_awaited()
        assert agent._locked_ships == {"ship-1": "task-1"}

    async def test_expiry_releases_lock_and_cleans_state(self):
        agent = _make_voice_agent()
        agent._byoa._config = MagicMock(agent_wake_timeout_seconds=0.05)
        agent._enqueue_deferred_update = MagicMock()
        agent._locked_ships["ship-1"] = "task-1"
        agent._pending_tasks["byoa_ship-1"] = ("task-1", {})
        agent._byoa._pending_wakes["ship-1"] = MagicMock()

        await agent._byoa._watch_wake_timeout(
            target_character_id="ship-1",
            framework_task_id="task-1",
            agent_name="byoa_ship-1",
        )

        agent._game_client.task_cancel.assert_awaited_once_with(
            task_id="task-1",
            character_id="char-player",
            force=True,
        )
        assert "ship-1" not in agent._locked_ships
        assert "byoa_ship-1" not in agent._pending_tasks
        assert "ship-1" not in agent._byoa._pending_wakes
        event_xml = agent._enqueue_deferred_update.call_args.args[0]
        assert 'event name="task.cancelled"' in event_xml
        assert "did not come online" in event_xml
        assert agent._enqueue_deferred_update.call_args.kwargs["ship_id"] == "ship-1"


@pytest.mark.unit
class TestCancelPendingByoaWake:
    async def test_client_cancel_clears_pending_wake_without_bus_dispatch(self):
        agent = _make_voice_agent()
        agent._enqueue_deferred_update = MagicMock()
        agent._update_polling_scope = MagicMock()
        watchdog = asyncio.create_task(asyncio.sleep(30))
        await asyncio.sleep(0)
        agent._locked_ships["ship-uuid-123"] = "task-1"
        agent._pending_tasks["byoa_ship-uuid-123"] = ("task-1", {"task": "payload"})
        agent._byoa._pending_wakes["ship-uuid-123"] = watchdog

        await agent._cancel_task_by_game_id("task-1")
        await asyncio.sleep(0)

        assert "ship-uuid-123" not in agent._locked_ships
        assert "byoa_ship-uuid-123" not in agent._pending_tasks
        assert "ship-uuid-123" not in agent._byoa._pending_wakes
        assert watchdog.cancelled()
        agent._update_polling_scope.assert_called_once()
        event_xml = agent._enqueue_deferred_update.call_args.args[0]
        assert 'event name="task.cancelled"' in event_xml
        assert "before the BYOA agent came online" in event_xml
        assert agent._enqueue_deferred_update.call_args.kwargs["ship_id"] == "ship-uuid-123"


@pytest.mark.unit
class TestStartTaskWakeBranch:
    def _wire_byoa_corp_ship(self, agent: VoiceAgent, byoa_owner_id: str | None) -> None:
        """Wire up enough state on the agent so the BYOA branch is reachable."""
        agent._byoa._config = MagicMock(agent_wake_timeout_seconds=30.0)
        agent._is_valid_uuid = MagicMock(return_value=True)
        agent._resolve_ship_id_prefix = AsyncMock(return_value=None)
        agent._is_corp_ship_id = AsyncMock(return_value=(True, "Corp Ship"))
        agent._byoa.lookup_owner = AsyncMock(return_value=byoa_owner_id)
        agent._acquire_server_ship_lock = AsyncMock(return_value=None)
        agent._count_active_corp_tasks = MagicMock(return_value=0)
        agent._get_task_type = MagicMock(return_value="corp_ship")
        agent._build_task_start_context = MagicMock(return_value=None)
        agent._event_relay = None
        agent.watch_agent = AsyncMock()
        agent.add_agent = AsyncMock()
        agent._ensure_heartbeat_task_running = MagicMock()

    async def test_byoa_ship_dispatch_registers_watchdog_and_calls_wake(self):
        """BYOA dispatch calls wake_agent with the per-session channel and
        registers a wake watchdog before yielding."""
        agent = _make_voice_agent()
        self._wire_byoa_corp_ship(agent, byoa_owner_id="charplayer")
        agent._byoa._bus_channel = "bot_session_abc"

        params = MagicMock()
        params.arguments = {
            "task_description": "haul ore to mp",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)
        # Let the asyncio.create_task fire-and-forget call run a tick.
        await asyncio.sleep(0)

        assert result["success"] is True
        assert result["message"] == "Task started"
        assert result["status"] == "waking"
        assert result["ship_character_id"] == "ship-uuid-123"

        # Watchdog + pending-task entry keyed by byoa_<ship_id>
        assert "ship-uuid-123" in agent._byoa._pending_wakes
        watchdog = agent._byoa._pending_wakes["ship-uuid-123"]
        assert isinstance(watchdog, asyncio.Task)
        watchdog.cancel()

        assert "byoa_ship-uuid-123" in agent._pending_tasks
        framework_task_id, payload = agent._pending_tasks["byoa_ship-uuid-123"]
        assert framework_task_id == result["task_id"]
        assert agent._acquire_server_ship_lock.await_args.kwargs["task_status"] == "waking"
        # Stale-task guard: framework task_id propagated into task_metadata.
        assert payload["task_metadata"]["task_id"] == framework_task_id
        agent.watch_agent.assert_awaited_once_with("byoa_ship-uuid-123")
        agent._game_client.wake_agent.assert_awaited_once_with(
            ship_id="ship-uuid-123",
            channel="bot_session_abc",
            task_id=framework_task_id,
        )

    async def test_byoa_dispatch_without_bus_channel_cleans_up_async(self):
        """Without a session channel, start returns waking and cleanup follows async."""
        agent = _make_voice_agent()
        self._wire_byoa_corp_ship(agent, byoa_owner_id="charplayer")
        agent._enqueue_deferred_update = MagicMock()
        agent._byoa._bus_channel = ""

        params = MagicMock()
        params.arguments = {
            "task_description": "haul ore to mp",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)
        await asyncio.sleep(0)

        assert result["success"] is True
        assert result["status"] == "waking"
        assert agent._acquire_server_ship_lock.await_args.kwargs["task_status"] == "waking"
        agent._game_client.wake_agent.assert_not_awaited()
        assert agent._byoa._pending_wakes == {}
        assert agent._pending_tasks == {}
        agent._game_client.task_cancel.assert_awaited_once()
        assert "missing_bus_channel" in agent._enqueue_deferred_update.call_args.args[0]

    async def test_byoa_dispatch_noop_without_presence_cleans_up_async(self):
        agent = _make_voice_agent()
        self._wire_byoa_corp_ship(agent, byoa_owner_id="charplayer")
        agent._enqueue_deferred_update = MagicMock()
        agent._byoa._bus_channel = "bot_session_abc"
        agent._game_client.wake_agent = AsyncMock(
            return_value={"spawn_target": "noop", "spawn_status": "noop"}
        )

        params = MagicMock()
        params.arguments = {
            "task_description": "haul ore to mp",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)
        await asyncio.sleep(0)

        assert result["success"] is True
        assert result["status"] == "waking"
        assert agent._acquire_server_ship_lock.await_args.kwargs["task_status"] == "waking"
        assert agent._byoa._pending_wakes == {}
        assert agent._pending_tasks == {}
        agent._game_client.task_cancel.assert_awaited_once()
        assert "BYOA_WAKE_TARGET=http" in agent._enqueue_deferred_update.call_args.args[0]

    async def test_byoa_dispatch_preserves_structured_wake_failure(self):
        agent = _make_voice_agent()
        self._wire_byoa_corp_ship(agent, byoa_owner_id="charplayer")
        agent._enqueue_deferred_update = MagicMock()
        agent._byoa._bus_channel = "bot_session_abc"
        agent._game_client.wake_agent = AsyncMock(
            side_effect=RPCError(
                "wake.agent",
                502,
                "wake_spawn_failed",
                body={
                    "error": "wake_spawn_failed",
                    "spawn_target": "http",
                    "spawn_status": "http_503",
                },
            )
        )

        params = MagicMock()
        params.arguments = {
            "task_description": "haul ore to mp",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)
        await asyncio.sleep(0)

        assert result["success"] is True
        assert result["status"] == "waking"
        assert agent._byoa._pending_wakes == {}
        assert agent._pending_tasks == {}
        agent._game_client.task_cancel.assert_awaited_once()
        assert "(http/http_503)" in agent._enqueue_deferred_update.call_args.args[0]

    async def test_byoa_dispatch_with_fresh_presence_still_wakes(self):
        agent = _make_voice_agent()
        self._wire_byoa_corp_ship(agent, byoa_owner_id="charplayer")
        agent._byoa._bus_channel = "bot_session_abc"
        agent._byoa._presence["ship-uuid-123"] = SimpleNamespace(
            online=True,
            last_seen_monotonic=time.monotonic(),
        )

        params = MagicMock()
        params.arguments = {
            "task_description": "haul ore to mp",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)
        await asyncio.sleep(0)

        assert result["success"] is True
        assert result["status"] == "waking"
        assert agent._acquire_server_ship_lock.await_args.kwargs["task_status"] == "waking"
        agent._game_client.wake_agent.assert_awaited_once_with(
            ship_id="ship-uuid-123",
            channel="bot_session_abc",
            task_id=result["task_id"],
        )
        agent.watch_agent.assert_awaited_once_with("byoa_ship-uuid-123")
        watchdog = agent._byoa._pending_wakes.get("ship-uuid-123")
        if watchdog:
            watchdog.cancel()

    async def test_byoa_ship_owned_by_another_member_fails_before_lock(self):
        agent = _make_voice_agent()
        self._wire_byoa_corp_ship(agent, byoa_owner_id="othermember1")
        agent._byoa._bus_channel = "bot_session_abc"

        params = MagicMock()
        params.arguments = {
            "task_description": "haul ore to mp",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)

        assert result["success"] is False
        assert "Only the BYOA owner" in result["error"]
        agent._acquire_server_ship_lock.assert_not_awaited()
        agent._game_client.wake_agent.assert_not_awaited()

    async def test_non_byoa_corp_ship_falls_through_to_in_process_spawn(self):
        """A corp ship without BYOA claim spawns a local TaskAgent."""
        agent = _make_voice_agent()
        self._wire_byoa_corp_ship(agent, byoa_owner_id=None)
        agent._byoa._bus_channel = "bot_session_abc"

        params = MagicMock()
        params.arguments = {
            "task_description": "haul",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)

        assert result["success"] is True
        assert result.get("status") != "waking"
        assert agent._acquire_server_ship_lock.await_args.kwargs["task_status"] is None
        agent.add_agent.assert_awaited_once()
        assert agent._byoa._pending_wakes == {}
        agent._game_client.wake_agent.assert_not_awaited()
