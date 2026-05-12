"""Unit tests for the BYOA wake-hook flow on VoiceAgent.

Covers the Phase 3 (2/N) plumbing:

- ``_lookup_byoa_wake_hook`` extracts the operator's wake hook from the
  ``my_corporation`` payload, returning None on any miss.
- ``byoa_agent_name`` is the documented convention used by both sides.
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
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gradientbang.pipecat_server.subagents.bus_messages import BusAgentHelloResponse
from gradientbang.pipecat_server.subagents.voice_agent import VoiceAgent


def _make_voice_agent(**overrides) -> VoiceAgent:
    mock_game_client = MagicMock()
    mock_game_client.corporation_id = "corp-1"
    mock_game_client.set_event_polling_scope = MagicMock()
    mock_game_client.task_lifecycle = AsyncMock(return_value={"success": True})
    mock_game_client.task_cancel = AsyncMock(return_value={"success": True})
    mock_game_client.task_heartbeat = AsyncMock(return_value={"refreshed": 0})
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
        assert agent.byoa_agent_name("ship-uuid-123") == "byoa_ship-uuid-123"


@pytest.mark.unit
class TestLookupByoaWakeHook:
    async def test_returns_wake_hook_when_present(self):
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
                                "wake_hook": "https://wake.example.test/byoa",
                            },
                        },
                    ]
                }
            }
        )
        result = await agent._lookup_byoa_wake_hook("ship-1")
        assert result == "https://wake.example.test/byoa"

    async def test_returns_none_for_non_byoa_ship(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={
                "corporation": {"ships": [{"ship_id": "ship-1", "byoa": None}]}
            }
        )
        assert await agent._lookup_byoa_wake_hook("ship-1") is None

    async def test_returns_none_when_byoa_block_has_no_hook(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={
                "corporation": {
                    "ships": [
                        {"ship_id": "ship-1", "byoa": {"mode": "shared", "wake_hook": None}}
                    ]
                }
            }
        )
        assert await agent._lookup_byoa_wake_hook("ship-1") is None

    async def test_returns_none_when_my_corporation_fails(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(side_effect=RuntimeError("network"))
        # Must not raise — wake-hook lookup failing should fall through to
        # in-process spawn, not error the whole start_task.
        assert await agent._lookup_byoa_wake_hook("ship-1") is None

    async def test_returns_none_when_ship_not_in_corp_response(self):
        agent = _make_voice_agent()
        agent._game_client._request = AsyncMock(
            return_value={"corporation": {"ships": []}}
        )
        assert await agent._lookup_byoa_wake_hook("ship-1") is None


@pytest.mark.unit
class TestUnsolicitedHello:
    async def test_correlation_id_empty_is_no_op_on_pending_requests(self):
        agent = _make_voice_agent()
        # Issue a pending request that should NOT be resolved by an
        # unsolicited hello (which carries empty correlation_id).
        future_task = asyncio.create_task(
            agent._hello_pending.issue("corr-xyz", timeout=0.1)
        )
        agent._resolve_hello_response(
            BusAgentHelloResponse(source="byoa_ship-1", target=agent.name, ready=True)
        )
        # The pending future should still time out — unsolicited hello did
        # NOT mistakenly resolve it.
        with pytest.raises(asyncio.TimeoutError):
            await future_task

    async def test_correlation_id_set_resolves_matching_pending(self):
        agent = _make_voice_agent()
        future_task = asyncio.create_task(
            agent._hello_pending.issue("corr-abc", timeout=1.0)
        )
        # Yield so issue() registers the future before we resolve.
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
class TestWatchWakeTimeout:
    async def test_cancellation_is_happy_path(self):
        agent = _make_voice_agent()
        agent._byoa_config = MagicMock(agent_wake_timeout_seconds=10.0)
        agent._locked_ships["ship-1"] = "task-1"

        watchdog = asyncio.create_task(
            agent._watch_wake_timeout(
                target_character_id="ship-1",
                framework_task_id="task-1",
                agent_name="byoa_ship-1",
            )
        )
        await asyncio.sleep(0)  # let the watchdog enter sleep
        watchdog.cancel()
        await asyncio.sleep(0)

        # No server release on cancellation — the happy path leaves the lock
        # alone (the regular task-finish flow handles release).
        agent._game_client.task_cancel.assert_not_awaited()
        # Local state untouched by cancellation.
        assert agent._locked_ships == {"ship-1": "task-1"}

    async def test_expiry_releases_lock_and_cleans_state(self):
        agent = _make_voice_agent()
        # Trim the timeout so the test finishes fast.
        agent._byoa_config = MagicMock(agent_wake_timeout_seconds=0.05)
        agent._locked_ships["ship-1"] = "task-1"
        agent._pending_tasks["byoa_ship-1"] = ("task-1", {})
        agent._pending_wakes["ship-1"] = MagicMock()  # stub entry the watchdog clears

        await agent._watch_wake_timeout(
            target_character_id="ship-1",
            framework_task_id="task-1",
            agent_name="byoa_ship-1",
        )

        # Server release fired with force=True so private BYOA doesn't block.
        agent._game_client.task_cancel.assert_awaited_once_with(
            task_id="task-1",
            character_id="char-player",
            force=True,
        )
        assert "ship-1" not in agent._locked_ships
        assert "byoa_ship-1" not in agent._pending_tasks
        assert "ship-1" not in agent._pending_wakes


@pytest.mark.unit
class TestStartTaskWakeBranch:
    async def test_wake_hook_set_returns_waking_and_registers_watchdog(self):
        """End-to-end: a BYOA ship with a wake_hook takes the async path."""
        agent = _make_voice_agent()
        # The wake-flow branch reads agent_wake_timeout_seconds; bypass real
        # timer with a generous value so the watchdog doesn't fire mid-test.
        agent._byoa_config = MagicMock(agent_wake_timeout_seconds=30.0)

        # Stub out the resolution helpers the spawn flow leans on.
        agent._is_valid_uuid = MagicMock(return_value=True)
        agent._resolve_ship_id_prefix = AsyncMock(return_value=None)
        agent._is_corp_ship_id = AsyncMock(return_value=(True, "Corp Ship"))
        agent._lookup_byoa_wake_hook = AsyncMock(
            return_value="https://wake.example.test/byoa"
        )
        agent._acquire_server_ship_lock = AsyncMock(return_value=None)
        agent._count_active_corp_tasks = MagicMock(return_value=0)
        agent._get_task_type = MagicMock(return_value="corp_ship")
        agent._build_task_start_context = MagicMock(return_value=None)
        agent._event_relay = None
        agent.watch_agent = AsyncMock()
        agent._ensure_heartbeat_task_running = MagicMock()

        # Don't actually POST.
        with patch.object(
            agent, "_post_wake_hook", new=AsyncMock()
        ) as mock_post:
            params = MagicMock()
            params.arguments = {
                "task_description": "haul ore to mp",
                "ship_id": "ship-uuid-123",
            }
            result = await agent._handle_start_task(params)
            # The wake POST is dispatched via asyncio.create_task; let the
            # loop give it a tick so the mock records the await.
            await asyncio.sleep(0)

        assert result["success"] is True
        assert result["status"] == "waking"
        assert result["task_id"]
        assert result["ship_character_id"] == "ship-uuid-123"

        # Watchdog registered, no in-process TaskAgent spawned.
        assert "ship-uuid-123" in agent._pending_wakes
        watchdog = agent._pending_wakes["ship-uuid-123"]
        assert isinstance(watchdog, asyncio.Task)
        watchdog.cancel()  # cleanup so the test doesn't leak

        # Pending-task entry keyed by the byoa_ name so on_agent_ready
        # drains it via the existing dispatch path.
        assert "byoa_ship-uuid-123" in agent._pending_tasks
        framework_task_id, payload = agent._pending_tasks["byoa_ship-uuid-123"]
        assert framework_task_id == result["task_id"]
        # Stale-task guard: framework task_id propagated into task_metadata
        # for the operator's agent to verify against ship.current_task_id.
        assert payload["task_metadata"]["task_id"] == framework_task_id

        # The bot listens for the remote agent's bus advertisement.
        agent.watch_agent.assert_awaited_once_with("byoa_ship-uuid-123")
        # Wake POST fired (with the expected payload).
        mock_post.assert_awaited_once()
        post_kwargs = mock_post.await_args.kwargs
        assert post_kwargs["task_id"] == framework_task_id
        assert post_kwargs["ship_id"] == "ship-uuid-123"

    async def test_no_wake_hook_falls_through_to_in_process_spawn(self):
        """A corp ship without a wake_hook spawns a local TaskAgent."""
        agent = _make_voice_agent()
        agent._byoa_config = MagicMock(agent_wake_timeout_seconds=30.0)

        agent._is_valid_uuid = MagicMock(return_value=True)
        agent._resolve_ship_id_prefix = AsyncMock(return_value=None)
        agent._is_corp_ship_id = AsyncMock(return_value=(True, "Corp Ship"))
        agent._lookup_byoa_wake_hook = AsyncMock(return_value=None)
        agent._acquire_server_ship_lock = AsyncMock(return_value=None)
        agent._count_active_corp_tasks = MagicMock(return_value=0)
        agent._get_task_type = MagicMock(return_value="corp_ship")
        agent._build_task_start_context = MagicMock(return_value=None)
        agent._event_relay = None
        agent.add_agent = AsyncMock()
        agent.watch_agent = AsyncMock()
        agent._ensure_heartbeat_task_running = MagicMock()

        params = MagicMock()
        params.arguments = {
            "task_description": "haul",
            "ship_id": "ship-uuid-123",
        }
        result = await agent._handle_start_task(params)

        assert result["success"] is True
        # No "status: waking" — the in-process path returns the same shape
        # as today.
        assert result.get("status") != "waking"
        # In-process TaskAgent was spawned (add_agent was awaited), no
        # pending wake registered.
        agent.add_agent.assert_awaited_once()
        assert agent._pending_wakes == {}
